'use strict';

// ─── txexport.js ──────────────────────────────────────────────────────────────
// The Export transactions dialog for the Transactions page, drawn in Ant
// Design — the counterpart of txfileimport.js, kept in a separate file for the
// same reason.
//
// The renderer never touches the filesystem: serialisation and writes are in the
// backend (electron/backend/services/txExport.js behind
// POST /api/transactions/export). This file provides the dialog and drives the
// chunked export loop — one POST per chunk of rows, each appending to
// <path>.part until the final call renames it into place — so the progress bar
// tracks rows actually written rather than elapsed time.
//
// The dialog: the format (CSV, OFX, QFX, QIF) and which transactions (the ones
// shown, the ones ticked, or all of them) as two rows of radio buttons, then
// where the file goes. Browse… opens the native save dialog under Electron; in
// a plain browser (fixture mode) it is hidden and the path is typed. Export
// swaps the form for a progress bar, then for where the file landed.

(function () {
    const TxFileExport = (() => {

        const esc = escapeHtml;

        const FORMATS = [
            { id: 'csv', label: 'CSV', desc: 'Comma-separated values — opens in Excel, Sheets and most tools.' },
            { id: 'ofx', label: 'OFX', desc: 'Open Financial Exchange — accepted by most finance apps.' },
            { id: 'qfx', label: 'QFX', desc: 'Quicken Web Connect — OFX flavoured for Quicken.' },
            { id: 'qif', label: 'QIF', desc: 'Quicken Interchange Format — for older finance software.' },
        ];
        const EXT_RX = /\.(csv|ofx|qfx|qif)$/i;
        const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

        const radios = (name, items, checked) => items.map((it) => `<label class="ant-radio-button-wrapper">
            <input type="radio" name="${name}" value="${it.value}"${it.value === checked ? ' checked' : ''}${it.disabled ? ' disabled' : ''}>${esc(it.label)}</label>`).join('');

        const progressHtml = (pct, status = '') => `<div class="ant-progress${status ? ` ant-progress-status-${status}` : ''}" role="progressbar"
            aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div class="ant-progress-outer"><div class="ant-progress-inner"><div class="ant-progress-bg" style="width:${pct}%"></div></div></div>
            <span class="ant-progress-text">${status === 'success' ? Ant.icon('check-circle') : `${pct}%`}</span></div>`;

        /**
         * `filters`: the export endpoint's filters for the rows the ledger shows
         * (null when none are set); `shown`, `total`: how many rows that is and
         * how many the ledger holds; `selectedIds`: the rows ticked. The backend
         * re-applies the filters itself, so the counts are for display only.
         */
        function run({ filters = null, shown = 0, selectedIds = [], total = 0 } = {}) {
            const fileApi = window.electronFile || null;
            const scopes = [
                { value: 'shown', label: `Shown (${shown.toLocaleString()})` },
                { value: 'selected', label: `Selected (${selectedIds.length.toLocaleString()})`, disabled: !selectedIds.length },
                { value: 'all', label: `All (${total.toLocaleString()})` },
            ];
            const placeholder = (fmt) => `e.g. ~/Documents/transactions-${todayIso()}.${fmt}`;
            let busy = false;

            const { dialog, close } = Ant.modal({
                title: 'Export transactions',
                width: 600,
                className: 'tx-export-modal',
                canClose: () => !busy,
                body: `
                    <div class="tx-export-form">
                        <fieldset class="tx-export-choice"><legend>Format</legend>
                            <div class="ant-radio-group">${radios('tx-export-format', FORMATS.map((f) => ({ value: f.id, label: f.label })), 'csv')}</div>
                            <div class="ant-typography-secondary tx-export-format-hint">${esc(FORMATS[0].desc)}</div>
                        </fieldset>
                        <fieldset class="tx-export-choice"><legend>Transactions</legend>
                            <div class="ant-radio-group">${radios('tx-export-scope', scopes, selectedIds.length ? 'selected' : 'shown')}</div>
                        </fieldset>
                        <label class="ant-form-item"><span class="ant-form-item-label">Save to</span>
                            <span class="tx-export-path">
                                <input type="text" class="ant-input" placeholder="${esc(placeholder('csv'))}" spellcheck="false" autocomplete="off">
                                <button type="button" class="ant-btn ant-btn-default" data-act="browse"${fileApi ? '' : ' hidden'}>Browse…</button>
                            </span>
                            <span class="ant-form-item-explain" role="alert"></span>
                        </label>
                    </div>
                    <div class="tx-export-progress" hidden></div>`,
                footer: `<button type="button" class="ant-btn ant-btn-default" data-act="cancel">Cancel</button>
                    <button type="button" class="ant-btn ant-btn-primary" data-act="export">${Ant.icon('download')}Export</button>`,
            });
            const $ = (sel) => dialog.querySelector(sel);
            const form = $('.tx-export-form');
            const progress = $('.tx-export-progress');
            const pathInput = $('.tx-export-path input');
            const explain = $('.ant-form-item-explain');
            const footer = $('.ant-modal-footer');
            const format = () => $('input[name="tx-export-format"]:checked').value;
            const scope = () => $('input[name="tx-export-scope"]:checked').value;

            // The native save dialog already confirms replacing a file; a typed
            // path has not been, so the backend's 409 is asked about instead.
            let overwriteConfirmed = false;

            function showError(text) {
                explain.textContent = text;
                pathInput.setAttribute('aria-invalid', String(!!text));
            }

            form.addEventListener('change', (e) => {
                if (e.target.name !== 'tx-export-format') return;
                const fmt = format();
                $('.tx-export-format-hint').textContent = FORMATS.find((f) => f.id === fmt).desc;
                pathInput.placeholder = placeholder(fmt);
                const p = pathInput.value.trim();
                if (p && EXT_RX.test(p)) pathInput.value = p.replace(EXT_RX, `.${fmt}`);
            });
            pathInput.addEventListener('input', () => { overwriteConfirmed = false; showError(''); });
            pathInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); start(); }
            });

            footer.addEventListener('click', (e) => {
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (act === 'cancel' || act === 'done') close();
                if (act === 'export') start();
            });
            $('[data-act="browse"]').addEventListener('click', async () => {
                const p = await fileApi.chooseExportPath(format());
                if (p) {
                    pathInput.value = p;
                    overwriteConfirmed = true;
                    showError('');
                }
            });

            const scopeFilters = () => (scope() === 'selected' ? { ids: [...selectedIds] } : scope() === 'all' ? null : filters);

            async function start() {
                if (busy) return;
                let path = pathInput.value.trim();
                if (!path) { showError('Choose where to save the export.'); pathInput.focus(); return; }
                // A bare folder-and-name path gets the format's extension.
                if (!EXT_RX.test(path)) path += `.${format()}`;
                showError('');
                const fmt = format();
                const flt = scopeFilters();

                busy = true;
                form.hidden = true;
                progress.hidden = false;
                progress.innerHTML = `<div>Exporting transactions…</div>${progressHtml(0)}<div class="ant-typography-secondary tx-num" aria-live="polite">Starting…</div>`;
                footer.hidden = true;

                let overwrite = overwriteConfirmed;
                let offset = 0;
                let result = {};
                try {
                    for (;;) {
                        const r = await apiFetch('/api/transactions/export', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            // The chunk protocol is stateless, so the filters ride
                            // along on every call, as the offset does.
                            body: JSON.stringify(flt ? { path, format: fmt, offset, overwrite, filters: flt } : { path, format: fmt, offset, overwrite }),
                        });
                        const data = await r.json().catch(() => ({}));
                        if (r.status === 409 && offset === 0 && !overwrite) {
                            busy = false;
                            const replace = await Ant.confirm({
                                title: 'Replace the file?',
                                content: `<p>A file already exists at ${esc(path)}.</p>`,
                                okText: 'Replace',
                                danger: true,
                            });
                            if (!replace) { backToForm(); return; }
                            busy = true;
                            overwrite = true;
                            continue;
                        }
                        if (!r.ok) throw new Error(data.error || 'the export failed');
                        if (typeof data.exported === 'number' && typeof data.total === 'number') {
                            const pct = data.total > 0 ? Math.round((data.exported / data.total) * 100) : 100;
                            progress.querySelector('.ant-progress').outerHTML = progressHtml(pct);
                            progress.lastElementChild.textContent = `${data.exported.toLocaleString()} of ${plural(data.total, 'transaction')}`;
                        }
                        result = data;
                        // `done === false` (not merely falsy) keeps going: fixture
                        // mode's bare {ok:true} must end the loop.
                        if (data.done === false) { offset = data.exported; continue; }
                        break;
                    }
                } catch (err) {
                    backToForm();
                    showError(`The export failed: ${err.message}`);
                    return;
                }

                busy = false;
                const n = typeof result.exported === 'number' ? result.exported : null;
                progress.innerHTML = `<div>Export complete</div>${progressHtml(100, 'success')}
                    <div class="ant-typography-secondary">${n === null ? 'Saved to' : `${esc(plural(n, 'transaction'))} saved to`}
                        <span class="ant-typography-code tx-export-path-text">${esc(result.path || path)}</span></div>`;
                footer.innerHTML = '<button type="button" class="ant-btn ant-btn-primary" data-act="done">Done</button>';
                footer.hidden = false;
                footer.querySelector('[data-act="done"]').focus();
            }

            function backToForm() {
                busy = false;
                progress.hidden = true;
                form.hidden = false;
                footer.hidden = false;
                pathInput.focus();
            }

            pathInput.focus();
        }

        return { run };
    })();

    window.TxFileExport = TxFileExport;
}());
