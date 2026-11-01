'use strict';

// ─── Statements page ────────────────────────────────────────────────────────
// Cash Flow and Balance Sheet behind Ant line Tabs, drawn in Ant Design. One
// toolbar row: the tabs hard left; the year control (‹ Select ›), Manage Years
// and Manage Columns hard right, as the Tabs' extra content.
//
// The grids are widgets/tables.js: one controller per statement, each
// rendering a card per statement year into its own container. This file is the
// page around them:
//
//   • the tabs, which swap the visible panel (#balance-sheet in the URL opens
//     on the Balance Sheet; the Dashboard's "Add balances" link uses it);
//   • the year control: its years are the union of both statements', and the
//     selected year is shown in both panels by toggling [hidden] on the cards;
//   • the empty states: no years at all, a year this statement lacks, a
//     Balance Sheet with no accounts, or a statement that failed to load;
//   • the two managers, opened from the toolbar (pages/stmtmanagers.js).

(function () {
    const NET_TIP = 'Income minus expenses. Transfers to your own accounts are neither.';

    const legendFigure = (extra = '') => `<span class="stmt-legend-figure${extra}">${
        escapeHtml(formatCurrency(0, false, { editable: true }))}</span>`;

    // ── Page state ───────────────────────────────────────────────────────────
    let years = [];            // union across both statements, oldest first
    let current = -1;          // index into years; -1 when there are none
    let activeTab = 'cashflow';
    const loaded = new Set();  // statements that have answered at least once
    const failed = new Set();  // statements whose load failed

    const prevBtn = document.getElementById('stmt-year-prev');
    const nextBtn = document.getElementById('stmt-year-next');
    const yearSelect = document.getElementById('stmt-year-select');

    // ── The two statements ───────────────────────────────────────────────────
    const SHEETS = {
        cashflow: {
            label: 'Cash Flow',
            table: bootstrapYearTablePage({
                apiPrefix: '/api',
                title: 'Cash Flow',
                types: [
                    { key: 'income', label: 'Income' },
                    { key: 'expense', label: 'Expenses' },
                    { key: 'transfer', label: 'Transfers' },
                ],
                summary: 'net',
                summaryHead: `Net<span class="ant-info-tip" tabindex="0" role="note" aria-label="${NET_TIP}"
                    data-tip="${NET_TIP}">${Ant.icon('info-circle-outlined')}</span>`,
                includeTotals: true,
                footer: () => `
                    <span class="stmt-legend">${legendFigure(' cell-computed')} computed from transactions</span>
                    <span class="stmt-legend">${legendFigure()} typed by you</span>
                    <span class="stmt-legend">${Ant.icon('undo')} typed over a computed value; click to revert</span>`,
                containerSelector: '#stmt-tables-cashflow',
                onRender: () => sheetRendered('cashflow'),
                onError: () => failed.add('cashflow'),
            }),
        },
        balance: {
            label: 'Balance Sheet',
            table: bootstrapYearTablePage({
                apiPrefix: '/api/balance',
                title: 'Balance Sheet',
                types: [
                    { key: 'cash', label: 'Cash' },
                    { key: 'investment', label: 'Investment' },
                    { key: 'retirement', label: 'Retirement' },
                    { key: 'debt', label: 'Debt' },
                ],
                summary: 'networth',
                summaryHead: 'Net Worth',
                includeTotals: false,
                footer: () => 'Faded figures are carried forward from the last month with a balance.',
                containerSelector: '#stmt-tables-balance',
                onRender: () => sheetRendered('balance'),
                onError: () => failed.add('balance'),
            }),
        },
    };
    const cashflowTable = SHEETS.cashflow.table;
    const balanceTable = SHEETS.balance.table;

    const unionYears = () => [...new Set([...cashflowTable.years(), ...balanceTable.years()])]
        .sort((a, b) => a - b);

    // ── Tabs ─────────────────────────────────────────────────────────────────
    const selectTab = Ant.tabs(document.querySelector('.stmt-tablist'), {
        onChange: (key) => {
            activeTab = key;
            for (const id of Object.keys(SHEETS)) {
                document.getElementById(`stmt-panel-${id}`).hidden = id !== key;
            }
        },
    });
    selectTab(location.hash === '#balance-sheet' ? 'balance' : 'cashflow');

    // ── Selected year ────────────────────────────────────────────────────────

    /** What one statement panel shows for the selected year: its card, or
     *  the empty state that explains why there is none. */
    function showYear(id, year) {
        const sheet = SHEETS[id];
        const cards = document.querySelectorAll(`#stmt-tables-${id} .stmt-year`);
        const empty = document.getElementById(`stmt-empty-${id}`);
        let state = null;
        if (failed.has(id)) {
            state = { title: `Couldn't load the ${sheet.label}`, desc: 'Reload the page (Ctrl+R) to try again.' };
        } else if (year === undefined) {
            state = loaded.size < 2 ? null : {
                title: 'No statement years yet',
                desc: 'Add a year to start its Cash Flow and Balance Sheet.',
                action: { label: 'Add a year', name: 'years' },
            };
        } else if (!sheet.table.hasYear(year)) {
            state = loaded.has(id) ? {
                title: `No ${sheet.label} for ${year} yet`,
                action: { label: `Add ${year}`, name: 'add-year' },
            } : null;
        } else if (id === 'balance' && !sheet.table.columns().length) {
            state = {
                title: 'No accounts on the Balance Sheet yet',
                desc: 'Add the accounts whose balances you want to track.',
                action: { label: 'Add an account', name: 'accounts' },
            };
        }
        cards.forEach((card) => { card.hidden = state !== null || Number(card.dataset.year) !== year; });
        empty.hidden = !state;
        empty.innerHTML = state ? Ant.empty(state) : '';
        if (state) empty.dataset.year = year ?? '';
    }

    function applyYear() {
        const year = years[current];
        prevBtn.disabled = current <= 0;
        nextBtn.disabled = current < 0 || current >= years.length - 1;
        yearSelect.disabled = !years.length;
        yearSelect.innerHTML = years.length
            ? [...years].reverse().map((y) => `<option value="${y}">${y}</option>`).join('')
            : '<option value="">—</option>';
        if (year !== undefined) yearSelect.value = String(year);
        for (const id of Object.keys(SHEETS)) showYear(id, year);
    }

    const go = (i) => {
        if (i < 0 || i >= years.length || i === current) return;
        current = i;
        applyYear();
    };

    prevBtn.addEventListener('click', () => go(current - 1));
    nextBtn.addEventListener('click', () => go(current + 1));
    yearSelect.addEventListener('change', () => go(years.indexOf(Number(yearSelect.value))));

    /** The year to open on: this calendar year when the statement has it,
     *  else the newest. */
    const openingIndex = () => {
        const i = years.indexOf(new Date().getFullYear());
        return i >= 0 ? i : years.length - 1;
    };

    // Re-read the years after a statement renders. Until both statements have
    // answered, the page keeps to its opening year. After that a year that
    // just appeared (added or renumbered in Manage Years) is selected;
    // otherwise the selected year stays, or its nearest neighbour when it was
    // removed.
    function sheetRendered(id) {
        const before = new Set(years);
        const was = years[current];
        const firstLoad = loaded.size < 2;
        loaded.add(id);
        years = unionYears();
        const added = years.filter((y) => !before.has(y));
        if (!years.length) current = -1;
        else if (firstLoad) current = openingIndex();
        else if (added.length) current = years.indexOf(Math.max(...added));
        else if (years.includes(was)) current = years.indexOf(was);
        else current = Math.min(Math.max(current, 0), years.length - 1);
        applyYear();
    }

    // ── Managers and empty-state actions ─────────────────────────────────────
    const openYears = () => StatementManagers.openYears({ sheets: [cashflowTable, balanceTable] });
    const openColumns = (tab) => StatementManagers.openColumns({ tab, cashflow: cashflowTable, balance: balanceTable });

    document.getElementById('stmt-years-btn').addEventListener('click', openYears);
    document.getElementById('stmt-columns-btn').addEventListener('click', () => openColumns(activeTab));

    document.querySelector('.stmt-page').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-empty-action]');
        if (!btn || Ant.isLoading(btn)) return;
        const action = btn.dataset.emptyAction;
        if (action === 'years') openYears();
        else if (action === 'accounts') openColumns('balance');
        else if (action === 'add-year') {
            const year = Number(btn.closest('.stmt-empty').dataset.year);
            await Ant.whileLoading(btn, () => SHEETS[activeTab].table.addYear(year));
        }
    });
}());
