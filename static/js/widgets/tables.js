'use strict';

// ============================================================================
// tables.js — the Statements grid: one Ant Design table per statement year.
// ============================================================================
//
// Loaded by the Statements page only, before statements.js, which starts one
// controller per tab (Cash Flow, Balance Sheet) with bootstrapYearTablePage().
//
// Each statement year is one card holding an Ant bordered table: the columns
// grouped under their type (Income / Expenses / Transfers, or Cash /
// Investment / Retirement / Debt), the Month column pinned left and a summary
// column pinned right (Net, or Net Worth), then a footer note. Every year is in
// the DOM; the page shows one at a time by toggling [hidden] on the cards.
//
// Cells are always-editable inputs that behave like a spreadsheet's: entering
// a cell (click, arrow, Enter or Tab) selects it, and typing replaces its
// value; double-click or F2 edits it in place. Typing saves after a short
// pause or on leaving the cell, and cellselect.js adds range selection with
// copy, paste and delete, and draws the border that marks the current cell.
//
// Cash Flow cells blend per cell (CLAUDE.md, rule 10): a cell shows the
// month's transaction sum, in the primary colour, until a typed value
// overrides it; the ↺ button clears the override. Balance Sheet cells are
// typed balances; an empty month at or before this one shows, faded, the
// balance carried forward from the last month that has one, the same
// carry-forward the Dashboard's net worth uses.
//
// Globals used: apiFetch, Store, Ant, escapeHtml, formatCurrency,
// stripCurrencyValue, applyCurrencyFormat, enableCellSelection (optional).

(function () {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
        'August', 'September', 'October', 'November', 'December'];

    /** Months since year 0, so two months compare as plain numbers. */
    const monthIndex = (year, monthIdx) => year * 12 + monthIdx;
    const thisMonthIndex = () => {
        const now = new Date();
        return monthIndex(now.getFullYear(), now.getMonth());
    };

    /** A cell's number, or null when it is empty or unreadable. */
    function cellNumber(input) {
        if (input.value === '') return null;
        const v = parseFloat(stripCurrencyValue(input.value));
        return Number.isNaN(v) ? null : v;
    }

    /** A write that did not reach the database is data loss unless it is
     *  reported: the value is on screen but was never stored. */
    function reportSaveFailure() {
        Ant.message.error("Couldn't save your change — it hasn't been stored.");
    }

    // ─── API ────────────────────────────────────────────────────────────────
    // One wrapper per statement. Every write settles through wrapWrite, which
    // reports a failure (a rejected call or an ok:false body) and resolves to
    // { ok: false } instead of rejecting, so callers check `.ok` without
    // try/catch. Writes also drop the matching Store dataset, so the pages that
    // read through the Store (Dashboard, Reports) do not show stale figures.
    // The statement itself reads straight from the API: a background
    // revalidation landing mid-edit would reset focus and scroll.

    const STORE_NAME_BY_PREFIX = { '/api': 'ie', '/api/balance': 'balance' };

    function makeYearTableApi(prefix) {
        const storeName = STORE_NAME_BY_PREFIX[prefix];
        const invalidate = () => {
            if (storeName && window.Store) window.Store.invalidate(storeName);
        };
        const sendJson = (url, method, body) => apiFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const wrapWrite = (promise) => promise
            .then(
                (res) => {
                    if (res && res.ok === false) reportSaveFailure();
                    return res;
                },
                (err) => {
                    console.error(`[statements] write to ${prefix} failed:`, err);
                    reportSaveFailure();
                    return { ok: false, error: String(err?.message || err) };
                },
            )
            .finally(invalidate);
        const json = (res) => res.json();
        return {
            get: () => apiFetch(`${prefix}/data`).then((res) => {
                if (!res.ok) throw new Error(`${prefix}/data: ${res.status}`);
                return res.json();
            }),
            upsertEntry: (year, month, category, value) =>
                wrapWrite(sendJson(`${prefix}/entry`, 'POST', { year, month, category, value })),
            deleteEntry: (year, month, category) =>
                wrapWrite(sendJson(`${prefix}/entry`, 'DELETE', { year, month, category })),
            addYear: (year) => wrapWrite(sendJson(`${prefix}/year`, 'POST', { year })),
            deleteYear: (year) => wrapWrite(apiFetch(`${prefix}/year/${year}`, { method: 'DELETE' })),
            duplicateYear: (from, to) =>
                wrapWrite(sendJson(`${prefix}/year/${from}/duplicate`, 'POST', { target_year: to })),
            // Column writes (the Balance Sheet's accounts). Their bodies carry
            // `ok`, so they are parsed before wrapWrite looks at them.
            addColumn: (body) => wrapWrite(sendJson(`${prefix}/columns`, 'POST', body).then(json)),
            updateColumn: (key, patch) =>
                wrapWrite(sendJson(`${prefix}/columns/${encodeURIComponent(key)}`, 'PUT', patch).then(json)),
            moveColumn: (key, direction) =>
                wrapWrite(sendJson(`${prefix}/columns/${encodeURIComponent(key)}/move`, 'POST', { direction }).then(json)),
            deleteColumn: (key, { force = false } = {}) => wrapWrite(apiFetch(
                `${prefix}/columns/${encodeURIComponent(key)}${force ? '?force=true' : ''}`,
                { method: 'DELETE' }).then(json)),
        };
    }

    // ─── Layout ─────────────────────────────────────────────────────────────

    /** The columns under their types, in the statement's type order. A type
     *  with no columns has no group. */
    function columnGroups(ctx) {
        return ctx.types
            .map((t) => ({ ...t, columns: ctx.columns.filter((c) => c.type === t.key) }))
            .filter((g) => g.columns.length);
    }

    /** One year's card. Every label is user-controlled and escaped. */
    function yearCardHtml(year, ctx) {
        const groups = columnGroups(ctx);
        const columns = groups.flatMap((g) => g.columns);
        const now = thisMonthIndex();
        const cells = (month) => columns.map((c) => `<td class="data-cell"><input type="text"
            class="stmt-input" inputmode="decimal" data-month="${month}" data-col="${escapeHtml(c.key)}"
            aria-label="${escapeHtml(c.label)}, ${month} ${year}"></td>`).join('');
        const rows = MONTHS.map((month, i) => `
            <tr${monthIndex(year, i) > now ? ' class="stmt-future"' : ''}>
                <th class="stmt-month stmt-fixed-start" scope="row">${month}</th>
                ${cells(month)}
                <td class="stmt-summary stmt-fixed-end"></td>
            </tr>`).join('');
        const totals = !ctx.includeTotals ? '' : `
            <tfoot><tr class="stmt-total">
                <th class="stmt-month stmt-fixed-start" scope="row">Total</th>
                ${columns.map((c) => `<td class="stmt-total-cell" data-total-col="${escapeHtml(c.key)}"></td>`).join('')}
                <td class="stmt-summary stmt-fixed-end"></td>
            </tr></tfoot>`;
        return `
            <div class="stmt-scroll">
                <table class="ant-table stmt-grid">
                    <thead>
                        <tr>
                            <th class="stmt-month stmt-fixed-start" rowspan="2" scope="col">Month</th>
                            ${groups.map((g) => `<th class="stmt-group" colspan="${g.columns.length}" scope="colgroup"
                                data-type="${g.key}">${escapeHtml(g.label)}</th>`).join('')}
                            <th class="stmt-summary stmt-fixed-end" rowspan="2" scope="col">${ctx.summaryHead}</th>
                        </tr>
                        <tr>${columns.map((c) => `<th class="stmt-col" scope="col"
                            data-type="${escapeHtml(c.type)}">${escapeHtml(c.label)}</th>`).join('')}</tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    ${totals}
                </table>
            </div>
            <div class="stmt-footer">${ctx.footer()}</div>`;
    }

    function createYearCard(year, ctx) {
        const card = document.createElement('section');
        card.className = 'ant-card stmt-year';
        card.dataset.year = year;
        card.setAttribute('aria-label', `${ctx.title}, ${year}`);
        card.hidden = true;   // the page shows the selected year
        card.innerHTML = yearCardHtml(year, ctx);
        return card;
    }

    // ─── Pinned columns' shadows ────────────────────────────────────────────
    // Ant shades the edge of a pinned column while cells are scrolled under
    // it. The scroll box carries one class per side; a ResizeObserver re-reads
    // them when a card is shown (it has no width while hidden) or the window
    // resizes.
    function updatePing(scroller) {
        const max = scroller.scrollWidth - scroller.clientWidth;
        scroller.classList.toggle('stmt-ping-start', scroller.scrollLeft > 0);
        scroller.classList.toggle('stmt-ping-end', scroller.scrollLeft < max - 1);
    }

    const pingObserver = new ResizeObserver((entries) => {
        for (const entry of entries) updatePing(entry.target);
    });

    // ─── Render / reload ────────────────────────────────────────────────────

    /** Rebuild every year's card from ctx, newest first. */
    function renderYearTables(ctx) {
        // Commit edits still inside their debounce window before the inputs go.
        // fire() writes through to ctx.entries synchronously, so the rebuild
        // reads those values even while the request is in flight.
        flushAllPendingCellSaves();
        ctx.container.querySelectorAll('.stmt-scroll').forEach((s) => pingObserver.unobserve(s));
        ctx.container.replaceChildren();
        [...ctx.years].sort((a, b) => b - a).forEach((year) => {
            const card = createYearCard(year, ctx);
            ctx.container.appendChild(card);
            initYearCard(card, ctx);
        });
        if (ctx.summary === 'networth') refreshBalances(ctx);
        ctx.onRender();
    }

    async function reloadYearTables(ctx) {
        const data = await ctx.api.get();
        ctx.columns = data.columns;
        ctx.years = data.years;
        ctx.entries = data.entries;
        // Provenance layers: only Cash Flow ships them. `computed` is the
        // per-cell transaction sums, `manual` the stored overrides; entries is
        // the blend (manual ?? computed).
        ctx.computed = data.computed || null;
        ctx.manual = data.manual || null;
        ctx.typeOf = new Map(ctx.columns.map((c) => [c.key, c.type]));
        renderYearTables(ctx);
    }

    // ─── Cell-save scheduler ────────────────────────────────────────────────
    // One debounce timer per input: a shared timer would let typing in one cell
    // cancel another's pending save. Module-level, so one pagehide listener
    // flushes every table on the page.
    const SAVE_DEBOUNCE_MS = 600;
    const pendingCellSaves = new Map();   // input → { timer, fire }

    function flushAllPendingCellSaves() {
        for (const { timer, fire } of pendingCellSaves.values()) {
            clearTimeout(timer);
            fire();
        }
        pendingCellSaves.clear();
    }

    // Each save is handed to IPC synchronously inside this handler, so the
    // main process completes it even though the page is unloading.
    window.addEventListener('pagehide', flushAllPendingCellSaves);

    // ─── Cell provenance (Cash Flow) ────────────────────────────────────────
    // A cell is either computed (no stored entry: the month's transaction sum,
    // in the primary colour; blank when there is none) or the user's (a stored
    // entry: plain text). A user value over a computed one grows the ↺ button,
    // which clears the entry and hands the cell back to the transactions.

    const layerValue = (layer, year, month, col) => layer?.[String(year)]?.[month]?.[col];

    /** Pad a settled value to cents, "$1,240" → "$1,240.00", so a column of
     *  amounts lines up on its decimal point. Typing echoes exactly what was
     *  typed (padding mid-keystroke would move the caret), so this runs once
     *  the cell settles. */
    function normaliseCellValue(input) {
        const v = cellNumber(input);
        if (v !== null) input.value = formatCurrency(v, false, { editable: true });
    }

    function revertButton(computed) {
        const amount = formatCurrency(computed);
        return `<button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only stmt-revert"
            data-tip="Typed over. From transactions: ${escapeHtml(amount)}. Click to use that instead."
            aria-label="Use ${escapeHtml(amount)} from transactions">${Ant.icon('undo')}</button>`;
    }

    /** Sync a cell's value, colour and ↺ to the layers. `flash` fades in a
     *  value returning to its computed state. */
    function applyCellPresentation(input, year, ctx, { flash = false } = {}) {
        const { month, col } = input.dataset;
        const td = input.closest('td');
        const manual = layerValue(ctx.manual, year, month, col);
        const computed = layerValue(ctx.computed, year, month, col);
        td.querySelector('.stmt-revert')?.remove();
        input.classList.remove('cell-computed', 'cell-flash');

        if (manual !== undefined) {
            input.value = formatCurrency(manual, false, { editable: true });
            if (computed !== undefined) td.insertAdjacentHTML('beforeend', revertButton(computed));
            return;
        }
        if (computed === undefined) {
            input.value = '';
            return;
        }
        input.value = formatCurrency(computed, false, { editable: true });
        input.classList.add('cell-computed');
        if (flash) {
            void input.offsetWidth;   // reflow, so re-adding the class replays the fade
            input.classList.add('cell-flash');
        }
    }

    // Shown once, the first time a computed cell is overridden: the moment the
    // rule matters, it says both halves of it.
    const OVERRIDE_HINT_KEY = 'cf-override-hint-shown';
    function maybeShowOverrideHint() {
        try {
            if (localStorage.getItem(OVERRIDE_HINT_KEY)) return;
            localStorage.setItem(OVERRIDE_HINT_KEY, '1');
        } catch {
            return;   // no storage: skip the hint rather than repeat it forever
        }
        Ant.message.info('This cell now holds your value and won’t update from transactions. '
            + 'Clear it to return to the figure from transactions.', { duration: 8000 });
    }

    // ─── Summaries ──────────────────────────────────────────────────────────

    const tone = (v) => (v >= 0 ? 'stmt-pos' : 'stmt-neg');
    const signed = (v) => (v > 0 ? '+' : '') + formatCurrency(v);

    /** Cash Flow: each month's Net (income minus expenses; transfers are
     *  neither), the column totals and the year's Net. Read from the inputs,
     *  so a figure being typed is counted at once. */
    function refreshNet(card, ctx) {
        let yearNet = 0;
        let yearAny = false;
        card.querySelectorAll('tbody tr').forEach((tr) => {
            let net = 0;
            let any = false;
            tr.querySelectorAll('.stmt-input').forEach((input) => {
                const v = cellNumber(input);
                const type = ctx.typeOf.get(input.dataset.col);
                if (v === null || (type !== 'income' && type !== 'expense')) return;
                net += type === 'income' ? v : -v;
                any = true;
            });
            const cell = tr.querySelector('.stmt-summary');
            cell.innerHTML = any ? `<span class="${tone(net)}">${escapeHtml(signed(net))}</span>` : '';
            if (any) { yearNet += net; yearAny = true; }
        });
        if (!ctx.includeTotals) return;
        card.querySelectorAll('[data-total-col]').forEach((cell) => {
            let sum = 0;
            let any = false;
            card.querySelectorAll(`.stmt-input[data-col="${CSS.escape(cell.dataset.totalCol)}"]`).forEach((input) => {
                const v = cellNumber(input);
                if (v !== null) { sum += v; any = true; }
            });
            cell.textContent = any ? formatCurrency(sum) : '';
        });
        card.querySelector('tfoot .stmt-summary').innerHTML = yearAny
            ? `<span class="${tone(yearNet)}">${escapeHtml(signed(yearNet))}</span>` : '';
    }

    /** Balance Sheet: walk every year oldest first, carrying each account's
     *  latest balance forward. An empty cell at or before this month shows the
     *  carried figure as its placeholder, and Net Worth sums what each month
     *  shows, debts counted against it. Every year is walked, because a
     *  December balance carries into the next January. */
    function refreshBalances(ctx) {
        const now = thisMonthIndex();
        const latest = new Map();   // column key → its most recent balance
        const cards = [...ctx.container.querySelectorAll('.stmt-year')]
            .sort((a, b) => a.dataset.year - b.dataset.year);
        for (const card of cards) {
            const year = Number(card.dataset.year);
            card.querySelectorAll('tbody tr').forEach((tr, i) => {
                const past = monthIndex(year, i) <= now;
                let worth = 0;
                let any = false;
                tr.querySelectorAll('.stmt-input').forEach((input) => {
                    const col = input.dataset.col;
                    const own = cellNumber(input);
                    if (own !== null) latest.set(col, own);
                    const carried = own === null && past ? latest.get(col) : undefined;
                    input.placeholder = carried === undefined
                        ? '' : formatCurrency(carried, false, { editable: true });
                    const shown = own ?? carried;
                    if (!past || shown === undefined) return;
                    worth += ctx.typeOf.get(col) === 'debt' ? -shown : shown;
                    any = true;
                });
                tr.querySelector('.stmt-summary').textContent = any ? formatCurrency(worth) : '';
            });
        }
    }

    function refreshSummaries(card, ctx) {
        if (ctx.summary === 'networth') refreshBalances(ctx);
        else refreshNet(card, ctx);
    }

    // ─── Year card: fill and wire ───────────────────────────────────────────

    /** Arrow keys move between cells and stop at the table's edges; Enter
     *  moves down, so a column fills without reaching for the arrows. */
    function moveFocus(input, key) {
        const td = input.closest('td');
        const tr = td.parentElement;
        const col = [...tr.querySelectorAll('td.data-cell')].indexOf(td);
        let row = tr;
        let target = col;
        if (key === 'Enter' || key === 'ArrowDown') row = tr.nextElementSibling;
        else if (key === 'ArrowUp') row = tr.previousElementSibling;
        else if (key === 'ArrowRight') target = col + 1;
        else if (key === 'ArrowLeft') target = col - 1;
        else return false;
        const next = row?.querySelectorAll('td.data-cell')[target]?.querySelector('input');
        if (!next) return false;
        next.focus();   // its focus handler enters it
        return true;
    }

    // ─── Entered and editing ────────────────────────────────────────────────
    // A spreadsheet cell has two states once you are on it. Entered: the cell
    // is selected, and the first keystroke replaces its value. Editing: a caret
    // in the value, placed by double-click or F2. An entered input keeps its
    // whole value selected so a keystroke replaces it, with the selection and
    // the caret hidden (.is-entered, statements.css) so the cell's border is
    // the only highlight.
    const ENTERED = 'is-entered';

    function enterCell(input) {
        input.classList.add(ENTERED);
        input.select();
    }

    /** Switch to editing with the caret at `at` (default: the end). */
    function editCell(input, at = input.value.length) {
        input.classList.remove(ENTERED);
        input.setSelectionRange(at, at);
    }

    /** Keys that start typing into an entered cell, replacing what it held. */
    const replacesValue = (e) => !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete');

    function initYearCard(card, ctx) {
        const year = Number(card.dataset.year);
        const yearKey = String(year);
        const present = (input, opts) => (ctx.computed
            ? applyCellPresentation(input, year, ctx, opts)
            : normaliseCellValue(input));

        const fireSave = (input) => {
            pendingCellSaves.delete(input);
            const { month, col } = input.dataset;
            const value = cellNumber(input);
            // Write through to ctx so a re-render (after a column edit) shows
            // what was typed since the last reload.
            const months = (ctx.entries[yearKey] ??= {});
            const computed = layerValue(ctx.computed, year, month, col);
            if (value === null) {
                // Clearing a cell deletes its entry. On Cash Flow that hands
                // the cell back to its computed value; a blank is never an
                // override (to force zero, type 0).
                if (ctx.manual?.[yearKey]?.[month]) delete ctx.manual[yearKey][month][col];
                if (computed !== undefined) (months[month] ??= {})[col] = computed;
                else if (months[month]) delete months[month][col];
                ctx.api.deleteEntry(year, month, col);
            } else {
                (months[month] ??= {})[col] = value;
                if (ctx.computed) {
                    (((ctx.manual ??= {})[yearKey] ??= {})[month] ??= {})[col] = value;
                    if (computed !== undefined) maybeShowOverrideHint();
                }
                ctx.api.upsertEntry(year, month, col, value);
            }
            // Re-present unless the cell is still being typed in (its blur
            // presents it then): this covers pasted and cleared ranges, ↺, and
            // saves that land after focus moved on.
            if (document.activeElement !== input) {
                present(input, { flash: value === null && computed !== undefined });
                refreshSummaries(card, ctx);
            }
        };

        const scheduleSave = (input) => {
            const pending = pendingCellSaves.get(input);
            if (pending) clearTimeout(pending.timer);
            const fire = () => fireSave(input);
            pendingCellSaves.set(input, { timer: setTimeout(fire, SAVE_DEBOUNCE_MS), fire });
        };

        card.querySelectorAll('.stmt-input').forEach((input) => {
            const { month, col } = input.dataset;
            if (ctx.computed) {
                present(input);
            } else {
                // {editable} keeps the cents even with "hide cents" on, which
                // would otherwise truncate them on the next save.
                const saved = ctx.entries[yearKey]?.[month]?.[col];
                if (saved !== undefined) input.value = formatCurrency(saved, false, { editable: true });
            }

            input.addEventListener('input', () => {
                // Typing makes the cell the user's straight away, and puts it in
                // editing; the save records it after the pause.
                input.classList.remove('cell-computed', 'cell-flash', ENTERED);
                applyCurrencyFormat(input);
                scheduleSave(input);
                refreshSummaries(card, ctx);
            });

            // Leaving the cell commits a pending edit at once rather than after
            // the pause. With nothing pending, a cleared cell fades its
            // computed value back in here.
            input.addEventListener('focus', () => enterCell(input));
            // A press places the caret on mouseup; re-select so an entered cell
            // stays entered. A press inside a cell being edited moves its caret.
            input.addEventListener('click', () => {
                if (input.classList.contains(ENTERED)) input.select();
            });
            // Double-click edits, with the caret after the word that was hit.
            input.addEventListener('dblclick', () => editCell(input, input.selectionEnd));

            input.addEventListener('blur', () => {
                input.classList.remove(ENTERED);
                const pending = pendingCellSaves.get(input);
                if (pending) {
                    clearTimeout(pending.timer);
                    pending.fire();
                } else {
                    present(input, {
                        flash: input.value === '' && layerValue(ctx.computed, year, month, col) !== undefined,
                    });
                    refreshSummaries(card, ctx);
                }
            });

            input.addEventListener('keydown', (e) => {
                // cellselect.js already acted on it (clearing a range).
                if (e.defaultPrevented) return;
                if (e.key === 'F2') {
                    e.preventDefault();
                    editCell(input);
                } else if (moveFocus(input, e.key)) {
                    e.preventDefault();
                } else if (input.classList.contains(ENTERED) && replacesValue(e)) {
                    // Over the whole value, so the key replaces (or clears) it.
                    input.select();
                    input.classList.remove(ENTERED);
                }
            });
        });

        // ↺: clear the override through the same save path as typing.
        card.addEventListener('click', (e) => {
            const btn = e.target.closest('.stmt-revert');
            if (!btn) return;
            const input = btn.closest('td').querySelector('.stmt-input');
            const pending = pendingCellSaves.get(input);
            if (pending) clearTimeout(pending.timer);
            input.value = '';
            fireSave(input);
        });

        // Range selection, copy, paste and delete (cellselect.js). It writes
        // cells by dispatching `input`, so those edits save through the
        // handlers above.
        if (window.enableCellSelection) {
            enableCellSelection(card.querySelector('.stmt-grid'), { cellSelector: 'td.data-cell' });
        }

        const scroller = card.querySelector('.stmt-scroll');
        scroller.addEventListener('scroll', () => updatePing(scroller), { passive: true });
        pingObserver.observe(scroller);

        if (ctx.summary === 'net') refreshNet(card, ctx);
    }

    // ─── Bootstrap ──────────────────────────────────────────────────────────

    /**
     * Start the grid for one statement.
     *
     * opts:
     *   apiPrefix         '/api' (Cash Flow) or '/api/balance' (Balance Sheet)
     *   title             the statement's name, for each card's label
     *   types             [{ key, label }] — the column groups, in order
     *   summary           'net' (income minus expenses) or 'networth' (assets
     *                     minus debts, balances carried forward)
     *   summaryHead       trusted markup for the summary column's header
     *   includeTotals     render a Total row
     *   footer            () → trusted markup for the note under the table
     *   containerSelector where the cards go
     *   onRender          runs after every full render and every added year,
     *                     and once with nothing rendered if the load fails
     *   onError           (err) → runs when the statement cannot be loaded
     *
     * Returns the handle the page and its managers use: api, reload(),
     * years(), hasYear(year), addYear(year), columns(), and
     * valueCount(columnKey), the stored values in a column across every year.
     */
    function bootstrapYearTablePage(opts) {
        const ctx = {
            api: makeYearTableApi(opts.apiPrefix),
            title: opts.title,
            types: opts.types,
            summary: opts.summary,
            summaryHead: opts.summaryHead,
            includeTotals: !!opts.includeTotals,
            footer: opts.footer,
            onRender: opts.onRender || (() => {}),
            container: document.querySelector(opts.containerSelector),
            columns: [],
            years: [],
            entries: {},
            computed: null,
            manual: null,
            typeOf: new Map(),
        };

        // Create the year on the backend and slot its card in among the
        // others; the page selects it from onRender.
        const addYear = async (year) => {
            const res = await ctx.api.addYear(year);
            if (res.ok === false) return false;
            ctx.years.push(year);
            ctx.entries[String(year)] = {};
            const card = createYearCard(year, ctx);
            const after = [...ctx.container.querySelectorAll('.stmt-year')]
                .find((c) => Number(c.dataset.year) < year);
            ctx.container.insertBefore(card, after || null);
            initYearCard(card, ctx);
            if (ctx.summary === 'networth') refreshBalances(ctx);
            ctx.onRender();
            return true;
        };

        const valueCount = (key) => Object.values(ctx.entries)
            .reduce((n, months) => n + Object.values(months).filter((m) => m[key] !== undefined).length, 0);

        // Scripts sit at the end of <body>, so the container is already parsed.
        reloadYearTables(ctx).catch((err) => {
            console.error(`[statements] ${opts.apiPrefix} failed to load:`, err);
            opts.onError?.(err);
            ctx.onRender();
        });

        return {
            api: ctx.api,
            reload: () => reloadYearTables(ctx),
            years: () => [...ctx.years],
            hasYear: (year) => ctx.years.includes(year),
            addYear,
            columns: () => [...ctx.columns],
            valueCount,
        };
    }

    // Consumed by statements.js; the matching readonly entry lives in
    // eslint.config.mjs.
    window.bootstrapYearTablePage = bootstrapYearTablePage;
}());
