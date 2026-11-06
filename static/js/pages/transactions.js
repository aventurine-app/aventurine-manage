'use strict';

// ─── Transactions page ────────────────────────────────────────────────────────
// The ledger, drawn in Ant Design (ant.css, widgets/ant.js). Above the table,
// six filters: a search over descriptions and notes, a date range, Type,
// Account and Category (each several values at once) and an Amount range. The
// table is one page of the rows they leave, sortable by date, description or
// amount, with a selection column. Two cells edit in place: a row's category
// (a Select over the categories on its side of the ledger) and its note. Four
// dialogs act on rows: Add transaction, Edit (one row field by field, several
// as one change, with "apply to similar"), Import (widgets/txfileimport.js) and
// Export (widgets/txexport.js).
//
// Each row's direction (income, expense or transfer) comes from its category,
// so there is no Type column: the amount's sign and colour carry it.
//
// State:
//   state.rows        — every transaction, newest first (the API's order)
//   state.categories  — the category vocabulary
//   state.accounts    — the Balance Sheet accounts a row can belong to,
//                       [{ key, label }] in column order
//   state.filters     — the six filters; a blank value or an empty list is off.
//                       Mirrored into the query string and the window's view
//                       state on every change (see "Filters in the URL")
//   state.sort        — { key: 'date' | 'description' | 'amount', order:
//                       'ascend' | 'descend' } or { key: null }
//   state.page / state.pageSize — the page of the sorted, filtered rows shown
//   state.selected    — ids of the ticked rows; only rows the filters leave
//                       visible can stay ticked, so a batch action never
//                       reaches a row that is not on screen

(function () {
    const esc = escapeHtml;

    const TYPE_LABELS = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
    // The category groups, in the order every category list shows them.
    const TYPE_GROUPS = [['income', 'Income'], ['expense', 'Expenses'], ['transfer', 'Transfers']];
    const PAGE_SIZES = [25, 50, 100, 200];
    const PAGE_SIZE_KEY = 'tx_page_size';
    // "Apply to similar" and the similar-transactions notice start here.
    const MATCH_DEFAULT = 0.8;

    const EMPTY_FILTERS = () => ({
        name: '', dateFrom: '', dateTo: '', type: [], account: [], category: [], amountMin: '', amountMax: '',
    });

    const state = {
        rows: [],
        categories: [],
        accounts: [],
        filters: EMPTY_FILTERS(),
        sort: { key: 'date', order: 'descend' },
        page: 1,
        pageSize: readPageSize(),
        selected: new Set(),
        loaded: false,
    };

    // The widgets built once at start-up (see init()).
    const ui = { dates: null, type: null, account: null, category: null, pager: null };

    function readPageSize() {
        try {
            const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
            return PAGE_SIZES.includes(n) ? n : 100;
        } catch {
            return 100;
        }
    }

    // ─── API ─────────────────────────────────────────────────────────────────
    // Every write changes the Cash Flow cells the Dashboard draws from the
    // shared Store cache (store.js), so each one drops the 'ie' dataset and the
    // next Dashboard visit refetches.
    function invalidateDerived() {
        if (window.Store) window.Store.invalidate('ie');
    }

    async function api(url, { method = 'GET', body } = {}) {
        const r = await apiFetch(url, body === undefined ? { method } : {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `${method} ${url} failed`);
        if (method !== 'GET') invalidateDerived();
        return data;
    }

    async function load() {
        try {
            const [data, cols] = await Promise.all([
                api('/api/transactions'),
                api('/api/balance/columns').catch(() => []),
            ]);
            state.rows = data.transactions || [];
            state.categories = data.categories || [];
            state.accounts = (cols || []).map((c) => ({ key: c.key, label: c.label }));
        } catch (err) {
            console.error(err);
        }
        state.loaded = true;
    }

    // ─── Lookups and formats ─────────────────────────────────────────────────
    const catById = (id) => state.categories.find((c) => c.id === id) || null;
    const accountLabel = (key) => state.accounts.find((a) => a.key === key)?.label ?? null;
    const label = (t) => t.display_name || t.description || '';
    // Money in or out: income is in; expenses and transfers go out.
    const flowOf = (t) => (t.tx_type === 'income' ? 'in' : 'out');
    const fitsFlow = (catType, flow) => (catType === 'income') === (flow === 'in');
    const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

    /** "+ $3,035.76" for money in, "- $109.49" for money out. */
    const flowMoney = (t) => `${t.tx_type === 'income' ? '+' : '-'} ${formatCurrency(Math.abs(t.amount))}`;

    /** "+$12.00" / "-$5.00", for a net that may go either way. */
    function signedMoney(n) {
        const body = formatCurrency(Math.abs(n));
        if (Math.abs(n) < 0.005) return body;
        return `${n < 0 ? '-' : '+'}${body}`;
    }

    function amountHtml(t) {
        return `<span class="tx-amount tx-amount-${esc(t.tx_type)}">${esc(flowMoney(t))}</span>`;
    }

    // A category tag wears its side of the ledger: expenses red, income green,
    // transfers blue (income and transfers match their amounts' colours).
    const TYPE_HUES = {
        expense: 'var(--ant-color-error)',
        income: 'var(--ant-color-success)',
        transfer: 'var(--ant-color-info-text)',
    };

    /** A category as a tag in its type's hue; no category is the warning tag. */
    function categoryTag(catId) {
        const c = catId == null ? null : catById(catId);
        if (!c || c.locked) return '<span class="ant-tag ant-tag-warning tx-cat-tag">Uncategorized</span>';
        const hue = TYPE_HUES[c.cat_type] ?? Ant.categoryHue(c.key);
        return `<span class="ant-tag ant-tag-hue tx-cat-tag" style="--ant-tag-hue: ${hue}">${esc(c.name)}</span>`;
    }

    function accountTag(key) {
        return `<span class="ant-tag ant-tag-filled tx-acct-tag">${esc(accountLabel(key) ?? 'No account')}</span>`;
    }

    /** The categories a row on `flow`'s side of the ledger can take, as
     *  <optgroup> markup (null flow: every category). */
    function categoryOptionsHtml(flow, selectedId = null) {
        return TYPE_GROUPS
            .filter(([type]) => !flow || fitsFlow(type, flow))
            .map(([type, title]) => {
                const cats = state.categories
                    .filter((c) => c.cat_type === type && !c.locked)
                    .sort((a, b) => a.position - b.position);
                if (!cats.length) return '';
                return `<optgroup label="${title}">${cats.map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
            }).join('');
    }

    const selectHtml = (inner, attrs = '', small = false) =>
        `<span class="ant-select${small ? ' ant-select-sm' : ''}"><select class="ant-select-selector" ${attrs}>${inner}</select><span class="ant-select-arrow">${Ant.icon('down')}</span></span>`;

    function sortRows() {
        state.rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.id - a.id));
    }

    // ─── Filtering, sorting, paging ──────────────────────────────────────────
    const parseAmount = (raw) => {
        const v = parseFloat(String(raw ?? '').replace(/,/g, '').trim());
        return Number.isFinite(v) ? v : null;
    };

    function matches(t) {
        const f = state.filters;
        const q = f.name.trim().toLowerCase();
        if (q && !`${t.description || ''}\n${t.display_name || ''}\n${t.notes || ''}`.toLowerCase().includes(q)) return false;
        if (f.dateFrom && t.date < f.dateFrom) return false;
        if (f.dateTo && t.date > f.dateTo) return false;
        if (f.type.length && !f.type.includes(t.tx_type)) return false;
        if (f.account.length && !f.account.includes(t.account_key ?? 'none')) return false;
        if (f.category.length && !f.category.includes(t.category_id == null ? 'none' : String(t.category_id))) return false;
        const min = parseAmount(f.amountMin);
        const max = parseAmount(f.amountMax);
        if (min !== null && t.amount < min) return false;
        if (max !== null && t.amount > max) return false;
        return true;
    }

    const signed = (t) => (t.tx_type === 'income' ? t.amount : -t.amount);
    const SORTERS = {
        date: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id),
        description: (a, b) => label(a).localeCompare(label(b)),
        amount: (a, b) => signed(a) - signed(b),
    };

    /** The filtered rows in the order on screen. */
    function visibleRows() {
        const rows = state.rows.filter(matches);
        const { key, order } = state.sort;
        if (key) {
            const by = SORTERS[key];
            rows.sort(order === 'ascend' ? by : (a, b) => by(b, a));
        }
        return rows;
    }

    function pageOf(rows) {
        const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
        state.page = Math.min(Math.max(1, state.page), pages);
        const start = (state.page - 1) * state.pageSize;
        return rows.slice(start, start + state.pageSize);
    }

    const filtersActive = () => JSON.stringify(state.filters) !== JSON.stringify(EMPTY_FILTERS());

    // ─── The table ───────────────────────────────────────────────────────────
    const SORT_TIPS = { null: 'Click to sort ascending', ascend: 'Click to sort descending', descend: 'Click to cancel sorting' };

    function sortableTh(key, title, cls) {
        const order = state.sort.key === key ? state.sort.order : null;
        const aria = order ? ` aria-sort="${order === 'ascend' ? 'ascending' : 'descending'}"` : '';
        const caret = (dir, name) => `<span class="${order === dir ? 'ant-table-column-sorter-on' : ''}">${Ant.icon(name)}</span>`;
        return `<th class="${cls} ant-table-column-has-sorters${order ? ' ant-table-column-sort' : ''}"${aria}>
            <button type="button" class="ant-table-column-sorters" data-sort="${key}" data-tip="${SORT_TIPS[order]}">
                <span class="ant-table-column-title">${title}</span>
                <span class="ant-table-column-sorter" aria-hidden="true">${caret('ascend', 'caret-up')}${caret('descend', 'caret-down')}</span>
            </button></th>`;
    }

    function renderHead() {
        document.getElementById('tx-thead').innerHTML = `<tr>
            <th class="ant-table-selection-column tx-col-select"><input type="checkbox" class="ant-checkbox" id="tx-select-all" aria-label="Select every transaction on this page"></th>
            ${sortableTh('date', 'Date', 'tx-col-date')}
            ${sortableTh('description', 'Description', 'tx-col-desc')}
            <th class="tx-col-account">Account</th>
            <th class="tx-col-category">Category</th>
            ${sortableTh('amount', 'Amount', 'tx-col-amount ant-table-cell-end')}
            <th class="tx-col-notes">Notes</th>
        </tr>`;
    }

    function rowHtml(t) {
        const sorted = (key) => (state.sort.key === key ? ' ant-table-column-sort' : '');
        const on = state.selected.has(t.id);
        const name = label(t);
        const raw = t.display_name && t.display_name !== t.description
            ? `<span class="tx-desc-raw ant-typography-secondary" title="${esc(t.description)}">${esc(t.description)}</span>` : '';
        const notes = t.notes || '';
        return `<tr class="tx-row${on ? ' ant-table-row-selected' : ''}" data-id="${t.id}">
            <td class="ant-table-selection-column tx-col-select"><input type="checkbox" class="ant-checkbox tx-row-cb" ${on ? 'checked' : ''}
                aria-label="Select ${esc(name)}, ${esc(formatDate(t.date))}"></td>
            <td class="tx-col-date tx-num${sorted('date')}">${esc(formatDate(t.date))}</td>
            <td class="tx-col-desc${sorted('description')}"><div class="tx-desc">${merchantAvatarHtml(name)}
                <div class="tx-desc-text"><span class="tx-desc-name" title="${esc(name)}">${esc(name)}</span>${raw}</div></div></td>
            <td class="tx-col-account">${accountTag(t.account_key)}</td>
            <td class="tx-col-category"><button type="button" class="tx-cat-btn" data-cat-edit
                aria-label="Category: ${esc(catById(t.category_id)?.name ?? 'Uncategorized')}. Change the category of ${esc(name)}">${categoryTag(t.category_id)}</button></td>
            <td class="tx-col-amount ant-table-cell-end${sorted('amount')}">${amountHtml(t)}</td>
            <td class="tx-col-notes"><div class="tx-notes${notes ? '' : ' tx-notes-empty'}">
                <span class="tx-notes-text ant-typography-secondary" data-notes-edit>${esc(notes)}</span>
                <button type="button" class="ant-typography-edit" data-notes-edit aria-label="Edit the note on ${esc(name)}" data-tip="Edit note">${Ant.icon('edit')}</button>
            </div></td>
        </tr>`;
    }

    function emptyRow() {
        const inner = state.rows.length
            ? Ant.empty({ title: 'No matching transactions', desc: 'Try clearing a filter.', action: { label: 'Clear filters', name: 'tx-clear-filters' } })
            : Ant.empty({ title: 'No transactions yet', desc: 'Import a bank export or add one by hand.', action: { label: 'Import transactions', name: 'tx-import' } });
        return `<tr class="tx-empty-row"><td colspan="7">${inner}</td></tr>`;
    }

    function skeletonRows(n) {
        const cell = (w) => `<td><div class="skeleton skeleton-line sk-w-${w}"></div></td>`;
        return `<tr class="tx-skeleton-row"><td class="tx-col-select"></td>${cell(75)}
            <td class="tx-col-desc"><div class="tx-desc"><div class="skeleton skeleton-circle"></div><div class="skeleton skeleton-line sk-w-60"></div></div></td>
            <td class="tx-col-account"><div class="skeleton skeleton-line sk-w-60"></div></td>${cell(50)}${cell(50)}<td class="tx-col-notes"></td></tr>`.repeat(n);
    }

    /** Redraw everything that follows the rows: the table, the pages, the
     *  select-all box, the batch bar and the filters' Clear. */
    function render() {
        const visible = visibleRows();
        const ids = new Set(visible.map((t) => t.id));
        for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
        const page = pageOf(visible);

        renderHead();
        document.getElementById('tx-tbody').innerHTML = visible.length ? page.map(rowHtml).join('') : emptyRow();

        const pager = document.getElementById('tx-pagination');
        pager.hidden = !visible.length;
        ui.pager.update({ current: state.page, pageSize: state.pageSize, total: visible.length });

        syncSelectionUi();
        syncFilterChrome();
        document.getElementById('tx-export-btn').disabled = !state.rows.length;
    }

    function syncSelectionUi() {
        const page = pageOf(visibleRows());
        const onPage = page.filter((t) => state.selected.has(t.id)).length;
        const all = document.getElementById('tx-select-all');
        if (all) {
            all.checked = page.length > 0 && onPage === page.length;
            all.indeterminate = onPage > 0 && onPage < page.length;
            all.disabled = !page.length;
        }
        const n = state.selected.size;
        const bar = document.getElementById('tx-batch');
        bar.hidden = n === 0;
        if (n) {
            const net = state.rows.filter((t) => state.selected.has(t.id)).reduce((s, t) => s + signed(t), 0);
            document.getElementById('tx-batch-count').textContent = `${n.toLocaleString()} selected`;
            document.getElementById('tx-batch-net').textContent = `Net ${signedMoney(net)}`;
        }
    }

    // ─── Filters ─────────────────────────────────────────────────────────────
    function setFilters(patch) {
        Object.assign(state.filters, patch);
        state.page = 1;
        render();
        syncUrl();
    }

    /** Clear filters follows the filters; the Amount button names its range. */
    function syncFilterChrome() {
        document.getElementById('tx-clear-filters').hidden = !filtersActive();

        const min = parseAmount(state.filters.amountMin);
        const max = parseAmount(state.filters.amountMax);
        const money = (n) => formatCurrency(n, true);
        const text = min !== null && max !== null ? `${money(min)} – ${money(max)}`
            : min !== null ? `Over ${money(min)}`
                : max !== null ? `Under ${money(max)}` : 'Amount';
        document.getElementById('tx-amount-text').textContent = text;
        const btn = document.getElementById('tx-amount-btn');
        const active = text !== 'Amount';
        btn.classList.toggle('ant-btn-default', !active);
        btn.classList.toggle('ant-btn-primary', active);
        btn.classList.toggle('ant-btn-background-ghost', active);
        btn.setAttribute('aria-label', active ? `Amount: ${text}, change` : 'Filter by amount');
    }

    /** Put the filters' values back into their controls (after a reset, a
     *  deep link or a reload). */
    function syncControlsFromState() {
        const f = state.filters;
        document.getElementById('tx-search').value = f.name;
        ui.dates.setValue([f.dateFrom || null, f.dateTo || null]);
        ui.type.setValue(f.type);
        ui.account.setValue(f.account);
        ui.category.setValue(f.category);
    }

    function categoryFilterOptions() {
        const items = [{ value: 'none', label: 'Uncategorized' }];
        for (const [type, title] of TYPE_GROUPS) {
            const cats = state.categories.filter((c) => c.cat_type === type && !c.locked).sort((a, b) => a.position - b.position);
            if (!cats.length) continue;
            items.push({ group: title });
            cats.forEach((c) => items.push({ value: String(c.id), label: c.name, grouped: true }));
        }
        return items;
    }

    const accountFilterOptions = () => [{ value: 'none', label: 'No account' }, ...state.accounts.map((a) => ({ value: a.key, label: a.label }))];

    function datePresets() {
        const now = new Date();
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const today = iso(now);
        const day = (y, m, d) => iso(new Date(y, m, d));
        const y = now.getFullYear();
        const m = now.getMonth();
        const back = weekStart() === 1 ? (now.getDay() + 6) % 7 : now.getDay();
        return [
            { label: 'This week', value: [day(y, m, now.getDate() - back), today] },
            { label: 'This month', value: [day(y, m, 1), today] },
            { label: 'Last 30 days', value: [day(y, m, now.getDate() - 29), today] },
            { label: 'This year', value: [day(y, 0, 1), today] },
            { label: 'Last 12 months', value: [day(y, m - 12, now.getDate() + 1), today] },
        ];
    }

    function weekStart() {
        try { return localStorage.getItem('week_start') === 'monday' ? 1 : 0; } catch { return 0; }
    }

    function openAmountPopover(btn) {
        const f = state.filters;
        const money = (n) => formatCurrency(n, true);
        const body = document.createElement('div');
        body.className = 'tx-amount-pop';
        body.innerHTML = `
            <div class="tx-amount-presets">
                <button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-range=",50">Under ${esc(money(50))}</button>
                <button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-range=",100">Under ${esc(money(100))}</button>
                <button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-range="100,">Over ${esc(money(100))}</button>
            </div>
            <div class="tx-amount-fields">
                <input type="number" class="ant-input" id="tx-amount-min" placeholder="Min" min="0" step="any" aria-label="Minimum amount" value="${esc(f.amountMin)}">
                <span aria-hidden="true">–</span>
                <input type="number" class="ant-input" id="tx-amount-max" placeholder="Max" min="0" step="any" aria-label="Maximum amount" value="${esc(f.amountMax)}">
            </div>
            <div class="tx-amount-actions">
                <button type="button" class="ant-btn ant-btn-text ant-btn-sm" data-clear${f.amountMin || f.amountMax ? '' : ' disabled'}>Clear</button>
                <button type="button" class="ant-btn ant-btn-primary ant-btn-sm" data-apply>Apply</button>
            </div>`;
        const pop = Ant.popover(btn, { title: 'Amount', content: body, className: 'tx-amount-popover' });
        if (!pop) return;
        const apply = (min, max) => {
            pop.close();
            btn.focus();
            setFilters({ amountMin: min, amountMax: max });
        };
        body.addEventListener('click', (e) => {
            const preset = e.target.closest('[data-range]');
            if (preset) {
                const [min, max] = preset.dataset.range.split(',');
                apply(min, max);
            } else if (e.target.closest('[data-clear]')) {
                apply('', '');
            } else if (e.target.closest('[data-apply]')) {
                apply(body.querySelector('#tx-amount-min').value.trim(), body.querySelector('#tx-amount-max').value.trim());
            }
        });
        body.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) {
                e.preventDefault();
                body.querySelector('[data-apply]').click();
            }
        });
        body.querySelector('#tx-amount-min').focus();
    }

    function initFilters() {
        const search = document.getElementById('tx-search');
        search.addEventListener('input', () => setFilters({ name: search.value }));
        document.getElementById('tx-search-clear').addEventListener('click', () => {
            search.value = '';
            search.focus();
            setFilters({ name: '' });
        });

        ui.dates = Ant.rangePicker(document.getElementById('tx-dates'), {
            presets: datePresets(),
            format: formatDate,
            placeholder: ['From', 'To'],
            ariaLabel: 'Dates',
            weekStart: weekStart(),
            onChange: ([from, to]) => setFilters({ dateFrom: from || '', dateTo: to || '' }),
        });
        ui.type = Ant.multiSelect(document.getElementById('tx-filter-type'), {
            placeholder: 'Type',
            ariaLabel: 'Filter by type',
            options: Object.entries(TYPE_LABELS).map(([value, text]) => ({ value, label: text })),
            onChange: (v) => setFilters({ type: v }),
        });
        ui.account = Ant.multiSelect(document.getElementById('tx-filter-account'), {
            placeholder: 'Account',
            ariaLabel: 'Filter by account',
            options: accountFilterOptions(),
            onChange: (v) => setFilters({ account: v }),
        });
        ui.category = Ant.multiSelect(document.getElementById('tx-filter-category'), {
            placeholder: 'Category',
            ariaLabel: 'Filter by category',
            search: true,
            options: categoryFilterOptions(),
            onChange: (v) => setFilters({ category: v }),
        });

        document.getElementById('tx-amount-btn').addEventListener('click', (e) => openAmountPopover(e.currentTarget));
        document.getElementById('tx-clear-filters').addEventListener('click', clearFilters);
    }

    function clearFilters() {
        state.filters = EMPTY_FILTERS();
        state.page = 1;
        syncControlsFromState();
        render();
        syncUrl();
    }

    /** After a reload: drop picks that name a category or an account that is
     *  gone, and give the Selects the current lists. */
    function reconcileFilters() {
        const f = state.filters;
        f.category = f.category.filter((c) => c === 'none' || catById(Number(c)));
        f.account = f.account.filter((a) => a === 'none' || accountLabel(a) !== null);
        ui.category.setOptions(categoryFilterOptions());
        ui.account.setOptions(accountFilterOptions());
        syncControlsFromState();
    }

    // ─── Filters in the URL ──────────────────────────────────────────────────
    // The filters are written to two places, because the two ways back to this
    // page differ. The query string belongs to one history entry, so it is what
    // Back, Forward and a refresh restore. The window's view state
    // (core/viewstate.js) belongs to none, so it is what a fresh arrival from
    // the sidebar (a bare /transactions) restores. Both hold the same string.
    //
    // Other pages link in pre-filtered: Cash Flow and Budgets send
    // ?year=&month=&cat=<category key>, Recurring sends ?name=<merchant term>.
    // Those are explicit requests and beat anything remembered. Values travel
    // as stable keys and are checked against the live vocabulary on the way
    // in, so one naming something deleted since simply drops out.
    //
    // replaceState, never pushState: the search writes on every keystroke,
    // and narrowing a filter changes what is shown, not where you are.
    const URL_PARAMS = ['year', 'month', 'from', 'to', 'name', 'type', 'cat', 'acct', 'min', 'max', 'page'];
    const VIEW_KEY = 'transactions.filters';
    const csv = (raw) => (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isoParam = (raw) => (/^\d{4}-\d{2}-\d{2}$/.test(raw || '') ? raw : '');

    function filtersToQuery() {
        const f = state.filters;
        const params = new URLSearchParams();
        const put = (key, value) => { if (value) params.set(key, value); };
        put('from', f.dateFrom);
        put('to', f.dateTo);
        put('name', f.name.trim());
        put('min', String(f.amountMin).trim());
        put('max', String(f.amountMax).trim());
        put('type', f.type.join(','));
        put('cat', f.category.map((v) => (v === 'none' ? 'none' : catById(Number(v))?.key || '')).filter(Boolean).join(','));
        put('acct', f.account.join(','));
        if (state.page > 1) put('page', String(state.page));
        return params.toString();
    }

    function syncUrl() {
        const q = filtersToQuery();
        try {
            history.replaceState(null, '', q ? `${location.pathname}?${q}` : location.pathname);
        } catch { /* the filters still apply to the page in front of us */ }
        // An empty string records that the filters were cleared.
        window.ViewState?.set(VIEW_KEY, q);
    }

    /** The filters this page opens under: the query string when it says
     *  anything, else the remembered set. Runs once the vocabulary is in. */
    function applyUrlFilters() {
        let params;
        try { params = new URLSearchParams(location.search); } catch { return; }
        if (!URL_PARAMS.some((k) => params.has(k))) {
            const remembered = window.ViewState?.get(VIEW_KEY);
            if (!remembered) return;
            try { params = new URLSearchParams(remembered); } catch { return; }
            if (!URL_PARAMS.some((k) => params.has(k))) return;
        }
        const f = state.filters;
        f.name = (params.get('name') || '').trim();
        f.amountMin = (params.get('min') || '').trim();
        f.amountMax = (params.get('max') || '').trim();

        f.dateFrom = isoParam(params.get('from'));
        f.dateTo = isoParam(params.get('to'));
        if (!f.dateFrom && !f.dateTo) {
            const year = parseInt(params.get('year'), 10);
            if (Number.isInteger(year) && year > 0) {
                // A single month when one was sent; day 0 of the next month is
                // the last day of this one.
                const month = parseInt(params.get('month'), 10);
                const scoped = Number.isInteger(month) && month >= 1 && month <= 12;
                const pad = (n) => String(n).padStart(2, '0');
                f.dateFrom = scoped ? `${year}-${pad(month)}-01` : `${year}-01-01`;
                f.dateTo = scoped ? `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}` : `${year}-12-31`;
            }
        }

        f.type = csv(params.get('type')).filter((t) => Object.hasOwn(TYPE_LABELS, t));
        // The locked uncat_* buckets are NULL-category sums, not assignments,
        // so the Cash Flow "Uncategorized" band arrives as the 'none' pick.
        f.category = [...new Set(csv(params.get('cat')).map((key) => {
            if (key === 'none') return 'none';
            const cat = state.categories.find((c) => c.key === key);
            return cat ? (cat.locked ? 'none' : String(cat.id)) : '';
        }).filter(Boolean))];
        f.account = csv(params.get('acct')).filter((a) => a === 'none' || accountLabel(a) !== null);

        const page = parseInt(params.get('page'), 10);
        state.page = Number.isInteger(page) && page > 0 ? page : 1;
        syncControlsFromState();
        render();
        // Rewrite the address from state, so a shorthand link becomes the full
        // form and coming back to it restores the same view.
        syncUrl();
    }

    // ─── Selection ───────────────────────────────────────────────────────────
    function toggleRow(id, on) {
        if (on) state.selected.add(id);
        else state.selected.delete(id);
        document.querySelector(`.tx-row[data-id="${id}"]`)?.classList.toggle('ant-table-row-selected', on);
        syncSelectionUi();
    }

    function togglePage(on) {
        for (const t of pageOf(visibleRows())) {
            if (on) state.selected.add(t.id);
            else state.selected.delete(t.id);
        }
        render();
    }

    async function deleteSelected() {
        const ids = [...state.selected];
        if (!ids.length) return;
        const ok = await Ant.confirm({
            title: `Delete ${plural(ids.length, 'transaction')}?`,
            content: '<p>They are removed from the ledger and every report built from it. This cannot be undone.</p>',
            okText: 'Delete',
            danger: true,
        });
        if (!ok) return;
        try {
            await api('/api/transactions/bulk-delete', { method: 'POST', body: { ids } });
        } catch {
            Ant.message.error(`The ${plural(ids.length, 'transaction')} could not be deleted.`);
            return;
        }
        const gone = new Set(ids);
        state.rows = state.rows.filter((t) => !gone.has(t.id));
        state.selected.clear();
        render();
        Ant.message.success(`Deleted ${plural(ids.length, 'transaction')}`);
    }

    // ─── Editing in place: category and note ─────────────────────────────────
    const rowById = (id) => state.rows.find((t) => t.id === id);

    function replaceRow(saved) {
        state.rows = state.rows.map((t) => (t.id === saved.id ? saved : t));
    }

    /** Redraw, then put the focus back on `selector` inside row `id` if that
     *  row is still on the page. */
    function renderKeepingFocus(id, selector) {
        render();
        document.querySelector(`.tx-row[data-id="${id}"] ${selector}`)?.focus();
    }

    // Category: the tag turns into a Select of the categories on the row's
    // side of the ledger, already open. Picking one saves; leaving it, or
    // Escape, puts the tag back.
    function editCategory(td, t) {
        const flow = flowOf(t);
        td.innerHTML = selectHtml(
            `${t.category_id == null ? '<option value="" selected disabled hidden>Choose a category</option>' : ''}${categoryOptionsHtml(flow, t.category_id)}`,
            `aria-label="Category of ${esc(label(t))}"`, true);
        const sel = td.querySelector('select');
        let done = false;
        // Escape hands the focus back to the tag; leaving for somewhere else
        // keeps it where it went.
        const restore = (refocus) => {
            if (done) return;
            done = true;
            if (refocus) renderKeepingFocus(t.id, '.tx-cat-btn');
            else render();
        };
        sel.addEventListener('change', async () => {
            if (done) return;
            done = true;
            const catId = Number(sel.value);
            const was = t.category_id;
            try {
                const { transaction } = await api(`/api/transactions/${t.id}`, { method: 'PUT', body: { category_id: catId } });
                replaceRow(transaction);
            } catch {
                Ant.message.error('The category could not be saved.');
            }
            renderKeepingFocus(t.id, '.tx-cat-btn');
            if (was == null) offerSimilar(rowById(t.id) || t, catId);
        });
        sel.addEventListener('blur', () => restore(false));
        sel.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                restore(true);
            }
        });
        sel.focus();
        try { sel.showPicker(); } catch { /* the Select is focused; Space opens it */ }
    }

    // Note: Typography's editable text. A text area takes the note's place;
    // Enter saves, Shift+Enter is a new line, Escape cancels, leaving saves.
    function editNotes(td, t) {
        td.innerHTML = `<div class="ant-typography-edit-content">
            <textarea class="ant-input" rows="1" maxlength="500" aria-label="Note on ${esc(label(t))}">${esc(t.notes || '')}</textarea>
            <span class="ant-typography-edit-content-confirm" aria-hidden="true">${Ant.icon('enter')}</span></div>`;
        const area = td.querySelector('textarea');
        const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight + 2}px`; };
        let done = false;
        /** `refocus`: Enter or Escape ended it, so the focus goes back to the
         *  pencil; leaving for somewhere else keeps it where it went. */
        async function finish(save, refocus) {
            if (done) return;
            done = true;
            const notes = area.value.trim();
            if (save && notes !== (t.notes || '')) {
                try {
                    const { transaction } = await api(`/api/transactions/${t.id}`, { method: 'PUT', body: { notes } });
                    replaceRow(transaction);
                } catch {
                    Ant.message.error('The note could not be saved.');
                }
            }
            if (refocus) renderKeepingFocus(t.id, 'button[data-notes-edit]');
            else render();
        }
        area.addEventListener('input', fit);
        area.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                finish(true, true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish(false, true);
            }
        });
        area.addEventListener('blur', () => finish(true, false));
        fit();
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
    }

    // ─── Similar transactions ────────────────────────────────────────────────
    // After a row that had no category is given one (in the table or in Add
    // transaction), the uncategorized rows whose description is close to it
    // are offered the same category in a notification: one press applies it
    // to all of them, and remembers each description.
    async function offerSimilar(t, catId) {
        const cat = catById(catId);
        if (!cat || !t.description) return;
        let hits = [];
        try {
            const params = new URLSearchParams({ description: t.description, threshold: String(MATCH_DEFAULT), exclude_id: String(t.id) });
            hits = (await api(`/api/transactions/similar?${params}`)).transactions || [];
        } catch {
            return;   // an offer, not a step; nothing to report
        }
        hits = hits.filter((x) => fitsFlow(cat.cat_type, flowOf(x)));
        if (!hits.length) return;
        const names = [...new Set(hits.map(label))];
        Ant.notification({
            key: `similar-${t.id}`,
            title: `${plural(hits.length, 'similar transaction')} ${hits.length === 1 ? 'is' : 'are'} uncategorized`,
            description: `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
            icon: 'thunderbolt',
            iconClass: 'tx-similar-icon',
            duration: 8000,
            actions: [
                { label: 'Not now' },
                {
                    label: `Make them ${cat.name}`,
                    primary: true,
                    onClick: async () => {
                        const ids = hits.map((x) => x.id);
                        try {
                            await api('/api/transactions/categorize-similar', { method: 'POST', body: { ids, category_id: cat.id } });
                        } catch {
                            Ant.message.error('The similar transactions could not be categorized.');
                            return;
                        }
                        const set = new Set(ids);
                        state.rows = state.rows.map((x) => (set.has(x.id) && x.category_id == null
                            ? { ...x, category_id: cat.id, tx_type: cat.cat_type } : x));
                        render();
                        Ant.message.success(`${plural(ids.length, 'transaction')} now in ${cat.name}`);
                    },
                },
            ],
        });
    }

    // ─── Add transaction ─────────────────────────────────────────────────────
    // Money out or in first, since it decides which categories fit; then the
    // date and amount, the description (with the ledger's descriptions offered
    // as it is typed), the account and the category, and a note. While the
    // category is untouched, the description's learned or recognized category
    // fills it in, tagged as such.
    function openAddDialog() {
        const today = typeof todayIso === 'function' ? todayIso() : new Date().toISOString().slice(0, 10);
        const descriptions = [...new Set(state.rows.map((t) => t.description).filter(Boolean))].sort();
        const body = `
            <div class="ant-segmented ant-segmented-block tx-flow" role="group" aria-label="Direction">
                <button type="button" class="ant-segmented-item" data-flow="out" aria-pressed="true">Money out</button>
                <button type="button" class="ant-segmented-item" data-flow="in" aria-pressed="false">Money in</button>
            </div>
            <div class="tx-form-row">
                <label class="ant-form-item"><span class="ant-form-item-label">Date</span>
                    <input type="date" class="ant-input" data-f="date" value="${today}" required>
                    <span class="ant-form-item-explain" data-explain="date"></span></label>
                <label class="ant-form-item"><span class="ant-form-item-label">Amount</span>
                    <span class="ant-input-affix-wrapper"><span class="ant-input-prefix ant-input-prefix-text">${esc(window.CURRENCY_SYMBOL || '$')}</span>
                    <input type="text" class="ant-input" data-f="amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></span>
                    <span class="ant-form-item-explain" data-explain="amount"></span></label>
            </div>
            <label class="ant-form-item"><span class="ant-form-item-label">Description</span>
                <input type="text" class="ant-input" data-f="description" maxlength="200" placeholder="e.g. GROCERIES" spellcheck="false">
                <span class="ant-form-item-explain" data-explain="description"></span></label>
            <div class="tx-form-row">
                <label class="ant-form-item"><span class="ant-form-item-label">Account</span>
                    ${selectHtml(`<option value="">No account</option>${state.accounts.map((a, i) => `<option value="${esc(a.key)}"${i === 0 ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}`, 'data-f="account"')}</label>
                <label class="ant-form-item"><span class="ant-form-item-label">Category
                    <span class="ant-tag ant-tag-processing tx-suggest-tag" hidden></span></span>
                    ${selectHtml('', 'data-f="category"')}</label>
            </div>
            <label class="ant-form-item"><span class="ant-form-item-label">Notes</span>
                <textarea class="ant-input tx-notes-field" data-f="notes" rows="1" maxlength="500"></textarea></label>`;
        const footer = `<button type="button" class="ant-btn ant-btn-default" data-act="cancel">Cancel</button>
            <button type="button" class="ant-btn ant-btn-primary" data-act="add">Add</button>`;
        const { dialog, close } = Ant.modal({ title: 'Add transaction', body, footer, width: 520, className: 'tx-form-modal' });
        const $ = (sel) => dialog.querySelector(sel);
        const field = (name) => $(`[data-f="${name}"]`);
        let flow = 'out';
        let touched = false;     // the user picked a category themselves
        let suggestion = null;   // { category_id, how } for the description now typed
        let asked = '';

        const fillCategories = () => {
            const sel = field('category');
            const keep = Number(sel.value) || null;
            sel.innerHTML = `<option value="">Uncategorized</option>${categoryOptionsHtml(flow, keep)}`;
            if (keep && !sel.querySelector(`option[value="${keep}"]`)) sel.value = '';
            syncSuggestTag();
        };
        const syncSuggestTag = () => {
            const tag = $('.tx-suggest-tag');
            const shown = !!suggestion && Number(field('category').value) === suggestion.category_id;
            tag.hidden = !shown;
            tag.textContent = suggestion?.how === 'rule' ? 'Learned' : 'Suggested';
            tag.dataset.tip = suggestion?.how === 'rule' ? 'From a category you gave this description before' : 'Recognized from the description';
        };

        // The suggestion follows the description, a moment after typing stops.
        const suggest = debounce(async () => {
            const text = field('description').value.trim();
            const key = `${flow}|${text}`;
            if (key === asked) return;
            asked = key;
            suggestion = null;
            if (text.length > 2) {
                try {
                    const params = new URLSearchParams({ description: text, flow });
                    suggestion = (await api(`/api/transactions/suggest?${params}`)).suggestion;
                } catch { /* no suggestion; the field stays as it is */ }
                if (asked !== key) return;
            }
            if (!touched) field('category').value = suggestion ? String(suggestion.category_id) : '';
            syncSuggestTag();
        }, 250);

        fillCategories();
        Ant.autocomplete(field('description'), {
            source: (q) => {
                const needle = q.trim().toLowerCase();
                return needle ? descriptions.filter((d) => d.toLowerCase().includes(needle)) : [];
            },
        });
        field('description').addEventListener('input', suggest);
        field('category').addEventListener('change', () => { touched = true; syncSuggestTag(); });
        $('.tx-flow').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-flow]');
            if (!btn || btn.dataset.flow === flow) return;
            flow = btn.dataset.flow;
            $('.tx-flow').querySelectorAll('[data-flow]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
            fillCategories();
            suggest();
        });
        const notes = field('notes');
        notes.addEventListener('input', () => { notes.style.height = 'auto'; notes.style.height = `${notes.scrollHeight + 2}px`; });

        function explain(name, text) {
            const el = $(`[data-explain="${name}"]`);
            el.textContent = text;
            field(name).setAttribute('aria-invalid', String(!!text));
        }

        async function submit(btn) {
            if (Ant.isLoading(btn)) return;
            const date = field('date').value;
            const amount = parseAmount(field('amount').value);
            const description = field('description').value.trim();
            explain('date', date ? '' : 'Date is required.');
            explain('amount', amount === null ? 'Enter an amount.' : amount <= 0 ? 'The amount has to be more than zero.' : '');
            explain('description', description ? '' : 'Describe the transaction.');
            const bad = dialog.querySelector('[aria-invalid="true"]');
            if (bad) { bad.focus(); return; }
            const catRaw = field('category').value;
            const payload = {
                date, description, amount,
                tx_type: flow === 'in' ? 'income' : 'expense',
                category_id: catRaw ? Number(catRaw) : null,
                account_key: field('account').value || null,
                notes: notes.value.trim(),
            };
            const saved = await Ant.whileLoading(btn, () => api('/api/transactions', { method: 'POST', body: payload }));
            if (!saved) {
                Ant.message.error('The transaction could not be added.');
                return;
            }
            close();
            state.rows.unshift(saved.transaction);
            sortRows();
            render();
            Ant.message.success(`Added ${description}`);
            if (saved.transaction.category_id != null) offerSimilar(saved.transaction, saved.transaction.category_id);
        }

        dialog.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'cancel') close();
            if (act === 'add') submit(e.target.closest('[data-act]'));
        });
        // Enter in a one-line field adds, unless it just picked a suggestion.
        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.defaultPrevented && e.target.matches('input')) {
                e.preventDefault();
                submit($('[data-act="add"]'));
            }
        });
        field('amount').focus();
    }

    // ─── Edit ────────────────────────────────────────────────────────────────
    // A wizard in one Modal. Step 1 edits: one row's date, amount and
    // description, and for any number of rows the account, the category and
    // the note, each starting at "Keep current" so only what is set changes.
    // The rows are listed under the fields as they will read, the changed
    // values in the primary colour. With a category set, "Apply to similar
    // transactions" adds a step that finds rows with close descriptions (the
    // match strength is a slider) and ticks them all to take the category too.
    // The last step says what will change, behind one Save.
    const KEEP = '__keep';

    function openEditDialog(ids) {
        const rows = state.rows.filter((t) => ids.includes(t.id));
        if (!rows.length) return;
        const single = rows.length === 1 ? rows[0] : null;
        const flows = new Set(rows.map(flowOf));
        const flow = flows.size === 1 ? [...flows][0] : null;
        const edit = single ? { date: single.date, description: single.description, amount: single.amount } : {};
        let step = 0;
        let cascade = false;
        let strength = MATCH_DEFAULT;
        let candidates = [];   // [{ t, score }]
        let picked = new Set();
        let saving = false;
        let fetchToken = 0;

        const keepLabel = 'Keep current';
        const fieldsHtml = `
            <div class="tx-edit-grid">
                ${single ? `
                <label class="ant-form-item"><span class="ant-form-item-label">Date</span>
                    <input type="date" class="ant-input" data-e="date" value="${esc(single.date)}" required></label>
                <label class="ant-form-item"><span class="ant-form-item-label">Amount</span>
                    <span class="ant-input-affix-wrapper"><span class="ant-input-prefix ant-input-prefix-text">${esc(window.CURRENCY_SYMBOL || '$')}</span>
                    <input type="text" class="ant-input" data-e="amount" inputmode="decimal" autocomplete="off" value="${Number(single.amount).toFixed(2)}"></span>
                    <span class="ant-form-item-explain" data-explain="amount"></span></label>
                <label class="ant-form-item tx-edit-wide"><span class="ant-form-item-label">Description</span>
                    <input type="text" class="ant-input" data-e="description" maxlength="200" value="${esc(single.description)}" spellcheck="false">
                    <span class="ant-form-item-explain" data-explain="description"></span></label>` : ''}
                <label class="ant-form-item"><span class="ant-form-item-label">Account</span>
                    ${selectHtml(`<option value="${KEEP}">${keepLabel}</option><option value="">No account</option>${state.accounts.map((a) => `<option value="${esc(a.key)}">${esc(a.label)}</option>`).join('')}`, 'data-e="account"')}</label>
                <label class="ant-form-item"><span class="ant-form-item-label">Category</span>
                    ${selectHtml(flow
                        ? `<option value="${KEEP}">${keepLabel}</option><option value="none">Uncategorized</option>${categoryOptionsHtml(flow)}`
                        : '<option value="">Mixed money in and out</option>', `data-e="category"${flow ? '' : ' disabled'}`)}</label>
                <label class="ant-form-item tx-edit-wide"><span class="ant-form-item-label">Notes</span>
                    <input type="text" class="ant-input" data-e="notes" maxlength="500" placeholder="${single ? '' : keepLabel}" value="${esc(single ? single.notes || '' : '')}"></label>
            </div>
            <div class="ant-table-wrapper tx-edit-preview">
                <table class="ant-table ant-table-small ant-table-fixed">
                    <thead><tr><th class="tx-p-date">Date</th><th>Description</th><th class="tx-p-acct">Account</th><th class="tx-p-cat">Category</th><th class="tx-p-amt ant-table-cell-end">Amount</th></tr></thead>
                    <tbody></tbody>
                </table>
            </div>`;

        const { dialog, close, setTitle } = Ant.modal({
            title: '',
            width: 860,
            className: 'tx-wizard',
            canClose: () => !saving,
            body: `<div class="tx-steps"></div><div class="tx-step" data-step="edit">${fieldsHtml}</div>
                <div class="tx-step" data-step="match" hidden></div><div class="tx-step" data-step="review" hidden></div>`,
            footer: `<label class="ant-checkbox-wrapper tx-cascade"><input type="checkbox" class="ant-checkbox" disabled>Apply to similar transactions</label>
                <div class="tx-modal-buttons">
                    <button type="button" class="ant-btn ant-btn-default" data-act="back" hidden>Back</button>
                    <button type="button" class="ant-btn ant-btn-default" data-act="cancel">Cancel</button>
                    <button type="button" class="ant-btn ant-btn-primary" data-act="next">Next</button>
                </div>`,
        });
        const $ = (sel) => dialog.querySelector(sel);
        const control = (name) => $(`[data-e="${name}"]`);
        const cascadeBox = $('.tx-cascade input');
        const nextBtn = $('[data-act="next"]');

        const target = () => (edit.category && edit.category !== 'none' ? Number(edit.category) : null);
        const stepNames = () => (cascade && target() ? ['Edit', 'Find similar', 'Review'] : ['Edit', 'Review']);

        /** Read the controls into `edit`; undefined means keep. */
        function readControls() {
            if (single) {
                edit.date = control('date').value || single.date;
                edit.description = control('description').value.trim();
                edit.amount = parseAmount(control('amount').value);
            }
            const acct = control('account').value;
            edit.account = acct === KEEP ? undefined : acct;
            const cat = control('category').value;
            edit.category = !flow || cat === KEEP ? undefined : cat;
            const notes = control('notes').value.trim();
            edit.notes = single ? notes : (notes || undefined);
        }

        /** Each row's changes as the API's fields, only where they differ. */
        function changes() {
            const out = [];
            for (const t of rows) {
                const patch = {};
                if (single) {
                    if (edit.date && edit.date !== t.date) patch.date = edit.date;
                    if (edit.description && edit.description !== t.description) patch.description = edit.description;
                    if (edit.amount !== null && edit.amount > 0 && Math.abs(edit.amount - t.amount) > 0.0001) patch.amount = edit.amount;
                }
                if (edit.account !== undefined && (edit.account || null) !== (t.account_key ?? null)) patch.account_key = edit.account || null;
                if (edit.category !== undefined) {
                    const id = edit.category === 'none' ? null : Number(edit.category);
                    if (id !== t.category_id) patch.category_id = id;
                }
                if (edit.notes !== undefined && edit.notes !== (t.notes || '')) patch.notes = edit.notes;
                if (Object.keys(patch).length) out.push({ id: t.id, patch, t });
            }
            return out;
        }

        function validSingle() {
            if (!single) return true;
            const amountBad = edit.amount === null || edit.amount <= 0;
            $('[data-explain="amount"]').textContent = amountBad ? 'The amount has to be more than zero.' : '';
            control('amount').setAttribute('aria-invalid', String(amountBad));
            const descBad = !edit.description;
            $('[data-explain="description"]').textContent = descBad ? 'Describe the transaction.' : '';
            control('description').setAttribute('aria-invalid', String(descBad));
            return !amountBad && !descBad;
        }

        // The rows under the fields, as they will read after saving.
        function renderPreview() {
            const changed = (on, html) => (on ? `<span class="tx-changed">${html}</span>` : html);
            $('.tx-edit-preview tbody').innerHTML = rows.map((t) => {
                const date = single ? edit.date : t.date;
                const desc = single && edit.description ? edit.description : label(t);
                const acct = edit.account !== undefined ? edit.account || null : t.account_key;
                const cat = edit.category !== undefined ? (edit.category === 'none' ? null : Number(edit.category)) : t.category_id;
                const amount = single && edit.amount > 0 ? edit.amount : t.amount;
                return `<tr>
                    <td class="tx-num">${changed(date !== t.date, esc(formatDate(date)))}</td>
                    <td class="ant-table-cell-ellipsis" title="${esc(desc)}">${changed(single && edit.description !== t.description, esc(desc))}</td>
                    <td>${edit.account !== undefined ? changed(true, esc(accountLabel(acct) ?? 'No account')) : accountTag(acct)}</td>
                    <td>${categoryTag(cat)}</td>
                    <td class="ant-table-cell-end">${amountHtml({ ...t, amount })}</td></tr>`;
            }).join('');
        }

        function syncEditStep() {
            readControls();
            renderPreview();
            cascadeBox.disabled = !target();
            if (!target()) cascadeBox.checked = false;
            cascade = cascadeBox.checked;
            nextBtn.disabled = !(changes().length || (cascade && target()));
            renderSteps();
        }

        function renderSteps() {
            $('.tx-steps').innerHTML = Ant.steps(stepNames(), step);
        }

        function showStep(next) {
            step = next;
            const name = stepNames()[step];
            dialog.querySelectorAll('.tx-step').forEach((el) => {
                el.hidden = el.dataset.step !== { Edit: 'edit', 'Find similar': 'match', Review: 'review' }[name];
            });
            setTitle(step === 0 ? `Edit ${plural(rows.length, 'transaction')}` : name === 'Find similar' ? 'Find similar transactions' : 'Review changes');
            $('.tx-cascade').hidden = step !== 0;
            $('[data-act="back"]').hidden = step === 0;
            $('[data-act="cancel"]').hidden = step !== 0;
            nextBtn.textContent = name === 'Review' ? 'Save all changes' : 'Next';
            nextBtn.disabled = false;
            renderSteps();
            if (name === 'Edit') syncEditStep();
            if (name === 'Find similar') renderMatchStep();
            if (name === 'Review') renderReview();
        }

        // ── Find similar ──
        function renderMatchStep() {
            const el = $('[data-step="match"]');
            if (!el.firstElementChild) {
                el.innerHTML = `
                    <div class="tx-match-strength">
                        <label class="ant-typography-strong" for="tx-match-slider">Match strength</label>
                        <span class="ant-typography-secondary">Loose</span>
                        <input type="range" class="ant-slider" id="tx-match-slider" min="0.5" max="1" step="0.05" value="${strength}">
                        <span class="ant-typography-secondary">Exact</span>
                        <span class="ant-tag tx-num" id="tx-match-value" aria-live="polite"></span>
                    </div>
                    <div class="tx-match-target"></div>
                    <div class="ant-table-wrapper tx-match-table"></div>`;
                const slider = el.querySelector('#tx-match-slider');
                Ant.slider(slider);
                const refetch = debounce(fetchMatches, 250);
                slider.addEventListener('input', () => {
                    strength = Number(slider.value);
                    el.querySelector('#tx-match-value').textContent = `${Math.round(strength * 100)}%`;
                    refetch();
                });
                el.addEventListener('change', (e) => {
                    if (e.target.matches('.tx-match-all')) {
                        picked = e.target.checked ? new Set(candidates.map((c) => c.t.id)) : new Set();
                        renderMatches();
                    } else if (e.target.matches('.tx-match-cb')) {
                        const id = Number(e.target.closest('tr').dataset.id);
                        if (e.target.checked) picked.add(id);
                        else picked.delete(id);
                        e.target.closest('tr').classList.toggle('ant-table-row-selected', e.target.checked);
                        syncMatchAll();
                    }
                });
            }
            el.querySelector('#tx-match-value').textContent = `${Math.round(strength * 100)}%`;
            el.querySelector('.tx-match-target').innerHTML = `Ticked transactions will become ${categoryTag(target())}`;
            fetchMatches();
        }

        async function fetchMatches() {
            const token = ++fetchToken;
            const cat = catById(target());
            const table = $('.tx-match-table');
            table.classList.add('tx-loading');
            const exclude = rows.map((t) => t.id).join(',');
            const best = new Map();
            for (const description of new Set(rows.map((t) => t.description).filter(Boolean))) {
                let hits = [];
                try {
                    const params = new URLSearchParams({ description, threshold: String(strength), include_categorized: '1', exclude_ids: exclude });
                    hits = (await api(`/api/transactions/similar?${params}`)).transactions || [];
                } catch { /* skip this description */ }
                if (token !== fetchToken) return;
                for (const x of hits) {
                    if (x.category_id === cat.id || !fitsFlow(cat.cat_type, flowOf(x))) continue;
                    if (!best.has(x.id) || best.get(x.id).score < x.score) best.set(x.id, { t: x, score: x.score ?? 1 });
                }
            }
            candidates = [...best.values()].sort((a, b) => b.score - a.score || (a.t.date < b.t.date ? 1 : -1));
            picked = new Set(candidates.map((c) => c.t.id));
            table.classList.remove('tx-loading');
            renderMatches();
        }

        function renderMatches() {
            const table = $('.tx-match-table');
            if (!candidates.length) {
                table.innerHTML = Ant.empty({ title: 'No similar transactions at this strength', desc: 'Loosen the match to look wider.', compact: true });
                return;
            }
            table.innerHTML = `<table class="ant-table ant-table-small ant-table-fixed">
                <thead><tr>
                    <th class="ant-table-selection-column tx-p-check"><input type="checkbox" class="ant-checkbox tx-match-all" aria-label="Tick every similar transaction"></th>
                    <th class="tx-p-date">Date</th><th>Description</th><th class="tx-p-cat">Now</th><th class="tx-p-match">Match</th><th class="tx-p-amt ant-table-cell-end">Amount</th>
                </tr></thead>
                <tbody>${candidates.map(({ t, score }) => `<tr data-id="${t.id}" class="${picked.has(t.id) ? 'ant-table-row-selected' : ''}">
                    <td class="ant-table-selection-column"><input type="checkbox" class="ant-checkbox tx-match-cb" ${picked.has(t.id) ? 'checked' : ''} aria-label="Tick ${esc(label(t))}, ${esc(formatDate(t.date))}"></td>
                    <td class="tx-num">${esc(formatDate(t.date))}</td>
                    <td><div class="tx-desc tx-desc-small">${merchantAvatarHtml(label(t))}<span class="tx-desc-name" title="${esc(t.description)}">${esc(label(t))}</span></div></td>
                    <td>${categoryTag(t.category_id)}</td>
                    <td class="tx-num">${Math.round(score * 100)}%</td>
                    <td class="ant-table-cell-end">${amountHtml(t)}</td></tr>`).join('')}</tbody></table>`;
            syncMatchAll();
        }

        function syncMatchAll() {
            const all = $('.tx-match-all');
            if (!all) return;
            all.checked = picked.size > 0 && picked.size === candidates.length;
            all.indeterminate = picked.size > 0 && picked.size < candidates.length;
        }

        // ── Review ──
        function describe() {
            const parts = [];
            if (edit.category !== undefined) parts.push(`category to ${edit.category === 'none' ? 'Uncategorized' : catById(Number(edit.category))?.name}`);
            if (edit.account !== undefined) parts.push(`account to ${accountLabel(edit.account || null) ?? 'No account'}`);
            if (edit.notes !== undefined && changes().some((c) => 'notes' in c.patch)) parts.push(edit.notes ? 'a new note' : 'the note cleared');
            if (single && changes().some((c) => 'date' in c.patch || 'description' in c.patch || 'amount' in c.patch)) {
                parts.push('the date, description or amount edited');
            }
            return parts.length ? `set ${parts.join(', ')}` : 'no field changes';
        }

        function renderReview() {
            const own = changes().length;
            const extra = cascade && target() ? picked.size : 0;
            const total = own + extra;
            const cat = catById(target());
            $('[data-step="review"]').innerHTML = `
                <div class="ant-alert ant-alert-info ant-alert-with-description" role="status">
                    <span class="ant-alert-icon">${Ant.icon('info-circle')}</span>
                    <div class="ant-alert-content">
                        <div class="ant-alert-message">${esc(plural(total, 'transaction'))} will change</div>
                        <div class="ant-alert-description"><ul class="tx-review-list">
                            ${own ? `<li>${own.toLocaleString()} selected: ${esc(describe())}</li>` : ''}
                            ${extra ? `<li>${esc(plural(extra, 'similar transaction'))} will become ${esc(cat.name)}</li>` : ''}
                        </ul></div>
                    </div>
                </div>
                ${target() ? '<div class="ant-typography-secondary tx-review-note">Their descriptions are remembered, so future imports that match are categorized for you.</div>' : ''}`;
            nextBtn.disabled = total === 0;
        }

        async function save() {
            const own = changes();
            const cascading = cascade && target() ? [...picked] : [];
            saving = true;
            const ok = await Ant.whileLoading(nextBtn, async () => {
                if (own.length) {
                    const { transactions } = await api('/api/transactions/bulk-update', {
                        method: 'POST', body: { updates: own.map(({ id, patch }) => ({ id, ...patch })) },
                    });
                    transactions.forEach(replaceRow);
                }
                if (cascading.length) {
                    await api('/api/transactions/categorize-similar', {
                        method: 'POST', body: { ids: cascading, category_id: target(), overwrite: true },
                    });
                    const cat = catById(target());
                    const set = new Set(cascading);
                    state.rows = state.rows.map((x) => (set.has(x.id) ? { ...x, category_id: cat.id, tx_type: cat.cat_type } : x));
                }
                return true;
            });
            saving = false;
            if (!ok) {
                Ant.message.error('Your changes could not be saved. No transactions were changed.');
                return;
            }
            close();
            state.selected.clear();
            sortRows();
            render();
            Ant.message.success(`Saved changes to ${plural(own.length + cascading.length, 'transaction')}`);
        }

        $('[data-step="edit"]').addEventListener('input', syncEditStep);
        $('[data-step="edit"]').addEventListener('change', syncEditStep);
        cascadeBox.addEventListener('change', syncEditStep);
        dialog.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            if (act === 'cancel') close();
            if (act === 'back') showStep(step - 1);
            if (act === 'next') {
                if (step === 0 && !validSingle()) return;
                if (step === stepNames().length - 1) save();
                else showStep(step + 1);
            }
        });
        showStep(0);
        (single ? control('date') : control('account')).focus();
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────
    function onTableClick(e) {
        const sorter = e.target.closest('[data-sort]');
        if (sorter) {
            const key = sorter.dataset.sort;
            const order = state.sort.key === key ? state.sort.order : null;
            const next = order === null ? 'ascend' : order === 'ascend' ? 'descend' : null;
            state.sort = next ? { key, order: next } : { key: null, order: null };
            render();
            document.querySelector(`[data-sort="${key}"]`)?.focus();
            return;
        }
        const empty = e.target.closest('[data-empty-action]');
        if (empty) {
            if (empty.dataset.emptyAction === 'tx-import') TxFileImport.run();
            else clearFilters();
            return;
        }
        const tr = e.target.closest('.tx-row');
        if (!tr) return;
        const t = rowById(Number(tr.dataset.id));
        if (!t) return;
        if (e.target.closest('[data-cat-edit]')) editCategory(e.target.closest('td'), t);
        else if (e.target.closest('[data-notes-edit]')) editNotes(e.target.closest('td'), t);
    }

    function onTableChange(e) {
        if (e.target.id === 'tx-select-all') { togglePage(e.target.checked); return; }
        const cb = e.target.closest('.tx-row-cb');
        if (cb) toggleRow(Number(cb.closest('.tx-row').dataset.id), cb.checked);
    }

    function exportFilters() {
        const f = state.filters;
        const out = {};
        if (f.dateFrom) out.date_from = f.dateFrom;
        if (f.dateTo) out.date_to = f.dateTo;
        if (f.name.trim()) out.description = f.name.trim();
        if (f.type.length) out.tx_type = [...f.type];
        if (f.category.length) out.category_id = f.category.map((v) => (v === 'none' ? null : Number(v)));
        if (f.account.length) out.account_key = f.account.map((v) => (v === 'none' ? null : v));
        const min = parseAmount(f.amountMin);
        const max = parseAmount(f.amountMax);
        if (min !== null) out.amount_min = min;
        if (max !== null) out.amount_max = max;
        return Object.keys(out).length ? out : null;
    }

    async function init() {
        ui.pager = Ant.pagination(document.getElementById('tx-pagination'), {
            current: state.page,
            pageSize: state.pageSize,
            pageSizeOptions: PAGE_SIZES,
            showTotal: (total, [a, b]) => `Showing ${a.toLocaleString()}–${b.toLocaleString()} of ${total.toLocaleString()}`,
            onChange: (current, size) => {
                state.page = current;
                if (size !== state.pageSize) {
                    state.pageSize = size;
                    try { localStorage.setItem(PAGE_SIZE_KEY, String(size)); } catch { /* per-window only */ }
                }
                render();
                syncUrl();
                // Back to the top of the ledger, if the page change left it above the window.
                const card = document.querySelector('.tx-ledger');
                if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });
            },
        });

        renderHead();
        const tbody = document.getElementById('tx-tbody');
        const cancelSkeleton = UI.skeletonGuard(() => { tbody.innerHTML = skeletonRows(8); });
        await load();
        cancelSkeleton();
        initFilters();
        render();

        const table = document.querySelector('.tx-table');
        table.addEventListener('click', onTableClick);
        table.addEventListener('change', onTableChange);
        document.getElementById('tx-add-btn').addEventListener('click', openAddDialog);
        document.getElementById('tx-import-btn').addEventListener('click', () => TxFileImport.run());
        document.getElementById('tx-export-btn').addEventListener('click', () => TxFileExport.run({
            filters: exportFilters(),
            shown: visibleRows().length,
            selectedIds: [...state.selected],
            total: state.rows.length,
        }));
        document.getElementById('tx-batch-edit').addEventListener('click', () => openEditDialog([...state.selected]));
        document.getElementById('tx-batch-delete').addEventListener('click', deleteSelected);
        document.getElementById('tx-batch-clear').addEventListener('click', () => {
            state.selected.clear();
            render();
        });

        applyUrlFilters();
    }

    document.addEventListener('DOMContentLoaded', init);

    // Re-fetch and redraw after an import.
    window.addEventListener('transactions:reload', async () => {
        state.selected.clear();
        state.page = 1;
        await load();
        reconcileFilters();
        render();
        syncUrl();
    });
}());
