'use strict';

// ============================================================================
// stmtmanagers.js — the Statements page's two managers, in Ant Design.
// ============================================================================
//
// The modals behind the Statements toolbar's Manage Years and Manage Columns
// buttons (statements.js opens them). Both act through the two statement
// controllers that bootstrapYearTablePage returned (widgets/tables.js), and
// reload the tables behind the modal as each change lands.
//
//   Manage Years — a statement year spans both statements, so adding,
//     renumbering and removing act on every dataset that holds the year.
//     A year with transactions is locked: its cells are computed from them,
//     so renumbering would move the label and nothing else, and removing it
//     would drop a table the ledger fills again the moment it is re-added.
//     There is no rename endpoint; renumbering is duplicate-then-delete.
//
//   Manage Columns — two tabs.
//     Categories: the Cash Flow's columns, one card per type. These are the
//       app's categories (/api/categories), the same list the Transactions
//       ledger offers. A category still used by transactions cannot be
//       deleted (the backend refuses); the two Uncategorized buckets cannot
//       be renamed or deleted, because uncategorized rows are summed there.
//     Balance Sheet accounts: one row per account, its type a Select.
//       Removing one that holds balances erases them, and says so first.
//   Moving a column up or down swaps it with its neighbour of the same type;
//   both backends refuse a swap across types.
//
// Each list is re-rendered whole after a change; it is short, and that keeps
// the row wiring in one delegated handler per panel.
//
// Globals used: Ant, apiFetch, escapeHtml, Store.

(function () {
    const sendJson = (url, method, body) => apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    /** The response body, or {} when it is not JSON. */
    const bodyOf = (res) => res.json().catch(() => ({}));

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    // ─── Shared row pieces ──────────────────────────────────────────────────

    const iconButton = ({ act, icon, label, tip, disabled = false, danger = false }) =>
        `<button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only${danger ? ' ant-btn-dangerous' : ''}"
            data-act="${act}" aria-label="${escapeHtml(label)}"${tip ? ` data-tip="${escapeHtml(tip)}"` : ''}
            ${disabled ? 'disabled' : ''}>${Ant.icon(icon)}</button>`;

    /** List.Item's actions, with Ant's hairline between them. */
    const actions = (items) => `<ul class="ant-list-item-action">${items
        .map((html, i) => `<li>${html}${i < items.length - 1 ? '<em class="ant-list-item-action-split"></em>' : ''}</li>`)
        .join('')}</ul>`;

    const pencil = (label) => `<button type="button" class="ant-typography-edit" data-act="rename"
        aria-label="${escapeHtml(label)}" data-tip="${escapeHtml(label)}">${Ant.icon('edit')}</button>`;

    const moveButtons = (name, canUp, canDown) => [
        iconButton({ act: 'up', icon: 'arrow-up', label: `Move ${name} up`, tip: canUp ? 'Move up' : '', disabled: !canUp }),
        iconButton({ act: 'down', icon: 'arrow-down', label: `Move ${name} down`, tip: canDown ? 'Move down' : '', disabled: !canDown }),
    ];

    /**
     * Ant's editable text: the row's name becomes a field in place. Enter or
     * leaving the field calls done(value); Escape calls done(null). The caller
     * saves and re-renders, which replaces the field.
     */
    function editInPlace(slot, { value, label, maxLength, numeric = false, done }) {
        slot.innerHTML = `<input class="ant-input stmt-edit-input" type="${numeric ? 'number' : 'text'}"
            ${numeric ? 'min="1000" max="9999"' : `maxlength="${maxLength}"`} aria-label="${escapeHtml(label)}">`;
        const input = slot.querySelector('input');
        input.value = value;
        input.focus();
        input.select();
        let finished = false;
        const finish = (next) => {
            if (finished) return;
            finished = true;
            done(next);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
            // Escape cancels the edit, not the modal around it.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        });
        input.addEventListener('blur', () => finish(input.value.trim()));
    }

    /** After a full re-render, put focus back on the control it was on. */
    function refocus(root, selector) {
        root.querySelector(selector)?.focus();
    }

    // ─── Manage Years ───────────────────────────────────────────────────────

    const LOCK_TIP = 'Has transactions, so it can’t be renumbered or removed';

    /** Ledger rows per calendar year: { '2024': 132 }. Years with none are absent. */
    async function loadTxYears() {
        const res = await apiFetch('/api/transactions/years');
        if (!res.ok) throw new Error(`transaction years: ${res.status}`);
        return (await res.json()).years || {};
    }

    const validYear = (y) => Number.isInteger(y) && y >= 1000 && y <= 9999;

    /**
     * sheets: the two statement controllers. A year's operations run on each
     * sheet that holds it, so a year only one statement has (an import
     * creates Cash Flow years alone) is still renumbered or removed in full.
     */
    function openYears({ sheets }) {
        const unionYears = () => [...new Set(sheets.flatMap((s) => s.years()))].sort((a, b) => a - b);
        const withYear = async (year, fn) => {
            for (const sheet of sheets.filter((s) => s.hasYear(year))) await fn(sheet);
        };
        const reloadAll = () => Promise.all(sheets.map((s) => s.reload()));

        /** The year the add field offers: the one after the newest, or this
         *  year when there are none, skipping any already taken. */
        const nextFreeYear = () => {
            const taken = unionYears();
            let year = taken.length ? taken[taken.length - 1] + 1 : new Date().getFullYear();
            while (year <= 9999 && taken.includes(year)) year++;
            return year <= 9999 ? year : '';
        };

        const { dialog, close } = Ant.modal({
            title: 'Manage Years',
            width: 480,
            className: 'stmt-years-modal',
            body: `
                <p class="stmt-modal-note">Each year is a Cash Flow table and a Balance Sheet table. A year
                    with transactions is locked, because its cells are computed from them. Removing a year
                    erases what was typed into its tables; transactions are never touched.</p>
                <ul class="ant-list ant-list-bordered ant-list-sm stmt-year-list" aria-label="Statement years">
                    <li class="ant-list-item ant-typography-secondary">Loading…</li>
                </ul>
                <div class="ant-space-compact stmt-year-add">
                    <input class="ant-input" type="number" min="1000" max="9999" id="stmt-add-year"
                        aria-label="Year to add">
                    <button type="button" class="ant-btn ant-btn-default" data-act="add" disabled>${Ant.icon('plus')}<span>Add year</span></button>
                </div>`,
            footer: '<button type="button" class="ant-btn ant-btn-primary" data-act="done">Done</button>',
        });
        const list = dialog.querySelector('.stmt-year-list');
        const yearInput = dialog.querySelector('#stmt-add-year');
        const addBtn = dialog.querySelector('[data-act="add"]');
        let txYears = {};

        const canAdd = () => {
            const y = Number(yearInput.value);
            return validYear(y) && !unionYears().includes(y);
        };
        const syncAdd = () => { addBtn.disabled = !canAdd(); };

        const rowHtml = (year) => {
            const count = txYears[String(year)] || 0;
            const counted = `<span class="ant-typography-secondary">${count ? plural(count, 'transaction') : 'No transactions'}</span>`;
            const action = count
                ? `<span class="stmt-lock" role="img" aria-label="${year}: ${LOCK_TIP}"
                    data-tip="${LOCK_TIP}">${Ant.icon('lock')}</span>`
                : `<button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-dangerous"
                    data-act="remove" aria-label="Remove ${year}">Remove</button>`;
            return `<li class="ant-list-item" data-year="${year}">
                <div class="stmt-item-main">
                    <span class="stmt-item-name stmt-year-value" data-slot>${year}</span>
                    ${count ? '' : pencil(`Change ${year}`)}
                    ${counted}
                </div>
                ${actions([action])}
            </li>`;
        };

        const render = () => {
            const years = unionYears().reverse();
            list.innerHTML = years.length
                ? years.map(rowHtml).join('')
                : '<li class="ant-list-item ant-typography-secondary">No years yet</li>';
            syncAdd();
        };

        // Re-read the ledger counts, then rebuild. Without the counts the list
        // cannot say which years are locked, and offering a renumber the data
        // forbids is worse than no list, so a failure closes the modal.
        const refresh = async () => {
            try {
                txYears = await loadTxYears();
            } catch (err) {
                console.error('[statements] reading transaction years failed:', err);
                Ant.message.error("Couldn't read your years. Nothing has changed.");
                close();
                return;
            }
            render();
        };

        async function addYear() {
            if (!canAdd() || Ant.isLoading(addBtn)) return;
            const year = Number(yearInput.value);
            await Ant.whileLoading(addBtn, async () => {
                for (const sheet of sheets) {
                    if (!sheet.hasYear(year)) await sheet.addYear(year);
                }
            });
            yearInput.value = nextFreeYear();
            await refresh();
            yearInput.focus();
        }

        async function renumber(from, to) {
            if (!validYear(to)) {
                Ant.message.error('Enter a year from 1000 to 9999.');
                return;
            }
            if (unionYears().includes(to)) {
                Ant.message.error(`${to} is already on the statement.`);
                return;
            }
            await withYear(from, async (sheet) => {
                const copied = await sheet.api.duplicateYear(from, to);
                if (copied.ok !== false) await sheet.api.deleteYear(from);
            });
            await reloadAll().catch((err) => console.error('[statements] reload failed:', err));
        }

        async function remove(btn, year) {
            const ok = await Ant.popconfirm(btn, {
                title: `Remove ${year}?`,
                desc: 'What was typed into its Cash Flow and Balance Sheet is erased. Transactions are never touched.',
                okText: 'Remove',
                danger: true,
            });
            if (!ok) return;
            await withYear(year, (sheet) => sheet.api.deleteYear(year));
            await reloadAll().catch((err) => console.error('[statements] reload failed:', err));
            await refresh();
            yearInput.value = nextFreeYear();
            syncAdd();
        }

        dialog.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const year = Number(btn.closest('[data-year]')?.dataset.year);
            if (btn.dataset.act === 'done') close();
            else if (btn.dataset.act === 'add') addYear();
            else if (btn.dataset.act === 'remove') remove(btn, year);
            else if (btn.dataset.act === 'rename') {
                editInPlace(btn.closest('li').querySelector('[data-slot]'), {
                    value: year,
                    label: `Change ${year} to`,
                    numeric: true,
                    done: async (next) => {
                        const to = Number(next);
                        if (next && to !== year) await renumber(year, to);
                        await refresh();
                        refocus(list, `[data-year="${unionYears().includes(to) ? to : year}"] [data-act="rename"]`);
                    },
                });
            }
        });
        yearInput.addEventListener('input', syncAdd);
        yearInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addYear(); }
        });

        yearInput.value = nextFreeYear();
        refresh();
        yearInput.focus();
    }

    // ─── Manage Columns: Categories ─────────────────────────────────────────

    const CATEGORY_GROUPS = [
        { type: 'income', title: 'Income', noun: 'income' },
        { type: 'expense', title: 'Expenses', noun: 'expense' },
        { type: 'transfer', title: 'Transfers', noun: 'transfer' },
    ];
    const MAX_CATEGORY_NAME = 18;   // handlers/categories.js MAX_CATEGORY_NAME_LEN
    const REQUIRED_TIP = 'Uncategorized transactions are summed here, so it can’t be renamed or removed';

    /** What a refused category write should tell the user. */
    function categoryError(body, name) {
        if (body.error === 'category already exists') return `There's already a category called “${name}”.`;
        if (/too long/.test(body.error || '')) return `Category names can be up to ${MAX_CATEGORY_NAME} characters.`;
        if (body.error === 'has_data') {
            const held = [];
            if (body.transactions) held.push(plural(body.transactions, 'transaction'));
            if (body.entries) held.push(plural(body.entries, 'typed Cash Flow value'));
            return `${name} is still used by ${held.join(' and ')}. Recategorize or clear those first.`;
        }
        return "Couldn't save the change — try again.";
    }

    /** onChange runs after every saved change, to reload the Cash Flow. */
    function mountCategories(panel, { onChange }) {
        let cats = [];

        const rowHtml = (c, i, group) => {
            const count = c.transactions || 0;
            const countHtml = count
                ? `<span class="ant-typography-secondary stmt-item-count" data-tip="${plural(count, 'transaction')}">${count}<span
                    class="ant-visually-hidden"> transactions</span></span>` : '';
            let last;
            if (c.locked) {
                last = `<span class="ant-tag" tabindex="0" role="note" aria-label="Required: ${REQUIRED_TIP}"
                    data-tip="${REQUIRED_TIP}">Required</span>`;
            } else if (count) {
                // A disabled button takes no pointer events, so the reason's
                // tooltip sits on a wrapper (as Ant's Tooltip does around one);
                // the button's name carries it for a screen reader.
                const reason = `${plural(count, 'transaction')} use it. Recategorize them first.`;
                last = `<span class="stmt-tip-wrap" data-tip="${reason}">${iconButton({
                    act: 'delete', icon: 'delete', label: `Can't delete ${c.name}: ${reason}`, disabled: true, danger: true,
                })}</span>`;
            } else {
                last = iconButton({ act: 'delete', icon: 'delete', label: `Delete ${c.name}`, danger: true });
            }
            return `<li class="ant-list-item" data-id="${c.id}">
                <div class="stmt-item-main">
                    <span class="stmt-item-name" data-slot>${escapeHtml(c.name)}</span>
                    ${c.locked ? '' : pencil(`Rename ${c.name}`)}
                    ${countHtml}
                </div>
                ${actions([...moveButtons(c.name, i > 0, i < group.length - 1), last])}
            </li>`;
        };

        const cardHtml = (g) => {
            const group = cats.filter((c) => c.cat_type === g.type);
            const placeholder = `New ${g.noun} category`;
            return `<section class="ant-card ant-card-small stmt-cat-card" data-type="${g.type}" aria-labelledby="stmt-cat-${g.type}">
                <div class="ant-card-head"><div class="ant-card-head-wrapper">
                    <h3 class="ant-card-head-title" id="stmt-cat-${g.type}">${g.title}</h3>
                </div></div>
                <div class="ant-card-body">
                    <ul class="ant-list ant-list-sm">${group.map((c, i) => rowHtml(c, i, group)).join('')}</ul>
                    <div class="ant-space-compact ant-space-compact-block stmt-add-row">
                        <input class="ant-input" data-new="${g.type}" maxlength="${MAX_CATEGORY_NAME}"
                            placeholder="${placeholder}" aria-label="${placeholder}">
                        <button type="button" class="ant-btn ant-btn-default" data-act="add" data-type="${g.type}" disabled>${Ant.icon('plus')}<span>Add</span></button>
                    </div>
                </div>
            </section>`;
        };

        const render = () => {
            panel.innerHTML = `<div class="stmt-cat-cards">${CATEGORY_GROUPS.map(cardHtml).join('')}</div>`;
        };

        async function refresh() {
            const res = await apiFetch('/api/categories?counts=true');
            if (!res.ok) throw new Error(`categories: ${res.status}`);
            cats = (await res.json()).categories || [];
            render();
        }

        /** Run one category write; on success reload the list and the Cash
         *  Flow, on refusal say why. Resolves true when it saved. */
        async function write(request, name) {
            let res;
            try {
                res = await request();
            } catch (err) {
                console.error('[statements] category write failed:', err);
                Ant.message.error("Couldn't save the change — try again.");
                return false;
            }
            if (!res.ok) {
                Ant.message.error(categoryError(await bodyOf(res), name));
                return false;
            }
            window.Store?.invalidate('ie');
            await Promise.all([refresh(), onChange()]).catch((err) => console.error('[statements] reload failed:', err));
            return true;
        }

        async function add(type) {
            const input = panel.querySelector(`[data-new="${type}"]`);
            const name = input.value.trim();
            if (!name) return;
            if (await write(() => sendJson('/api/categories', 'POST', { name, cat_type: type }), name)) {
                Ant.message.success(`Added ${name}`);
                refocus(panel, `[data-new="${type}"]`);
            }
        }

        panel.addEventListener('input', (e) => {
            const type = e.target.dataset.new;
            if (type) panel.querySelector(`[data-act="add"][data-type="${type}"]`).disabled = !e.target.value.trim();
        });
        panel.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.dataset.new) { e.preventDefault(); add(e.target.dataset.new); }
        });
        panel.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn || btn.disabled) return;
            if (btn.dataset.act === 'add') { add(btn.dataset.type); return; }
            const id = Number(btn.closest('[data-id]').dataset.id);
            const cat = cats.find((c) => c.id === id);
            const act = btn.dataset.act;
            if (act === 'up' || act === 'down') {
                await write(() => sendJson(`/api/categories/${id}/move`, 'POST', { direction: act }), cat.name);
                // Focus stays on the arrow that was pressed, now on the moved row.
                refocus(panel, `[data-id="${id}"] [data-act="${act}"]:not(:disabled)`);
            } else if (act === 'delete') {
                const ok = await Ant.popconfirm(btn, {
                    title: `Delete ${cat.name}?`,
                    desc: 'Its column leaves the Cash Flow statement.',
                    okText: 'Delete',
                    danger: true,
                });
                if (ok) await write(() => sendJson(`/api/categories/${id}`, 'DELETE'), cat.name);
            } else if (act === 'rename') {
                editInPlace(btn.closest('li').querySelector('[data-slot]'), {
                    value: cat.name,
                    label: `Rename ${cat.name}`,
                    maxLength: MAX_CATEGORY_NAME,
                    done: async (name) => {
                        if (name && name !== cat.name) {
                            await write(() => sendJson(`/api/categories/${id}`, 'PUT', { name }), name);
                        } else {
                            render();
                        }
                        refocus(panel, `[data-id="${id}"] [data-act="rename"]`);
                    },
                });
            }
        });

        panel.innerHTML = '<p class="ant-typography-secondary">Loading…</p>';
        refresh().catch((err) => {
            console.error('[statements] categories failed to load:', err);
            panel.innerHTML = Ant.empty({ title: "Couldn't load your categories", desc: 'Close this and try again.' });
        });
    }

    // ─── Manage Columns: Balance Sheet accounts ─────────────────────────────

    const ACCOUNT_TYPES = [
        { key: 'cash', label: 'Cash' },
        { key: 'investment', label: 'Investment' },
        { key: 'retirement', label: 'Retirement' },
        { key: 'debt', label: 'Debt' },
    ];
    const MAX_ACCOUNT_NAME = 50;

    const typeSelect = (value, attrs, { small = true } = {}) => `<span class="ant-select${small ? ' ant-select-sm' : ''} stmt-type-select">
        <select class="ant-select-selector" ${attrs}>${ACCOUNT_TYPES.map((t) =>
            `<option value="${t.key}"${t.key === value ? ' selected' : ''}>${t.label}</option>`).join('')}</select>
        <span class="ant-select-arrow">${Ant.icon('down')}</span></span>`;

    /** balance: the Balance Sheet's controller. */
    function mountAccounts(panel, { balance }) {
        // The table's order: grouped by type, each type in its stored order.
        const accounts = () => ACCOUNT_TYPES.flatMap((t) => balance.columns().filter((c) => c.type === t.key));

        const rowHtml = (a, i, all) => {
            const sameType = (j) => all[j] && all[j].type === a.type;
            return `<li class="ant-list-item" data-key="${escapeHtml(a.key)}">
                <div class="stmt-item-main">
                    <span class="stmt-item-name" data-slot>${escapeHtml(a.label)}</span>
                    ${pencil(`Rename ${a.label}`)}
                </div>
                ${actions([
                    typeSelect(a.type, `data-act="type" aria-label="${escapeHtml(a.label)} type"`),
                    ...moveButtons(a.label, sameType(i - 1), sameType(i + 1)),
                    iconButton({ act: 'delete', icon: 'delete', label: `Remove ${a.label}`, danger: true }),
                ])}
            </li>`;
        };

        const render = () => {
            const all = accounts();
            const draft = panel.querySelector('[data-new-account]');
            const kept = draft ? { name: draft.value, type: panel.querySelector('[data-new-type]').value } : null;
            panel.innerHTML = `
                <ul class="ant-list ant-list-bordered ant-list-sm stmt-account-list" aria-label="Balance Sheet accounts">
                    ${all.length ? all.map(rowHtml).join('') : '<li class="ant-list-item ant-typography-secondary">No accounts yet</li>'}
                </ul>
                <div class="ant-space-compact ant-space-compact-block stmt-add-row">
                    <input class="ant-input" data-new-account maxlength="${MAX_ACCOUNT_NAME}"
                        placeholder="New account, e.g. High-Yield Savings" aria-label="New account name">
                    ${typeSelect('cash', 'data-new-type aria-label="New account type"', { small: false })}
                    <button type="button" class="ant-btn ant-btn-primary" data-act="add" disabled>${Ant.icon('plus')}<span>Add</span></button>
                </div>`;
            if (kept) {
                panel.querySelector('[data-new-account]').value = kept.name;
                panel.querySelector('[data-new-type]').value = kept.type;
                panel.querySelector('[data-act="add"]').disabled = !kept.name.trim();
            }
        };

        /** Run one account write (the controller reports a failure), then
         *  reload the Balance Sheet and redraw from it. */
        async function write(request) {
            const res = await request();
            if (res.ok === false) return false;
            await balance.reload().catch((err) => console.error('[statements] reload failed:', err));
            render();
            return true;
        }

        async function add() {
            const input = panel.querySelector('[data-new-account]');
            const label = input.value.trim();
            if (!label) return;
            const type = panel.querySelector('[data-new-type]').value;
            input.value = '';
            if (await write(() => balance.api.addColumn({ label, type }))) {
                Ant.message.success(`Added ${label} to the Balance Sheet`);
            } else {
                input.value = label;
            }
            refocus(panel, '[data-new-account]');
        }

        async function remove(btn, account) {
            const n = balance.valueCount(account.key);
            const ok = await Ant.popconfirm(btn, {
                title: `Remove ${account.label}?`,
                desc: n
                    ? `Its column and its ${plural(n, 'saved balance')} are erased. This can't be undone.`
                    : 'Its column leaves the Balance Sheet.',
                okText: 'Remove',
                danger: true,
            });
            if (ok) await write(() => balance.api.deleteColumn(account.key, { force: n > 0 }));
        }

        panel.addEventListener('input', (e) => {
            if (e.target.matches('[data-new-account]')) {
                panel.querySelector('[data-act="add"]').disabled = !e.target.value.trim();
            }
        });
        panel.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('[data-new-account]')) { e.preventDefault(); add(); }
        });
        panel.addEventListener('change', async (e) => {
            if (e.target.dataset.act !== 'type') return;
            const key = e.target.closest('[data-key]').dataset.key;
            await write(() => balance.api.updateColumn(key, { type: e.target.value }));
            refocus(panel, `[data-key="${CSS.escape(key)}"] [data-act="type"]`);
        });
        panel.addEventListener('click', async (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn || btn.disabled) return;
            const act = btn.dataset.act;
            if (act === 'add') { add(); return; }
            const key = btn.closest('[data-key]').dataset.key;
            const account = balance.columns().find((c) => c.key === key);
            const row = `[data-key="${CSS.escape(key)}"]`;
            if (act === 'up' || act === 'down') {
                await write(() => balance.api.moveColumn(key, act));
                refocus(panel, `${row} [data-act="${act}"]:not(:disabled)`);
            } else if (act === 'delete') {
                remove(btn, account);
            } else if (act === 'rename') {
                editInPlace(btn.closest('li').querySelector('[data-slot]'), {
                    value: account.label,
                    label: `Rename ${account.label}`,
                    maxLength: MAX_ACCOUNT_NAME,
                    done: async (label) => {
                        if (label && label !== account.label) await write(() => balance.api.updateColumn(key, { label }));
                        else render();
                        refocus(panel, `${row} [data-act="rename"]`);
                    },
                });
            }
        });

        render();
    }

    // ─── Manage Columns ─────────────────────────────────────────────────────

    /** tab: the statement tab the page is on, which picks the tab to open on. */
    function openColumns({ tab, cashflow, balance }) {
        const tabs = [
            { key: 'cashflow', label: 'Categories', mount: (panel) => mountCategories(panel, { onChange: () => cashflow.reload() }) },
            { key: 'balance', label: 'Balance Sheet accounts', mount: (panel) => mountAccounts(panel, { balance }) },
        ];
        const { dialog, close } = Ant.modal({
            title: 'Manage Columns',
            width: 640,
            className: 'stmt-columns-modal',
            body: `
                <div class="ant-tabs-nav stmt-modal-tabs">
                    <div class="stmt-tablist" role="tablist" aria-label="Columns">
                        ${tabs.map((t) => `<button type="button" class="ant-tabs-tab" role="tab" data-tab="${t.key}"
                            id="stmt-cols-tab-${t.key}" aria-controls="stmt-cols-panel-${t.key}"
                            aria-selected="false" tabindex="-1">${t.label}</button>`).join('')}
                    </div>
                </div>
                ${tabs.map((t) => `<div class="stmt-modal-panel" role="tabpanel" id="stmt-cols-panel-${t.key}"
                    data-panel="${t.key}" aria-labelledby="stmt-cols-tab-${t.key}" hidden></div>`).join('')}`,
            footer: '<button type="button" class="ant-btn ant-btn-primary" data-act="done">Done</button>',
        });
        // Panels mount on first view, so opening on one never loads the other.
        const mounted = new Set();
        const select = Ant.tabs(dialog.querySelector('[role="tablist"]'), {
            onChange: (key) => {
                for (const t of tabs) {
                    const panel = dialog.querySelector(`[data-panel="${t.key}"]`);
                    panel.hidden = t.key !== key;
                    if (t.key === key && !mounted.has(key)) {
                        mounted.add(key);
                        t.mount(panel);
                    }
                }
            },
        });
        dialog.querySelector('[data-act="done"]').addEventListener('click', close);
        select(tabs.some((t) => t.key === tab) ? tab : tabs[0].key, true);
    }

    window.StatementManagers = { openYears, openColumns };
}());
