'use strict';

// ─── Portfolio page ─────────────────────────────────────────────────────────
// Holdings per brokerage or retirement account, priced by hand: the app never
// goes online for quotes. Drawn in Ant Design (static/css/ant.css,
// static/js/widgets/ant.js); the page layout is portfolio.css.
//
// Shape: ACCOUNTS, each holding a list of asset ENTRIES with five editable
// fields (asset name, ticker, amount, average price paid, market price). Value
// (amount × market price) and Gain (value − amount × average price) are
// computed, per row, per account and across the portfolio.
//
// What the page draws:
//   - Add account, then three Statistic cards: market value, cost basis and
//     unrealized gain across every account.
//   - Allocation: a donut and its legend, by holding or by account (Ant's
//     Segmented). Holdings are identities, not meanings, so the slices wear
//     Ant's categorical chart palette in size order.
//   - One card per account: its name (renamed in place, Ant's editable text),
//     Add asset (a dialog that creates the holding whole), Delete account, and
//     the holdings as a small Ant table with a totals row. A card folds to its
//     header; the first starts open and the rest folded, and the window
//     remembers what the user folded (ViewState).
//
// The cells stay inputs, like a spreadsheet: typing saves after a pause
// (debounced, one PUT per row carrying every field changed), the arrow keys move
// between cells, and cellselect.js adds drag / Shift+arrow selection with copy,
// paste and delete. Everything is delegated from the accounts container, so a
// re-rendered card needs no wiring of its own.
//
// Globals (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), debounce/formatDisplay/applyCommaFormat (format.js),
// formatCurrency/applyCurrencyFormat/stripCurrencyValue (currency.js),
// ViewState (viewstate.js), DonutChart (widgets/donut.js),
// enableCellSelection (widgets/cellselect.js), Ant (widgets/ant.js).

(function () {
    // Decimal places Amount keeps. Amount is a share/unit count, not money:
    // fractional-share brokers sell to 4 places and crypto is quoted finer
    // still, so the money columns' 2 places would misstate a holding. The
    // backend stores the number unrounded either way.
    const AMOUNT_DP = 4;
    // A pause in typing long enough that a row saves once, not once per key.
    const SAVE_DELAY_MS = 600;
    // Typing in a price moves a slice on every keystroke; the donut redraws
    // after the same kind of pause.
    const CHART_DELAY_MS = 250;
    // Ant's categorical palette has ten colours (ant.css --ant-chart-1…10).
    const CHART_COLORS = 10;
    const VIEW_KEY = 'portfolio';

    // The editable fields, in column order. `col` is the arrow keys' column.
    const FIELDS = {
        asset_name:   { col: 0, label: 'Asset name' },
        ticker:       { col: 1, label: 'Ticker' },
        amount:       { col: 2, label: 'Shares' },
        price:        { col: 3, label: 'Average price paid' },
        market_price: { col: 4, label: 'Market price' },
    };
    const MONEY_FIELDS = new Set(['price', 'market_price']);
    const LAST_COL = 4;

    // ─── State ──────────────────────────────────────────────────────────────
    let ACCOUNTS = [];
    let allocBy = 'holding';
    // Account ids folded to their header.
    let folded = new Set();
    // entry id -> the fields edited since the last save.
    const pending = new Map();

    const findAccount = (id) => ACCOUNTS.find((a) => a.id === id);

    // ─── API ────────────────────────────────────────────────────────────────

    const postJson = (body) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const putJson = (body) => ({ ...postJson(body), method: 'PUT' });

    // ─── Figures ────────────────────────────────────────────────────────────

    const valueOf = (e) => (e.amount || 0) * (e.market_price || 0);
    const costOf = (e) => (e.amount || 0) * (e.price || 0);
    const sum = (list, of) => list.reduce((total, x) => total + of(x), 0);
    const allEntries = () => ACCOUNTS.flatMap((a) => a.entries);

    /** Whole currency units, for the allocation: cents are noise there. */
    const roundMoney = (v) => formatCurrency(Math.round(v), true);

    const percent = (ratio, dp = 1) => `${(ratio * 100).toFixed(dp)}%`;

    /** "▲ $4,599.71 (33.5%)": a gain against what was paid, coloured by which
     *  way it went, with the word for screen readers since the caret is an
     *  icon. A dash when nothing was paid (no average price), so there is no
     *  rate to give; nothing at all for an empty row. */
    function changeHtml(gain, cost) {
        if (!cost) return gain ? '<span class="pf-change pf-change-flat">—</span>' : '';
        const ratio = gain / cost;
        if (Math.abs(ratio) < 0.0005) {
            return `<span class="pf-change pf-change-flat">${escapeHtml(formatCurrency(0))} (0.0%)</span>`;
        }
        const up = gain > 0;
        return `<span class="pf-change pf-change-${up ? 'up' : 'down'}">${Ant.icon(up ? 'caret-up' : 'caret-down')}`
            + `<span class="ant-visually-hidden">${up ? 'Up' : 'Down'} </span>`
            + `${escapeHtml(formatCurrency(Math.abs(gain)))} (${percent(Math.abs(ratio))})</span>`;
    }

    // ─── View state ─────────────────────────────────────────────────────────
    // What the user folded and how the allocation is cut, for the window's
    // lifetime (ViewState). On the first visit the first account starts open and
    // the rest folded, so a long list does not push the first one's holdings off
    // screen.

    function restoreView() {
        const saved = ViewState.get(VIEW_KEY);
        allocBy = saved?.by === 'account' ? 'account' : 'holding';
        folded = Array.isArray(saved?.folded)
            ? new Set(saved.folded)
            : new Set(ACCOUNTS.slice(1).map((a) => a.id));
    }

    function saveView() {
        ViewState.set(VIEW_KEY, { by: allocBy, folded: [...folded] });
    }

    // ─── Totals ─────────────────────────────────────────────────────────────

    function renderSummary() {
        const host = document.getElementById('pf-summary');
        const entries = allEntries();
        const value = sum(entries, valueOf);
        const cost = sum(entries, costOf);
        const gain = value - cost;
        const tone = gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat';
        const signed = gain > 0 ? `+${formatCurrency(gain)}` : formatCurrency(gain);
        const card = (cls, title, content) => `
            <div class="ant-card ant-card-small ${cls}">
                <div class="ant-card-body">
                    <div class="ant-statistic-title">${title}</div>
                    <div class="ant-statistic-content">${content}</div>
                </div>
            </div>`;
        host.innerHTML = card('', 'Market value', escapeHtml(formatCurrency(value)))
            + card('', 'Cost basis', escapeHtml(formatCurrency(cost)))
            + card(`pf-stat-gain pf-stat-${tone}`, 'Unrealized gain',
                `<span>${escapeHtml(signed)}</span>${cost ? `<span class="pf-stat-suffix">${percent(gain / cost)}</span>` : ''}`);
    }

    // ─── Allocation ─────────────────────────────────────────────────────────

    let palette = null;

    /** The chart colours as resolved values, read once per palette: the donut
     *  paints SVG attributes, which cannot hold a var(). */
    function chartColors() {
        if (!palette) {
            const cs = getComputedStyle(document.documentElement);
            palette = Array.from({ length: CHART_COLORS }, (_, i) => cs.getPropertyValue(`--ant-chart-${i + 1}`).trim());
        }
        return palette;
    }

    /** The slices, biggest first, each holding (by ticker, else name) or each
     *  account. Nothing worth nothing is drawn. */
    function allocationRows() {
        const rows = allocBy === 'holding'
            ? allEntries().map((e) => ({ label: e.ticker || e.asset_name || 'Unnamed asset', value: valueOf(e) }))
            : ACCOUNTS.map((a) => ({ label: a.name, value: sum(a.entries, valueOf) }));
        const colors = chartColors();
        return rows
            .filter((r) => r.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((r, i) => ({ ...r, color: colors[i % colors.length] }));
    }

    function shareText(ratio) {
        return ratio > 0 && ratio < 0.005 ? '<1%' : percent(ratio, 0);
    }

    /** `animate` sweeps the ring in on the first paint and on a change of cut;
     *  an edit redraws it in place. */
    function renderAllocation({ animate = false } = {}) {
        document.querySelectorAll('.pf-alloc [data-by]').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.by === allocBy));
        });
        const body = document.getElementById('pf-alloc-body');
        const rows = allocationRows();
        if (!rows.length) {
            body.innerHTML = Ant.empty({ title: 'Nothing to allocate yet', desc: 'Holdings show here once they have a market price.', compact: true });
            return;
        }
        const total = sum(rows, (r) => r.value);
        body.innerHTML = `<div class="pf-alloc-body">
            <div class="pf-alloc-chart" aria-hidden="true"></div>
            <ul class="pf-legend" aria-label="Allocation by ${allocBy}">${rows.map((r) => `
                <li class="pf-legend-row">
                    <span class="pf-legend-dot" style="background: ${escapeHtml(r.color)}"></span>
                    <span class="pf-legend-name">${escapeHtml(r.label)}</span>
                    <span class="pf-legend-value">${escapeHtml(roundMoney(r.value))}</span>
                    <span class="pf-legend-share">${shareText(r.value / total)}</span>
                </li>`).join('')}
            </ul>
        </div>`;
        DonutChart.render(body.querySelector('.pf-alloc-chart'), {
            slices: rows.map((r) => ({ ...r, valueText: roundMoney(r.value) })),
            centerLabel: 'Total',
            centerValue: roundMoney(total),
            animate,
        });
    }

    const refreshAllocationSoon = debounce(() => renderAllocation(), CHART_DELAY_MS);

    // The Graphs palette re-points --ant-chart-*, and the donut baked the old
    // values into its SVG, so drop the cached colours and draw it again.
    window.addEventListener('themechange', () => {
        palette = null;
        renderAllocation();
    });

    // ─── Account cards ──────────────────────────────────────────────────────

    /** One editable cell. Money fields show the user's currency in the value
     *  itself, as every money input in the app does; Amount is a plain count. */
    function inputCellHtml(entry, field) {
        const { col, label } = FIELDS[field];
        let value = entry[field] ?? '';
        let cls = 'pf-input';
        let extra = '';
        if (field === 'ticker') {
            cls += ' pf-input-ticker';
            extra = ' maxlength="20" placeholder="Ticker"';
        } else if (field === 'asset_name') {
            extra = ' maxlength="100" placeholder="Asset name"';
        } else {
            cls += ' pf-input-num';
            extra = ' inputmode="decimal"';
            if (!value) value = '';
            else value = MONEY_FIELDS.has(field)
                ? formatCurrency(value, true, { editable: true })
                : formatDisplay(value, AMOUNT_DP);
            extra += ` placeholder="${MONEY_FIELDS.has(field) ? escapeHtml(formatCurrency(0, true, { editable: true })) : '0'}"`;
        }
        return `<td class="pf-cell pf-edit"><input type="text" class="${cls}" data-field="${field}" data-col="${col}"
            value="${escapeHtml(String(value))}" aria-label="${label}" autocomplete="off"${extra}></td>`;
    }

    function entryRowHtml(entry) {
        const label = entry.asset_name || entry.ticker || 'this asset';
        return `<tr data-entry-id="${entry.id}">
            ${inputCellHtml(entry, 'asset_name')}
            ${inputCellHtml(entry, 'ticker')}
            ${inputCellHtml(entry, 'amount')}
            ${inputCellHtml(entry, 'price')}
            ${inputCellHtml(entry, 'market_price')}
            <td class="pf-cell ant-table-cell-end pf-value">${valueOf(entry) ? escapeHtml(formatCurrency(valueOf(entry))) : ''}</td>
            <td class="pf-cell ant-table-cell-end pf-gain">${changeHtml(valueOf(entry) - costOf(entry), costOf(entry))}</td>
            <td class="pf-col-act">
                <button type="button" class="ant-btn ant-btn-text ant-btn-dangerous ant-btn-sm ant-btn-icon-only" data-act="remove-entry"
                    aria-label="Remove ${escapeHtml(label)}" data-tip="Remove">${Ant.icon('delete')}</button>
            </td>
        </tr>`;
    }

    function totalsRowHtml(account) {
        const value = sum(account.entries, valueOf);
        const cost = sum(account.entries, costOf);
        return `<tr>
            <td colspan="5">Total</td>
            <td class="ant-table-cell-end pf-value">${escapeHtml(formatCurrency(value))}</td>
            <td class="ant-table-cell-end">${changeHtml(value - cost, cost)}</td>
            <td></td>
        </tr>`;
    }

    function holdingsHtml(account) {
        if (!account.entries.length) {
            return `<div class="pf-account-empty">
                ${Ant.empty({ title: 'No assets yet', compact: true })}
                <button type="button" class="ant-btn ant-btn-primary" data-act="add-asset">${Ant.icon('plus')}<span>Add asset</span></button>
            </div>`;
        }
        return `<div class="ant-table-wrapper"><table class="ant-table pf-table">
            <thead><tr>
                <th scope="col">Asset</th>
                <th scope="col" class="pf-col-ticker">Ticker</th>
                <th scope="col" class="pf-col-num ant-table-cell-end">Shares</th>
                <th scope="col" class="pf-col-num ant-table-cell-end">Avg price</th>
                <th scope="col" class="pf-col-num ant-table-cell-end">Market price</th>
                <th scope="col" class="pf-col-num ant-table-cell-end">Value</th>
                <th scope="col" class="pf-col-gain ant-table-cell-end">Gain</th>
                <th class="pf-col-act"><span class="ant-visually-hidden">Remove</span></th>
            </tr></thead>
            <tbody>${account.entries.map(entryRowHtml).join('')}</tbody>
            <tfoot>${totalsRowHtml(account)}</tfoot>
        </table></div>`;
    }

    function titleHtml(account) {
        return `<span class="pf-account-name">${escapeHtml(account.name)}</span><button type="button" class="ant-typography-edit"
            data-act="rename" aria-label="Rename ${escapeHtml(account.name)}" data-tip="Rename">${Ant.icon('edit')}</button>`;
    }

    function accountCardHtml(account) {
        const isFolded = folded.has(account.id);
        const name = escapeHtml(account.name);
        return `<section class="ant-card pf-account${isFolded ? ' is-folded' : ''}" data-account-id="${account.id}"
            aria-label="${name}">
            <div class="ant-card-head"><div class="ant-card-head-wrapper">
                <button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only pf-fold" data-act="fold"
                    aria-expanded="${!isFolded}" aria-label="Show or hide ${name}">${Ant.icon('down')}</button>
                <h2 class="ant-card-head-title">${titleHtml(account)}</h2>
                <div class="ant-card-extra pf-account-actions">
                    <button type="button" class="ant-btn ant-btn-default" data-act="add-asset">${Ant.icon('plus')}<span>Add asset</span></button>
                    <button type="button" class="ant-btn ant-btn-text ant-btn-dangerous ant-btn-icon-only" data-act="delete-account"
                        aria-label="Delete ${name}" data-tip="Delete account">${Ant.icon('delete')}</button>
                </div>
            </div></div>
            <div class="ant-card-body">${holdingsHtml(account)}</div>
        </section>`;
    }

    /** Spreadsheet selection on a card's table. Value and Gain are selectable
     *  and copy as text; the remove buttons' column is not part of the grid. */
    function enableSelection(card) {
        const table = card.querySelector('.pf-table');
        if (table && window.enableCellSelection) enableCellSelection(table, { cellSelector: 'td.pf-cell' });
    }

    function renderAccounts() {
        const host = document.getElementById('pf-accounts');
        if (!ACCOUNTS.length) {
            host.innerHTML = `<div class="ant-card"><div class="ant-card-body pf-accounts-empty">
                ${Ant.empty({ title: 'No accounts yet', desc: 'Add one for each brokerage or retirement account you track.' })}
                <button type="button" class="ant-btn ant-btn-primary" data-act="add-account">${Ant.icon('plus')}<span>Add account</span></button>
            </div></div>`;
            return;
        }
        host.innerHTML = ACCOUNTS.map(accountCardHtml).join('');
        host.querySelectorAll('.pf-account').forEach(enableSelection);
    }

    /** Redraw one account's card in place, after a change to its rows. */
    function rerenderAccount(account) {
        const card = cardFor(account.id);
        if (!card) return;
        card.outerHTML = accountCardHtml(account);
        enableSelection(cardFor(account.id));
    }

    const cardFor = (accountId) => document.querySelector(`.pf-account[data-account-id="${accountId}"]`);

    function setFolded(card, account, isFolded) {
        if (isFolded) folded.add(account.id); else folded.delete(account.id);
        card.classList.toggle('is-folded', isFolded);
        card.querySelector('[data-act="fold"]').setAttribute('aria-expanded', String(!isFolded));
        saveView();
    }

    // ─── Editing a cell ─────────────────────────────────────────────────────
    // A row saves after a pause, carrying every field edited since its last
    // save, so typing a price and then a share count costs one PUT, not two
    // and not one per key. Value, Gain, the account's totals and the cards
    // above update as the user types.

    const flushSoon = new Map();   // entry id -> debounced save for that row

    async function savePending(entryId) {
        const patch = pending.get(entryId);
        if (!patch) return;
        pending.delete(entryId);
        let res = null;
        try {
            res = await apiFetch(`/api/portfolio/entry/${entryId}`, putJson(patch));
        } catch (err) {
            console.error('[portfolio] save failed:', err);
        }
        if (!res?.ok) Ant.message.error("Couldn't save your change — it hasn't been stored.");
    }

    function queueSave(entryId, field, value) {
        pending.set(entryId, { ...pending.get(entryId), [field]: value });
        if (!flushSoon.has(entryId)) flushSoon.set(entryId, debounce(() => savePending(entryId), SAVE_DELAY_MS));
        flushSoon.get(entryId)();
    }

    /** Send whatever has not been saved yet. On leaving the page the request
     *  still goes: it is handed to the main process before the page unloads. */
    function saveEverything() {
        for (const id of [...pending.keys()]) savePending(id);
    }

    /** Drop anything typed past `max` decimal places, keeping the caret where it
     *  was, so the stored value never holds more precision than the cell shows. */
    function clampDecimals(input, max) {
        const dot = input.value.indexOf('.');
        if (dot === -1 || input.value.length - dot - 1 <= max) return;
        const pos = input.selectionStart;
        input.value = input.value.slice(0, dot + 1 + max);
        const caret = Math.min(pos, input.value.length);
        input.setSelectionRange(caret, caret);
    }

    function onCellInput(input) {
        const tr = input.closest('tr[data-entry-id]');
        const card = input.closest('.pf-account');
        const account = findAccount(Number(card.dataset.accountId));
        const entry = account?.entries.find((e) => e.id === Number(tr.dataset.entryId));
        if (!entry) return;
        const field = input.dataset.field;

        if (field === 'asset_name' || field === 'ticker') {
            const text = field === 'ticker' ? input.value.toUpperCase() : input.value;
            entry[field] = text;
            queueSave(entry.id, field, text);
            refreshAllocationSoon();
            return;
        }

        if (field === 'amount') {
            clampDecimals(input, AMOUNT_DP);
            applyCommaFormat(input);
        } else {
            applyCurrencyFormat(input);
        }
        entry[field] = parseFloat(stripCurrencyValue(input.value)) || 0;
        queueSave(entry.id, field, entry[field]);

        tr.querySelector('.pf-value').textContent = valueOf(entry) ? formatCurrency(valueOf(entry)) : '';
        tr.querySelector('.pf-gain').innerHTML = changeHtml(valueOf(entry) - costOf(entry), costOf(entry));
        card.querySelector('tfoot').innerHTML = totalsRowHtml(account);
        renderSummary();
        refreshAllocationSoon();
    }

    /** Enter and the arrows move between cells, as in the app's other grids:
     *  up and down by row, left and right by column. Shift+arrow belongs to the
     *  selection (cellselect.js stops it before it gets here). */
    function onCellKeydown(e) {
        const input = e.target.closest('.pf-input');
        if (!input || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const tr = input.closest('tr');
        let row = tr;
        let col = Number(input.dataset.col);
        if (e.key === 'Enter' || e.key === 'ArrowDown') row = tr.nextElementSibling;
        else if (e.key === 'ArrowUp') row = tr.previousElementSibling;
        else if (e.key === 'ArrowRight') col += 1;
        else if (e.key === 'ArrowLeft') col -= 1;
        else return;
        if (!row || col < 0 || col > LAST_COL) return;
        const next = row.querySelector(`.pf-input[data-col="${col}"]`);
        if (!next) return;
        e.preventDefault();
        next.focus();
        next.select();
    }

    // ─── Accounts: add, rename, delete ──────────────────────────────────────

    async function addAccount(btn) {
        if (Ant.isLoading(btn)) return;
        const res = await Ant.whileLoading(btn, () => apiFetch('/api/portfolio/account', postJson({ name: 'New account' })));
        if (!res?.ok) { Ant.message.error("Couldn't add an account — try again."); return; }
        const { account } = await res.json();
        ACCOUNTS.push(account);
        folded.delete(account.id);
        saveView();
        renderAccounts();
        renderAllocation();
        // Named on arrival: the field is open with its placeholder name selected.
        const card = cardFor(account.id);
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        startRename(card, account);
    }

    /** Ant's editable text: the name becomes a field in place. Enter or leaving
     *  it saves, Escape keeps the old name. */
    function startRename(card, account) {
        const title = card.querySelector('.ant-card-head-title');
        if (title.querySelector('input')) return;
        title.innerHTML = `<input type="text" class="ant-input pf-rename-input" maxlength="100"
            value="${escapeHtml(account.name)}" aria-label="Account name">`;
        const input = title.querySelector('input');
        input.focus();
        input.select();

        let finished = false;
        async function finish(commit) {
            if (finished) return;
            finished = true;
            const name = input.value.trim();
            if (commit && name && name !== account.name) {
                let res = null;
                try {
                    res = await apiFetch(`/api/portfolio/account/${account.id}`, putJson({ name }));
                } catch (err) {
                    console.error('[portfolio] rename failed:', err);
                }
                if (res?.ok) {
                    account.name = name;
                    if (allocBy === 'account') renderAllocation();
                } else {
                    Ant.message.error("Couldn't rename it — try again.");
                }
            }
            // Finished with Enter or Escape, focus is still in the field and goes
            // back to the pencil; finished by clicking away, it stays where it went.
            const keepFocus = title.contains(document.activeElement);
            rerenderAccount(account);
            if (keepFocus) cardFor(account.id)?.querySelector('[data-act="rename"]')?.focus();
        }
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    async function deleteAccount(btn, account) {
        if (Ant.isLoading(btn)) return;
        const ok = await Ant.popconfirm(btn, {
            title: `Delete ${account.name}?`,
            desc: 'Its holdings are removed too. This cannot be undone.',
            okText: 'Delete',
            danger: true,
        });
        if (!ok) return;
        const res = await Ant.whileLoading(btn, () => apiFetch(`/api/portfolio/account/${account.id}`, { method: 'DELETE' }));
        if (!res?.ok) { Ant.message.error("Couldn't delete it — try again."); return; }
        for (const e of account.entries) pending.delete(e.id);
        ACCOUNTS = ACCOUNTS.filter((a) => a.id !== account.id);
        folded.delete(account.id);
        saveView();
        renderAccounts();
        renderSummary();
        renderAllocation();
        Ant.message.success(`Deleted ${account.name}`);
    }

    // ─── Holdings: add, remove ──────────────────────────────────────────────

    /** Add asset: the holding's details in one dialog, created whole in a
     *  single write (POST /api/portfolio/entry with every field). */
    function openAddAsset(account) {
        const money = (field, label, placeholder) => `<label class="ant-form-item">
            <span class="ant-form-item-label">${label}</span>
            <input type="text" class="ant-input pf-num-field" data-f="${field}" inputmode="decimal" autocomplete="off"
                placeholder="${escapeHtml(placeholder)}">
            <span class="ant-form-item-explain" data-explain="${field}"></span>
        </label>`;
        const zero = formatCurrency(0, true, { editable: true });
        const { overlay, close } = Ant.modal({
            title: 'Add asset',
            className: 'pf-add-dialog',
            body: `<div class="pf-form-row">
                    <label class="ant-form-item pf-form-wide">
                        <span class="ant-form-item-label">Asset name</span>
                        <input type="text" class="ant-input" data-f="asset_name" maxlength="100" autocomplete="off"
                            placeholder="e.g. Total Market Index">
                        <span class="ant-form-item-explain" data-explain="asset_name"></span>
                    </label>
                    <label class="ant-form-item">
                        <span class="ant-form-item-label">Ticker</span>
                        <input type="text" class="ant-input pf-ticker-field" data-f="ticker" maxlength="20" autocomplete="off"
                            placeholder="VTSAX">
                    </label>
                </div>
                <div class="pf-form-row">
                    ${money('amount', 'Shares', '0')}
                    ${money('price', 'Average price paid', zero)}
                    ${money('market_price', 'Market price', zero)}
                </div>`,
            footer: `<button type="button" class="ant-btn ant-btn-default confirm-cancel">Cancel</button>
                <button type="button" class="ant-btn ant-btn-primary" id="pf-add-ok">Add</button>`,
        });
        const field = (name) => overlay.querySelector(`[data-f="${name}"]`);
        const okBtn = overlay.querySelector('#pf-add-ok');

        function setError(name, text) {
            const input = field(name);
            if (text) input.setAttribute('aria-invalid', 'true');
            else input.removeAttribute('aria-invalid');
            overlay.querySelector(`[data-explain="${name}"]`).textContent = text;
        }

        overlay.addEventListener('input', (e) => {
            const name = e.target.dataset.f;
            if (!name) return;
            if (name === 'amount') {
                clampDecimals(e.target, AMOUNT_DP);
                applyCommaFormat(e.target);
            } else if (MONEY_FIELDS.has(name)) {
                applyCurrencyFormat(e.target);
            }
            if (overlay.querySelector(`[data-explain="${name}"]`)) setError(name, '');
        });

        async function submit() {
            if (Ant.isLoading(okBtn)) return;
            const assetName = field('asset_name').value.trim();
            const number = (name) => {
                const raw = stripCurrencyValue(field(name).value).trim();
                return raw === '' ? null : parseFloat(raw);
            };
            const values = { amount: number('amount'), price: number('price'), market_price: number('market_price') };
            const problems = {
                asset_name: assetName ? '' : 'Name the asset.',
                amount: values.amount == null || Number.isNaN(values.amount) ? 'How many?' : '',
                price: values.price == null || Number.isNaN(values.price) ? 'What did you pay?' : '',
                market_price: values.market_price == null || Number.isNaN(values.market_price) ? 'Today’s price?' : '',
            };
            for (const [name, text] of Object.entries(problems)) setError(name, text);
            const firstBad = Object.keys(problems).find((name) => problems[name]);
            if (firstBad) { field(firstBad).focus(); return; }

            const res = await Ant.whileLoading(okBtn, () => apiFetch('/api/portfolio/entry', postJson({
                account_id: account.id,
                asset_name: assetName,
                ticker: field('ticker').value.trim().toUpperCase(),
                ...values,
            })));
            if (!res?.ok) { Ant.message.error("Couldn't add it — try again."); return; }
            const { entry } = await res.json();
            account.entries.push(entry);
            close();
            folded.delete(account.id);
            saveView();
            rerenderAccount(account);
            renderSummary();
            renderAllocation();
            Ant.message.success(`Added ${assetName}`);
        }

        okBtn.addEventListener('click', submit);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); submit(); }
        });
        field('asset_name').focus();
    }

    async function removeEntry(btn, account, entryId) {
        if (Ant.isLoading(btn)) return;
        const entry = account.entries.find((e) => e.id === entryId);
        if (!entry) return;
        const label = entry.asset_name || entry.ticker || 'this asset';
        const ok = await Ant.popconfirm(btn, { title: `Remove ${label}?`, okText: 'Remove', danger: true });
        if (!ok) return;
        const res = await Ant.whileLoading(btn, () => apiFetch(`/api/portfolio/entry/${entryId}`, { method: 'DELETE' }));
        if (!res?.ok) { Ant.message.error("Couldn't remove it — try again."); return; }
        pending.delete(entryId);
        account.entries = account.entries.filter((e) => e.id !== entryId);
        rerenderAccount(account);
        renderSummary();
        renderAllocation();
        Ant.message.success(`Removed ${label}`);
    }

    // ─── Wiring ─────────────────────────────────────────────────────────────

    function onAccountsClick(e) {
        if (e.target.closest('[data-act="add-account"]')) { addAccount(e.target.closest('button')); return; }
        const card = e.target.closest('.pf-account');
        if (!card) return;
        const account = findAccount(Number(card.dataset.accountId));
        if (!account) return;
        const btn = e.target.closest('[data-act]');
        const act = btn?.dataset.act;
        if (act === 'fold') setFolded(card, account, !card.classList.contains('is-folded'));
        else if (act === 'rename') startRename(card, account);
        else if (act === 'add-asset') openAddAsset(account);
        else if (act === 'delete-account') deleteAccount(btn, account);
        else if (act === 'remove-entry') removeEntry(btn, account, Number(btn.closest('tr').dataset.entryId));
        // A press anywhere else on the header folds or opens the card.
        else if (!btn && e.target.closest('.ant-card-head') && !e.target.closest('input')) {
            setFolded(card, account, !card.classList.contains('is-folded'));
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        const accounts = document.getElementById('pf-accounts');
        accounts.addEventListener('click', onAccountsClick);
        accounts.addEventListener('input', (e) => {
            if (e.target.matches('.pf-input')) onCellInput(e.target);
        });
        accounts.addEventListener('keydown', onCellKeydown);
        document.getElementById('pf-add-account').addEventListener('click', (e) => addAccount(e.currentTarget));
        document.querySelector('.pf-alloc .ant-segmented').addEventListener('click', (e) => {
            const by = e.target.closest('[data-by]')?.dataset.by;
            if (!by || by === allocBy) return;
            allocBy = by;
            saveView();
            renderAllocation({ animate: true });
        });
        window.addEventListener('pagehide', saveEverything);
        window.addEventListener('currencychange', () => {
            renderSummary();
            renderAccounts();
            renderAllocation();
        });

        let data = null;
        try {
            const res = await apiFetch('/api/portfolio/data');
            if (res.ok) data = await res.json();
            // A locked database (423) is the shell's to handle: it puts its own
            // prompt over the page.
            else if (res.status !== 423) Ant.message.error("Couldn't load your portfolio — try again.");
        } catch (err) {
            console.error('[portfolio] could not load', err);
            Ant.message.error("Couldn't load your portfolio — try again.");
        }
        if (!data) return;
        ACCOUNTS = data.accounts;
        restoreView();
        renderSummary();
        renderAllocation({ animate: true });
        renderAccounts();
    });
}());
