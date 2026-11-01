'use strict';

// ─── txfileimport.js ──────────────────────────────────────────────────────────
// Multi-format transaction import — the UI half, drawn in Ant Design: one Modal
// that walks through Steps.
//
// All parsing (format sniffing, CSV/OFX/QIF/JSON/XLSX, date/amount
// normalisation, column detection, dup fingerprints) lives in txparse.js
// (window.TxParse, loaded before this file), which is pure and covered by
// the fixture-corpus regression suite in electron/backend/__tests__/
// txParse.test.js. This file holds everything with a DOM or network
// dependency.
//
// The steps:
//   1. Account  — which account the export is from: one of the user's, or a
//                 new one of a kind they name. Pre-picked from the account used
//                 last. Asked once; every later step uses it, the file's
//                 month-end balances included. Skipped when the caller already
//                 knows (first-run setup asks it in its own words)
//   2. File     — Upload.Dragger: drop a file or pick one. The format is found
//                 from the bytes, so a misnamed file still imports
//   3. Columns  — which column is which, shown for every format (a fixed schema
//                 such as OFX only arrives already right), with a preview of
//                 the first rows read through the mapping as it changes
//   4. Review   — "Here's what we found": new rows, rows already in the ledger,
//                 what the categorizer filled in and what still needs a
//                 category, the rows that could not be read, and every row
//                 with its category, which can be changed before anything is
//                 written. A duplicate is left out unless ticked
//
// The categories on the Review step come from a dry run of the import
// endpoint, so they are the ones the real import would give. A category the
// user changes there rides along with its row and is kept (and remembered for
// next time); the rest are filled in by the same passes again.
//
// Importing closes the wizard with a message. First-run setup passes
// onUploadMore / onFinish instead, and the wizard ends on a Done step offering
// both. The account question in first-run setup's own dialog is drawn by
// accountChoicesHtml / wireAccountChoices below.

(function () {
    const TxFileImport = (() => {

        const esc = escapeHtml;

        // The pure parsing core (txparse.js) — see the header comment.
        const { parseFile, detectColumns, applyMapping, deriveBalances, fingerprint } = TxParse;

        // Rows on one page of the Review table.
        const REVIEW_PAGE = 8;
        const PREVIEW_ROWS = 6;

        // ── API ───────────────────────────────────────────────────────────────────
        // The row shape the import endpoint accepts — shared by the dry run and
        // the real commit so both send identical data for identical rows. A
        // category is sent only for a row whose category the user changed.
        const toApiRow = ({ date, description, tx_type, amount, notes }) => ({ date, description, tx_type, amount, notes });

        async function postJson(url, body) {
            const r = await apiFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'request failed');
            return data;
        }

        async function fetchHashes(since) {
            const url = since ? `/api/transactions/hashes?since=${encodeURIComponent(since)}` : '/api/transactions/hashes';
            try {
                const r = await apiFetch(url);
                const data = await r.json().catch(() => ({}));
                return new Set(data.hashes || []);
            } catch {
                return new Set();  // dup detection is best-effort; don't block import
            }
        }

        async function fetchCategories() {
            try {
                const r = await apiFetch('/api/categories');
                return r.ok ? ((await r.json()).categories || []) : [];
            } catch {
                return [];
            }
        }

        // The accounts this import can land in. `include_hidden` is what makes the
        // pre-named starter accounts ("Checking", "Credit Card") selectable before
        // any have been adopted — the one that receives the import becomes visible
        // (the backend adopts it; see services/accounts.js).
        async function fetchBalanceColumns() {
            try {
                const r = await apiFetch('/api/balance/columns?include_hidden=true');
                if (!r.ok) return [];
                return await r.json().catch(() => []);
            } catch {
                return [];
            }
        }

        async function renameBalanceColumn(key, label) {
            const r = await apiFetch(`/api/balance/columns/${encodeURIComponent(key)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'could not name the account');
        }

        async function createBalanceColumn(label, type) {
            return (await postJson('/api/balance/columns', { label, type })).column; // { key, label, type }
        }

        // The account used by the last import, which pre-picks the account
        // question next time. Nothing about the file can identify an account: it
        // is a bucket the user defines, and someone who changes banks mid-year
        // still has one "Checking".
        const LAST_ACCT_KEY = 'balance-import-last-account';
        function lastUsedAccount() {
            try { return localStorage.getItem(LAST_ACCT_KEY) || null; } catch { return null; }
        }
        function rememberAccount(key) {
            try { localStorage.setItem(LAST_ACCT_KEY, key); } catch { /* a nicety, not required */ }
        }

        // The kinds of account a user can add: the four col_types. `kind` matches
        // the key of the seeded starter row the first account of its type takes
        // over (seed.js DEFAULT_BALANCE_COLUMNS); `type` is the col_type a new
        // column gets otherwise. The placeholders are generic examples of the
        // user's own names.
        const ACCOUNT_KINDS = [
            { kind: 'checking',    label: 'Cash',       type: 'cash',       placeholder: 'e.g. Joint Checking' },
            { kind: 'retirement',  label: 'Retirement', type: 'retirement', placeholder: 'e.g. Work 401(k)' },
            { kind: 'investments', label: 'Investment', type: 'investment', placeholder: 'e.g. Brokerage' },
            { kind: 'credit_card', label: 'Debt',       type: 'debt',       placeholder: 'e.g. Everyday Card' },
        ];
        const kindLabel = (type) => ACCOUNT_KINDS.find((k) => k.type === type)?.label || '';

        /**
         * Settle an account choice into { key, label }: an existing account as
         * it is, or a new one of `kind` named `label`. A new one first takes over
         * the matching unadopted STARTER row, renamed, which keeps its seeded key
         * for the common "first account of this kind" case; a second account of a
         * kind gets a column of its own. Either way it stays hidden until an
         * import lands in it, so backing out leaves nothing behind.
         */
        async function resolveAccount(accounts, choice) {
            if (choice.key) {
                const a = accounts.find((x) => x.key === choice.key);
                return { key: a.key, label: a.label };
            }
            const kind = ACCOUNT_KINDS.find((k) => k.kind === choice.kind);
            const starter = accounts.find((a) => a.key === kind.kind && a.hidden);
            if (starter) {
                await renameBalanceColumn(starter.key, choice.label);
                return { key: starter.key, label: choice.label };
            }
            const col = await createBalanceColumn(choice.label, kind.type);
            return { key: col.key, label: col.label };
        }

        // ── First-run setup's account question ────────────────────────────────────
        // Tiles in first-run setup's own dialog (onboarding.css): the user's
        // accounts, then the kinds a new one can be, a new one named before it
        // can be chosen. `onValidityChange(ok)` lets the caller gate its button.
        function accountChoicesHtml(accounts, { name = 'acct-choice', preselect = null } = {}) {
            const adopted = accounts.filter((a) => !a.hidden);
            const tile = (value, label, hint, checked) => `
                <label class="acct-tile">
                    <input type="radio" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}>
                    <span class="acct-tile-body">
                        <span class="acct-tile-name">${esc(label)}</span>
                        ${hint ? `<span class="acct-tile-hint">${esc(hint)}</span>` : ''}
                    </span>
                </label>`;
            return `
                ${adopted.length ? `
                <div class="acct-section-label">Your accounts</div>
                <div class="acct-tiles">
                    ${adopted.map((a) => tile(a.key, a.label, kindLabel(a.type), a.key === preselect)).join('')}
                </div>` : ''}
                <div class="acct-section-label">${adopted.length ? 'Add New Account' : 'Add your first account'}</div>
                <div class="acct-tiles">
                    ${ACCOUNT_KINDS.map((k) => tile(`new:${k.kind}`, k.label, '', false)).join('')}
                </div>
                <div class="acct-custom" hidden>
                    <label class="acct-custom-label" for="${esc(name)}-new-name">What do you call it?</label>
                    <input type="text" id="${esc(name)}-new-name" class="tx-input acct-custom-name" maxlength="100"
                        placeholder="Account name" aria-label="Name for the new account">
                </div>`;
        }

        function wireAccountChoices(root, accounts, { onValidityChange = () => {} } = {}) {
            const custom = root.querySelector('.acct-custom');
            const nameInput = root.querySelector('.acct-custom-name');
            const chosen = () => root.querySelector('input[type="radio"]:checked');
            const kindOf = (sel) => (sel && sel.value.startsWith('new:'))
                ? ACCOUNT_KINDS.find((k) => k.kind === sel.value.slice(4))
                : null;
            const refresh = () => {
                const sel = chosen();
                const kind = kindOf(sel);
                custom.hidden = !kind;
                if (kind) nameInput.placeholder = kind.placeholder;
                onValidityChange(!!sel && (!kind || !!nameInput.value.trim()));
            };
            root.querySelectorAll('input[type="radio"]').forEach((r) => {
                r.addEventListener('change', () => {
                    refresh();
                    if (kindOf(chosen())) nameInput.focus();
                });
            });
            nameInput.addEventListener('input', refresh);
            refresh();
            return {
                async resolve() {
                    const sel = chosen();
                    if (!sel) throw new Error('Please choose the account this import is for.');
                    const kind = kindOf(sel);
                    if (!kind) return resolveAccount(accounts, { key: sel.value });
                    const label = nameInput.value.trim();
                    if (!label) {
                        nameInput.focus();
                        throw new Error('Please give the new account a name.');
                    }
                    return resolveAccount(accounts, { kind: kind.kind, label });
                },
            };
        }

        // ── Small pieces ──────────────────────────────────────────────────────────
        const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
        const money = (n) => (typeof formatCurrency === 'function' ? formatCurrency(Math.abs(n)) : Math.abs(n).toFixed(2));
        const fmtDate = (iso) => (typeof formatDate === 'function' ? formatDate(iso) : iso);
        const flowAmount = (r) => `<span class="tx-amount tx-amount-${esc(r.tx_type)}">${r.tx_type === 'income' ? '+' : '-'} ${esc(money(r.amount))}</span>`;
        const selectHtml = (inner, attrs = '', small = false) =>
            `<span class="ant-select${small ? ' ant-select-sm' : ''}"><select class="ant-select-selector" ${attrs}>${inner}</select><span class="ant-select-arrow">${Ant.icon('down')}</span></span>`;
        const alertHtml = (type, iconName, title, desc = '') => `
            <div class="ant-alert ant-alert-${type}${desc ? ' ant-alert-with-description' : ''}" role="${type === 'error' ? 'alert' : 'status'}">
                <span class="ant-alert-icon">${Ant.icon(iconName)}</span>
                <div class="ant-alert-content"><div class="ant-alert-message">${esc(title)}</div>
                ${desc ? `<div class="ant-alert-description">${desc}</div>` : ''}</div>
            </div>`;

        /** The categories a row on its side of the ledger can take: income
         *  for money in, expense and transfer for money out. */
        function categoryOptions(categories, txType, selectedId) {
            const groups = txType === 'income' ? [['income', 'Income']] : [['expense', 'Expenses'], ['transfer', 'Transfers']];
            return groups.map(([type, title]) => {
                const cats = categories.filter((c) => c.cat_type === type && !c.locked).sort((a, b) => a.position - b.position);
                if (!cats.length) return '';
                return `<optgroup label="${title}">${cats.map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
            }).join('');
        }

        // ── The wizard ────────────────────────────────────────────────────────────
        // opts.account      — { key, label } already settled by the caller (first-
        //                     run setup), so the wizard starts at File
        // opts.onUploadMore — the Done step's "Import another account"
        // opts.onFinish     — the Done step's "Finish"
        // opts.onCancel     — called when the wizard is left before importing
        async function run(opts = {}) {
            const firstRun = !!(opts.onUploadMore || opts.onFinish);
            const stepTitles = opts.account ? ['File', 'Columns', 'Review'] : ['Account', 'File', 'Columns', 'Review'];
            const w = {
                step: opts.account ? 'File' : 'Account',
                accounts: [],
                categories: [],
                choice: null,          // { key } or { kind, label }
                account: opts.account || null,
                file: null,            // { name }
                table: null,           // TxParse.parseFile's result
                firstRowNum: 2,
                mapping: null,
                flip: false,
                review: null,          // see buildReview()
                busy: false,
                done: false,           // imported
                left: false,           // the Done step's choice was made
            };

            const { dialog, close } = Ant.modal({
                title: opts.account ? `Import into ${opts.account.label}` : 'Import transactions',
                width: 820,
                className: 'tx-import-modal',
                canClose: () => !w.busy,
                // Leaving before importing is backing out; leaving the Done
                // step by its × is the same as Finish.
                onClose: () => {
                    if (!w.done) opts.onCancel?.();
                    else if (firstRun && !w.left) opts.onFinish?.(w.result);
                },
                body: '<div class="tx-steps"></div><div class="tx-import-body"></div>',
                footer: '<div class="tx-modal-buttons"></div>',
            });
            let bodyEl = dialog.querySelector('.tx-import-body');
            const footEl = dialog.querySelector('.tx-modal-buttons');

            function setBusy(on, tip = '') {
                w.busy = on;
                if (on) {
                    bodyEl.innerHTML = Ant.spin(tip);
                    footEl.innerHTML = '';
                }
            }

            function footer(buttons) {
                footEl.innerHTML = buttons.map((b) => `<button type="button" class="ant-btn ${b.primary ? 'ant-btn-primary' : 'ant-btn-default'}"
                    data-act="${b.act}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('');
            }

            /** Each step draws into a body of its own, so the listeners one step
             *  puts on it leave with it. */
            function show(step, arg) {
                w.step = step;
                const i = stepTitles.indexOf(step);
                dialog.querySelector('.tx-steps').innerHTML = i >= 0 ? Ant.steps(stepTitles, i) : '';
                const fresh = document.createElement('div');
                fresh.className = 'tx-import-body';
                bodyEl.replaceWith(fresh);
                bodyEl = fresh;
                ({ Account: renderAccount, File: renderFile, Columns: renderColumns, Review: renderReview, Done: renderDone })[step](arg);
            }

            // ── Account ──
            function renderAccount() {
                const adopted = w.accounts.filter((a) => !a.hidden);
                const last = lastUsedAccount();
                // Pre-picked from the last import, or when there is only one
                // account; otherwise nothing is, since an account clicked
                // through by mistake is a wrong import to undo by hand. With no
                // accounts yet, a new one is the only choice.
                if (!w.choice) {
                    const pre = adopted.find((a) => a.key === last) || (adopted.length === 1 ? adopted[0] : null);
                    w.choice = pre ? { key: pre.key } : adopted.length ? null : { kind: 'checking', label: '' };
                }
                const isNew = !!w.choice && !w.choice.key;
                bodyEl.innerHTML = `
                    <div class="ant-typography-strong tx-import-question" id="tx-import-acct-q">Which account is this export from?</div>
                    <div class="tx-import-accounts" role="radiogroup" aria-labelledby="tx-import-acct-q">
                        ${adopted.map((a) => `<label class="ant-radio-wrapper"><input type="radio" class="ant-radio" name="tx-import-acct" value="${esc(a.key)}"${w.choice?.key === a.key ? ' checked' : ''}>
                            <span>${esc(a.label)} <span class="ant-typography-secondary">· ${esc(kindLabel(a.type))}</span></span></label>`).join('')}
                        <label class="ant-radio-wrapper"><input type="radio" class="ant-radio" name="tx-import-acct" value="__new"${isNew ? ' checked' : ''}><span>A new account</span></label>
                    </div>
                    <div class="ant-card ant-card-small tx-import-new"${isNew ? '' : ' hidden'}><div class="ant-card-body">
                        <label class="ant-form-item"><span class="ant-form-item-label">Kind</span>
                            ${selectHtml(ACCOUNT_KINDS.map((k) => `<option value="${k.kind}"${w.choice?.kind === k.kind ? ' selected' : ''}>${k.label}</option>`).join(''), 'data-new="kind"')}</label>
                        <label class="ant-form-item tx-import-new-name"><span class="ant-form-item-label">Name</span>
                            <input type="text" class="ant-input" data-new="name" maxlength="100" value="${esc(w.choice?.label || '')}"
                                placeholder="${esc(ACCOUNT_KINDS.find((k) => k.kind === (w.choice?.kind || 'checking')).placeholder)}"></label>
                    </div></div>`;
                footer([{ act: 'cancel', label: 'Cancel' }, { act: 'next', label: 'Next', primary: true }]);

                const card = bodyEl.querySelector('.tx-import-new');
                const kindSel = bodyEl.querySelector('[data-new="kind"]');
                const nameIn = bodyEl.querySelector('[data-new="name"]');
                const sync = () => {
                    const v = bodyEl.querySelector('input[name="tx-import-acct"]:checked')?.value;
                    w.choice = !v ? null : v !== '__new' ? { key: v } : { kind: kindSel.value, label: nameIn.value.trim() };
                    card.hidden = !w.choice || !!w.choice.key;
                    nameIn.placeholder = ACCOUNT_KINDS.find((k) => k.kind === kindSel.value).placeholder;
                    footEl.querySelector('[data-act="next"]').disabled = !w.choice || (!w.choice.key && !w.choice.label);
                };
                bodyEl.addEventListener('change', (e) => {
                    sync();
                    if (e.target.value === '__new') nameIn.focus();
                });
                nameIn.addEventListener('input', sync);
                sync();
                (bodyEl.querySelector('input[name="tx-import-acct"]:checked')
                    || (isNew ? nameIn : bodyEl.querySelector('input[name="tx-import-acct"]'))).focus();
            }

            // ── File ──
            function renderFile(error = '') {
                bodyEl.innerHTML = `
                    ${error ? alertHtml('error', 'close-circle', error) : ''}
                    <button type="button" class="ant-upload-drag">
                        <span class="ant-upload-drag-icon">${Ant.icon('inbox')}</span>
                        <span class="ant-upload-text">Drop a bank export here, or click to choose one</span>
                        <span class="ant-upload-hint">CSV, TSV, TXT, OFX, QFX, QIF, JSON or Excel. The file is read on this computer and never uploaded.</span>
                    </button>
                    <input type="file" hidden accept=".csv,.tsv,.txt,.ofx,.qfx,.qif,.json,.xlsx,text/csv,application/json">`;
                footer([
                    ...(opts.account ? [] : [{ act: 'back', label: 'Back' }]),
                    { act: 'cancel', label: 'Cancel' },
                ]);
                const zone = bodyEl.querySelector('.ant-upload-drag');
                const input = bodyEl.querySelector('input[type="file"]');
                zone.addEventListener('click', () => input.click());
                input.addEventListener('change', () => { if (input.files?.[0]) readFile(input.files[0]); });
                zone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    zone.classList.add('ant-upload-drag-hover');
                });
                zone.addEventListener('dragleave', () => zone.classList.remove('ant-upload-drag-hover'));
                zone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    zone.classList.remove('ant-upload-drag-hover');
                    const file = e.dataTransfer?.files?.[0];
                    if (file) readFile(file);
                });
                zone.focus();
            }

            async function readFile(file) {
                // Parsing a big file (xlsx inflate, format sniffing) runs here in
                // the renderer, so the spinner gets a frame to paint first.
                setBusy(true, 'Reading file…');
                await nextPaint();
                let table = null;
                let error = '';
                try {
                    const buf = await file.arrayBuffer();
                    if (!buf.byteLength) throw new Error('the file is empty');
                    table = await parseFile(file.name, buf);
                    if (!table.headers.length || !table.rows.length) error = `${file.name} has no rows in it.`;
                } catch (err) {
                    error = `${file.name} could not be read: ${err.message}`;
                }
                setBusy(false);
                if (error) { show('File', error); return; }
                w.file = { name: file.name };
                w.table = table;
                w.firstRowNum = table.fixed ? 1 : 2;
                w.mapping = table.fixed
                    ? { date: 0, description: 1, amount: 2, debit: null, credit: null, notes: 3, balance: null }
                    : detectColumns(table.headers, table.rows);
                w.flip = false;
                show('Columns');
            }

            // ── Columns ──
            // Split mode (money out and money in in two columns) is a fact about
            // the file, found once from its headers, so it is not a choice here;
            // each column guess still is.
            /** The mapping as applyMapping takes it, or an error to show. */
            function mappingFor() {
                const m = w.mapping;
                if (m.date == null) return { error: 'Choose the Date column.' };
                if (m.description == null) return { error: 'Choose the Description column.' };
                if (m.split) {
                    if (m.debit == null && m.credit == null) return { error: 'Choose the Money out or Money in column.' };
                    if (m.debit != null && m.debit === m.credit) return { error: 'Money out and Money in have to be different columns.' };
                    return { mapping: { date: m.date, description: m.description, amount: null, debit: m.debit, credit: m.credit, notes: m.notes, balance: m.balance } };
                }
                if (m.amount == null) return { error: 'Choose the Amount column.' };
                return { mapping: { date: m.date, description: m.description, amount: m.amount, debit: null, credit: null, notes: m.notes, balance: m.balance } };
            }

            /** Rows read through the mapping, the sign flipped when asked. */
            function readRows(rows, startNum) {
                const { mapping } = mappingFor();
                if (!mapping) return { parsed: [], errors: [] };
                let out;
                try { out = applyMapping(rows, mapping, startNum); } catch { return { parsed: [], errors: [] }; }
                if (w.flip && !w.mapping.split) {
                    out.parsed.forEach((r) => { r.tx_type = r.tx_type === 'income' ? 'expense' : 'income'; });
                }
                return out;
            }

            function renderColumns() {
                const m = w.mapping;
                if (m.split === undefined) m.split = m.debit !== null && m.credit !== null;
                const headers = w.table.headers;
                const options = (field, required) => (required ? '' : '<option value="">— skip —</option>')
                    + headers.map((h, i) => `<option value="${i}"${m[field] === i ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('');
                // A required field shows some column, so it holds one.
                ['date', 'description'].concat(m.split ? [] : ['amount']).forEach((f) => { if (m[f] == null) m[f] = 0; });
                const field = (label, f, required) => `<label class="ant-form-item"><span class="ant-form-item-label">${label}</span>
                    ${selectHtml(options(f, required), `data-map="${f}"`)}</label>`;
                bodyEl.innerHTML = `
                    ${alertHtml('success', 'check-circle', `${w.file.name}: ${plural(w.table.rows.length, 'row')}`, 'Check which column holds what. The preview below updates as you change them.')}
                    <div class="tx-import-map">
                        ${field('Date', 'date', true)}
                        ${field('Description', 'description', true)}
                        ${m.split ? field('Money out', 'debit', false) + field('Money in', 'credit', false) : field('Amount', 'amount', true)}
                        ${field('Notes', 'notes', false)}
                        ${field('Balance', 'balance', false)}
                    </div>
                    ${m.split ? '' : `<label class="ant-checkbox-wrapper"><input type="checkbox" class="ant-checkbox" data-flip${w.flip ? ' checked' : ''}>This bank writes money out as a positive number</label>`}
                    <div class="ant-table-wrapper tx-import-preview"></div>
                    <div class="ant-form-item-explain tx-import-map-error" role="alert"></div>`;
                footer([{ act: 'back', label: 'Back' }, { act: 'cancel', label: 'Cancel' }, { act: 'continue', label: 'Continue', primary: true }]);
                bodyEl.addEventListener('change', (e) => {
                    if (e.target.matches('[data-map]')) m[e.target.dataset.map] = e.target.value === '' ? null : Number(e.target.value);
                    if (e.target.matches('[data-flip]')) w.flip = e.target.checked;
                    renderPreview();
                });
                renderPreview();
                bodyEl.querySelector('[data-map]').focus();
            }

            // The first rows of the file, read through the mapping on screen.
            function renderPreview() {
                const { error } = mappingFor();
                bodyEl.querySelector('.tx-import-map-error').textContent = error || '';
                footEl.querySelector('[data-act="continue"]').disabled = !!error;
                const rows = readRows(w.table.rows.slice(0, 20), w.firstRowNum).parsed.slice(0, PREVIEW_ROWS);
                bodyEl.querySelector('.tx-import-preview').innerHTML = rows.length ? `
                    <table class="ant-table ant-table-small ant-table-fixed">
                        <thead><tr><th class="tx-p-date">Date</th><th>Description</th><th class="tx-p-notes">Notes</th><th class="tx-p-amt ant-table-cell-end">Amount</th></tr></thead>
                        <tbody>${rows.map((r) => `<tr><td class="tx-num">${esc(fmtDate(r.date))}</td>
                            <td class="ant-table-cell-ellipsis" title="${esc(r.description)}">${esc(r.description)}</td>
                            <td class="ant-table-cell-ellipsis ant-typography-secondary">${esc(r.notes || '')}</td>
                            <td class="ant-table-cell-end">${flowAmount(r)}</td></tr>`).join('')}</tbody>
                    </table>` : Ant.empty({ title: 'Nothing reads with these columns', desc: 'Pick the columns that hold the date, the description and the amount.', compact: true });
            }

            async function toReview() {
                setBusy(true, 'Preparing your import…');
                await nextPaint();
                const { parsed, errors } = readRows(w.table.rows, w.firstRowNum);
                if (!parsed.length) {
                    setBusy(false);
                    show('Columns');
                    bodyEl.querySelector('.tx-import-map-error').textContent =
                        `No row could be read with these columns${errors[0] ? ` (row ${errors[0].row}: ${errors[0].reason})` : ''}.`;
                    return;
                }
                const minDate = parsed.reduce((min, r) => (r.date < min ? r.date : min), parsed[0].date);
                const [dupes, dry, categories] = await Promise.all([
                    fetchHashes(minDate),
                    postJson('/api/transactions/import', { rows: parsed.map(toApiRow), dry_run: true }).catch(() => null),
                    w.categories.length ? w.categories : fetchCategories(),
                ]);
                w.categories = categories;
                const suggested = new Map((dry?.rows || []).map((x) => [x.row, x]));
                w.review = {
                    errors,
                    balances: deriveBalances(parsed, w.table.ledgerBalance),
                    rows: parsed.map((r, i) => ({
                        ...r,
                        key: i,
                        dupe: dupes.has(fingerprint(r)),
                        suggested: suggested.get(i)?.category_id ?? null,
                        how: suggested.get(i)?.how ?? null,
                        display: suggested.get(i)?.display_name || null,
                    })),
                    keep: new Set(),       // duplicates ticked to import anyway
                    chosen: new Map(),     // key → category id (or null), where the user changed it
                    page: 1,
                };
                setBusy(false);
                show('Review');
            }

            // ── Review ──
            const catOf = (r) => (w.review.chosen.has(r.key) ? w.review.chosen.get(r.key) : r.suggested);
            const included = (r) => !r.dupe || w.review.keep.has(r.key);

            function renderReview() {
                const rv = w.review;
                const lines = (b) => {
                    const raw = w.table.rows[b.row - w.firstRowNum];
                    const text = Array.isArray(raw) ? raw.join(', ') : '';
                    return `<li>Row ${b.row} ${esc(b.reason)}${text ? `: <code class="ant-typography-code">${esc(text.slice(0, 60) || '(empty)')}</code>` : ''}</li>`;
                };
                bodyEl.innerHTML = `
                    <h3 class="tx-import-title">Here’s what we found</h3>
                    <div class="tx-import-stats"></div>
                    ${rv.errors.length ? alertHtml('error', 'close-circle', `${plural(rv.errors.length, 'row')} could not be read and will be skipped`,
                        `<ul class="tx-review-list">${rv.errors.slice(0, 4).map(lines).join('')}${rv.errors.length > 4 ? '<li>…</li>' : ''}</ul>`) : ''}
                    ${rv.balances.length ? `<div class="ant-typography-secondary tx-import-balances">The file’s ${plural(rv.balances.length, 'month-end balance')} also go${rv.balances.length === 1 ? 'es' : ''} to this account on the Balance Sheet.</div>` : ''}
                    <div class="ant-table-wrapper tx-import-table"></div>
                    <ul class="tx-import-pages" aria-label="Pages of rows"></ul>`;
                footer([{ act: 'back', label: 'Back' }, { act: 'cancel', label: 'Cancel' }, { act: 'import', label: 'Import', primary: true }]);
                const pager = Ant.pagination(bodyEl.querySelector('.tx-import-pages'), {
                    current: rv.page, pageSize: REVIEW_PAGE, total: rv.rows.length, pageSizeOptions: [],
                    onChange: (current) => { rv.page = current; renderRows(); },
                });
                bodyEl.querySelector('.tx-import-pages').hidden = rv.rows.length <= REVIEW_PAGE;
                pager.update({ current: rv.page });
                bodyEl.addEventListener('change', (e) => {
                    const tr = e.target.closest('tr[data-key]');
                    if (!tr) return;
                    const r = rv.rows[Number(tr.dataset.key)];
                    if (e.target.matches('[data-keep]')) {
                        if (e.target.checked) rv.keep.add(r.key);
                        else rv.keep.delete(r.key);
                        renderRows();
                    } else if (e.target.matches('[data-cat]')) {
                        const id = e.target.value ? Number(e.target.value) : null;
                        if (id === r.suggested) rv.chosen.delete(r.key);
                        else rv.chosen.set(r.key, id);
                        renderRows();
                        // The row was redrawn; the focus goes to its new Select.
                        bodyEl.querySelector(`tr[data-key="${r.key}"] [data-cat]`)?.focus();
                    }
                });
                renderRows();
                footEl.querySelector('[data-act="import"]').focus();
            }

            function renderRows() {
                const rv = w.review;
                const fresh = rv.rows.filter(included);
                const filled = fresh.filter((r) => catOf(r) != null).length;
                const stat = (title, value, suffix = '') => `<div class="ant-card ant-card-small"><div class="ant-card-body">
                    <div class="ant-statistic-title">${title}</div><div class="ant-statistic-content">${value.toLocaleString()}${suffix ? `<span class="tx-import-stat-suffix">${suffix}</span>` : ''}</div></div></div>`;
                bodyEl.querySelector('.tx-import-stats').innerHTML = stat('New transactions', fresh.length)
                    + stat('Already in the ledger', rv.rows.filter((r) => r.dupe).length)
                    + stat('Categorized for you', filled, ` / ${fresh.length.toLocaleString()}`)
                    + stat('Need a category', fresh.length - filled);

                const start = (rv.page - 1) * REVIEW_PAGE;
                const page = rv.rows.slice(start, start + REVIEW_PAGE);
                const tip = (how) => (how === 'rule' ? 'From a category you gave this description before' : 'Recognized from the description');
                bodyEl.querySelector('.tx-import-table').innerHTML = `
                    <table class="ant-table ant-table-small ant-table-fixed">
                        <thead><tr><th class="tx-p-date">Date</th><th>Description</th><th class="tx-p-catsel">Category</th><th class="tx-p-amt ant-table-cell-end">Amount</th></tr></thead>
                        <tbody>${page.map((r) => {
                            const on = included(r);
                            const cat = catOf(r);
                            const auto = r.how && r.how !== 'chosen' && !rv.chosen.has(r.key) && cat != null;
                            return `<tr data-key="${r.key}" class="${on ? '' : 'tx-import-muted'}">
                                <td class="tx-num">${esc(fmtDate(r.date))}</td>
                                <td><div class="tx-import-desc"><span class="tx-desc-name" title="${esc(r.description)}">${esc(r.display || r.description)}</span>
                                    ${r.dupe ? `<label class="ant-checkbox-wrapper tx-import-dupe" data-tip="This exact transaction is already in the ledger. Tick it to import it anyway.">
                                        <input type="checkbox" class="ant-checkbox" data-keep${on ? ' checked' : ''} aria-label="Import ${esc(r.description)} anyway"><span class="ant-tag">Duplicate</span></label>` : ''}</div></td>
                                <td><div class="tx-import-cat">${selectHtml(`<option value="">Uncategorized</option>${categoryOptions(w.categories, r.tx_type, cat)}`,
                                    `data-cat aria-label="Category of ${esc(r.description)}"${on ? '' : ' disabled'}`, true)}
                                    ${auto ? `<span class="tx-import-auto" tabindex="0" data-tip="${tip(r.how)}" aria-label="${tip(r.how)}">${Ant.icon('thunderbolt')}</span>` : ''}</div></td>
                                <td class="ant-table-cell-end">${flowAmount(r)}</td></tr>`;
                        }).join('')}</tbody>
                    </table>`;
                const n = fresh.length;
                const btn = footEl.querySelector('[data-act="import"]');
                btn.textContent = `Import ${plural(n, 'transaction')}`;
                btn.disabled = n === 0;
            }

            async function commit() {
                const rv = w.review;
                const toSend = rv.rows.filter(included).map((r) => {
                    const row = toApiRow(r);
                    if (rv.chosen.has(r.key)) row.category_id = rv.chosen.get(r.key);
                    return row;
                });
                setBusy(true, `Importing ${plural(toSend.length, 'transaction')}…`);
                let result;
                try {
                    if (!w.account) w.account = await resolveAccount(w.accounts, w.choice);
                    rememberAccount(w.account.key);
                    // Month-end balances from the file go to the same account,
                    // as ordinary Balance Sheet cells that can be edited after.
                    const balances = rv.balances.map((b) => ({ account_key: w.account.key, date: b.date, value: b.value, source: b.source }));
                    const body = { rows: toSend, account_key: w.account.key };
                    if (balances.length) body.balances = balances;
                    result = await postJson('/api/transactions/import', body);
                } catch (err) {
                    setBusy(false);
                    show('Review');
                    Ant.message.error(`The import failed: ${err.message}`);
                    return;
                }
                setBusy(false);
                w.done = true;
                // Imported rows change the Cash Flow cells the Dashboard draws from
                // the Store cache; balances and an adopted account change the
                // Balance Sheet's.
                if (window.Store) {
                    window.Store.invalidate('ie');
                    if (result.balances_applied || result.account_adopted) window.Store.invalidate('balance');
                }
                window.dispatchEvent(new Event('transactions:reload'));
                w.result = result;
                w.summary = `${plural(result.inserted, 'transaction')} imported. ${result.auto_categorized.toLocaleString()} categorized automatically.`;
                if (firstRun) {
                    show('Done');
                } else {
                    close();
                    Ant.message.success(w.summary);
                }
            }

            // ── Done (first-run setup) ──
            function renderDone() {
                dialog.querySelector('.tx-steps').innerHTML = '';
                bodyEl.innerHTML = `<div class="tx-import-done">
                    <span class="tx-import-done-icon">${Ant.icon('check-circle')}</span>
                    <div class="tx-import-done-title">${esc(w.account.label)} is set up</div>
                    <div class="ant-typography-secondary">${esc(w.summary)}</div></div>`;
                footer([{ act: 'more', label: 'Import another account' }, { act: 'finish', label: 'Finish', primary: true }]);
                footEl.querySelector('[data-act="finish"]').focus();
            }

            footEl.addEventListener('click', (e) => {
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (!act || w.busy) return;
                if (act === 'cancel') close();
                if (act === 'next') show('File');
                if (act === 'back') show({ File: 'Account', Columns: 'File', Review: 'Columns' }[w.step]);
                if (act === 'continue') toReview();
                if (act === 'import') commit();
                if (act === 'more' || act === 'finish') {
                    w.left = true;
                    close();
                    if (act === 'more') opts.onUploadMore?.(w.result);
                    else opts.onFinish?.(w.result);
                }
            });

            if (!opts.account) {
                setBusy(true);
                w.accounts = await fetchBalanceColumns();
                setBusy(false);
            }
            show(w.step);
        }

        return { run, accountChoicesHtml, wireAccountChoices };
    })();

    window.TxFileImport = TxFileImport;
}());
