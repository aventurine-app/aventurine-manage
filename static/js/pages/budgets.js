'use strict';

(function () {
    // ─── Budgets ────────────────────────────────────────────────────────────
    // One monthly target per category, drawn in Ant Design (ant.css, ant.js)
    // like Recurring, Portfolio and Reports: a toolbar (the month and Chart
    // or List on the left, Set Budget on the right), four Statistic cards for
    // the month, then one card
    // holding the targets, and a line under it naming what was spent in
    // categories with no target.
    //
    // CHART. A Nightingale rose with one wedge per budgeted category (see Rose
    // below). The wedge's AREA is the target the user set; the filled wedge
    // inside it is how much of that target the shown month has already
    // reached. An unfilled wedge means nothing has moved in that category yet.
    // LIST is the same targets as a table, furthest along first.
    //
    // TWO KINDS OF TARGET, and the difference is the direction of the category
    // behind it (schema.js categories.cat_type):
    //   expense  — a ceiling. The accent colour while the spend is inside the
    //              target, red once it is past it.
    //   transfer — Savings, Investing, and any other category the user files
    //              under the transfer direction. Money put away rather than
    //              money gone. Drawn in Ant's info blue at EVERY level in every
    //              month, and never graded.
    //
    // WHY A PUT-AWAY TARGET CARRIES NO VERDICT. A red spending wedge names a
    // limit that was passed, which is a fact whatever else happened that month.
    // Coming up short on a savings target is not the same kind of fact: the
    // month may still be running, and a transfer the import has not categorized
    // yet is money that moved but reads here as money that did not. Colouring
    // that amber would state a shortfall the data cannot support. The figures
    // are printed beside every wedge, so a short month is legible without one.
    // Grading how much a user saves is the Metrics tab's job, against the
    // savings-rate and invested-share goals (services/reportCard.js).
    //
    // WHERE THE TWO NUMBERS COME FROM
    //   target — GET /api/budgets (handlers/budgets.js). ONE figure per
    //            category, applied to every month, so stepping to another month
    //            never changes a wedge's size. That is the point: the wedges
    //            are the shape of the plan, and only the fill moves.
    //   spent  — the Cash Flow statement (Store 'ie' → GET /api/data), read one
    //            cell at a time. The statement is the blend point — a cell is
    //            computed from transactions unless the user typed over it — so a
    //            month the user has corrected by hand reads here exactly as it
    //            reads on Statements and on Spending Trends. Aggregating the
    //            ledger separately would let this page and those two disagree
    //            about what a month cost.
    //
    // ONLY BUDGETED CATEGORIES GET A WEDGE OR A ROW. A category with no
    // target has no size to draw (the wedge IS the target) and no fraction to
    // be part of. What it spent is still on the page, as the one line under
    // the card, and in full on Statements and Spending Trends.
    //
    // WHAT A TRANSFER CELL DOES NOT SAY. The schema records a transfer as an
    // amount with a direction, not as a pair of accounts (the v7 accounts work
    // was reverted), so money coming back OUT of savings adds to the same cell
    // as money going in. The Dashboard's Saved & Invested cards and the
    // Metrics tab both accept this and say so; a third definition of saving
    // would put this page at odds with both, which costs more than the
    // imprecision does.
    //
    // CLICKING A WEDGE OR A ROW opens the ledger on that category and month
    // (Transactions' year / month / cat deep link), so every figure can be
    // traced to the rows behind it. Targets are edited in Set Budget, which
    // lists EVERY budgetable category — that is how a category gets its first
    // target.
    //
    // COLOUR SAYS TWO THINGS, AND ONLY TWO: the kind of target (accent or blue)
    // and, for spending only, the verdict (red). The category name is printed
    // beside every wedge, so a hue per category would be decoration standing
    // where a verdict could be. The rose reads them from the theme (the
    // primary, info and error colours); the list's live in budgets.css.
    //
    // Globals (loaded before this script): apiFetch (api.js), escapeHtml
    // (escape.js), formatCurrency / applyCurrencyFormat / stripCurrencyValue
    // (currency.js), Store (store.js), UI (ui.js), Ant (ant.js), EChartKit
    // (echart-kit.js).

    // The statement keys each year's months by name (GET /api/data).
    const MONTHS = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];

    // Half a cent. Statement cells are summed in floating point, and a
    // category spent to the penny is on its target, not over it.
    const CENT_TOLERANCE = 0.004;

    const state = {
        statement: null,      // GET /api/data
        budgets: new Map(),   // category key -> target amount
        month: currentYm(),   // 'YYYY-MM', the month on the toolbar
        view: 'chart',        // 'chart' | 'list'
    };

    const els = {};

    /** A figure for a card or a label: whole amounts drop their ".00". */
    const money = (amount) => formatCurrency(amount, true);

    // ─── Months ─────────────────────────────────────────────────────────────

    // Declarations, not arrow constants: `state` above reads currentYm() while
    // the script is still being evaluated.
    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function currentYm() {
        const now = new Date();
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    }

    /** The month `steps` away from `ym`, across year ends. */
    function stepYm(ym, steps) {
        const [y, m] = ym.split('-').map(Number);
        const total = y * 12 + (m - 1) + steps;
        return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
    }

    function monthParts(ym) {
        const [year, month] = ym.split('-').map(Number);
        return { year, monthIdx: month - 1 };
    }

    function monthLabel(ym) {
        const { year, monthIdx } = monthParts(ym);
        return `${MONTHS[monthIdx]} ${year}`;
    }

    // ─── Data ───────────────────────────────────────────────────────────────

    /** Statement columns of one direction, in the user's own order — the same
     *  order and the same source the Cash Flow statement's columns come from. */
    function columnsOfType(type) {
        return (state.statement?.columns || []).filter((col) => col.type === type);
    }

    /** Every category that may hold a target, spending first. The backend takes
     *  the same two directions (BUDGETABLE_CAT_TYPES in handlers/budgets.js). */
    function budgetableColumns() {
        return [...columnsOfType('expense'), ...columnsOfType('transfer')];
    }

    /** One month's statement cells, keyed by category. */
    function cellsForMonth(ym) {
        const { year, monthIdx } = monthParts(ym);
        const months = (state.statement?.entries || {})[String(year)] || {};
        return months[MONTHS[monthIdx]] || {};
    }

    function toBudgetMap(rows) {
        return new Map((rows || []).map((b) => [b.category, b.amount]));
    }

    async function loadBudgets() {
        const response = await apiFetch('/api/budgets');
        if (!response.ok) throw new Error(`budgets: ${response.status}`);
        const body = await response.json();
        state.budgets = toBudgetMap(body.budgets);
    }

    // ─── History ────────────────────────────────────────────────────────────
    // Set Budget's two reference figures, expected income and each category's
    // recent average, both read COMPLETE months only. The month in progress is
    // a part-month: counting it would read as a pay cut, or as a cheap month,
    // every time the dialog is opened before the month is out.

    function monthOrdinal(year, monthIdx) {
        return year * 12 + monthIdx;
    }

    /** Every complete month the statement holds cells for, most recent first. */
    function completeMonths() {
        const entries = state.statement?.entries || {};
        const now = new Date();
        const thisMonth = monthOrdinal(now.getFullYear(), now.getMonth());
        const months = [];

        for (const [yearStr, cellsByMonth] of Object.entries(entries)) {
            const year = Number(yearStr);
            if (!Number.isFinite(year)) continue;
            for (let monthIdx = 0; monthIdx < MONTHS.length; monthIdx++) {
                const ordinal = monthOrdinal(year, monthIdx);
                const cells = cellsByMonth[MONTHS[monthIdx]];
                if (cells && ordinal < thisMonth) months.push({ ordinal, cells });
            }
        }
        return months.sort((a, b) => b.ordinal - a.ordinal);
    }

    // Expected income is COMPUTED, never asked for: the statement already holds
    // every month of income the user has, so a field for it would ask for a
    // figure the app can read. It is the median of the trailing months, not the
    // mean and not the last one: a bonus month or a short month moves a mean
    // and replaces a "last month" outright, and neither is a normal month. A
    // month with no income at all is skipped rather than counted as zero — it is
    // a month that was never imported, the same clamp the Forecast and Spending
    // Trends apply at the near end of coverage.
    const INCOME_MONTHS = 6;

    function incomeForMonth(cells) {
        let total = 0;
        for (const col of columnsOfType('income')) total += cells[col.key] || 0;
        return total;
    }

    /** Income for each of the last INCOME_MONTHS complete months that recorded any. */
    function incomeHistory(months) {
        return months
            .map((m) => incomeForMonth(m.cells))
            .filter((total) => total > 0)
            .slice(0, INCOME_MONTHS);
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // The "avg … /mo" under each of Set Budget's rows: what the category moved
    // in a recent month, as a starting point for its target. It averages the
    // last AVERAGE_MONTHS complete months that recorded anything, so a stretch
    // that was never imported does not average in as months of nothing.
    const AVERAGE_MONTHS = 3;

    const hasAnyFigure = (cells) => Object.values(cells).some((value) => value);

    /** category key -> average per month, or null when no complete month has
     *  any figure to average. */
    function recentAverages(months) {
        const recent = months.filter((m) => hasAnyFigure(m.cells)).slice(0, AVERAGE_MONTHS);
        if (!recent.length) return null;
        const totals = new Map();
        for (const { cells } of recent) {
            for (const [key, value] of Object.entries(cells)) {
                totals.set(key, (totals.get(key) || 0) + (value || 0));
            }
        }
        return new Map([...totals].map(([key, total]) => [key, total / recent.length]));
    }

    // ─── The month's figures ────────────────────────────────────────────────

    /**
     * Every budgeted category for the month on the toolbar, in the user's own
     * category order. A wedge is sized by the TARGET, never the amount
     * reached: a category the user overspent must not grow a wedge for it.
     */
    function buildItems() {
        const cells = cellsForMonth(state.month);
        const items = [];
        for (const col of budgetableColumns()) {
            const target = state.budgets.get(col.key) || 0;
            if (target <= 0) continue;
            const away = col.type === 'transfer';
            // The statement can hold a negative cell (a refund the user typed
            // in, or a month whose transfers net out backwards). Below zero is
            // not progress toward a target, so it floors at nothing rather than
            // reading as credit.
            const actual = Math.max(cells[col.key] || 0, 0);
            items.push({
                key: col.key,
                label: col.label,
                target,
                actual,
                away,
                ratio: actual / target,
                // Put away is never over: passing a savings target is not a
                // thing to report, so only spending carries the verdict.
                over: !away && actual > target + CENT_TOLERANCE,
            });
        }
        return items;
    }

    /** The four Statistic cards' figures. Budgeted, Spent and Left count
     *  spending only; what was put away has its own card. */
    function totalsOf(items) {
        const sum = (list, field) => list.reduce((total, item) => total + item[field], 0);
        const spend = items.filter((item) => !item.away);
        const away = items.filter((item) => item.away);
        return {
            budgeted: sum(spend, 'target'),
            spent: sum(spend, 'actual'),
            awayTarget: sum(away, 'target'),
            awayActual: sum(away, 'actual'),
            hasAway: away.length > 0,
        };
    }

    /** What a wedge's tooltip and the chart's screen-reader label say. */
    function describe(item) {
        const of = `${item.label}: ${formatCurrency(item.actual)} of ${formatCurrency(item.target)}`;
        if (item.away) return `${of} put away`;
        if (item.over) return `${of} · ${formatCurrency(item.actual - item.target)} over`;
        return `${of} · ${formatCurrency(item.target - item.actual)} left`;
    }

    /** The ledger filtered to one category over the month on the toolbar. The
     *  year + month shorthand is the one the Dashboard and the Sankey send; the
     *  category goes by its key, so the link survives a rename. */
    function ledgerHref(key) {
        const { year, monthIdx } = monthParts(state.month);
        const query = new URLSearchParams({ year: String(year), month: String(monthIdx + 1), cat: key });
        return `/transactions?${query}`;
    }

    // ─── Toolbar ────────────────────────────────────────────────────────────

    function renderToolbar() {
        els.monthText.textContent = monthLabel(state.month);
        // The future is never a month to look at, so forward stops at this one.
        // Disabled rather than hidden, so the controls never move; focus is
        // handed to the month first so it is not dropped with the button.
        const atNow = state.month >= currentYm();
        if (atNow && document.activeElement === els.monthNext) els.monthLabel.focus();
        els.monthNext.disabled = atNow;

        for (const btn of els.viewSwitch.querySelectorAll('[data-view]')) {
            btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));
        }
    }

    function goToMonth(ym) {
        state.month = ym;
        render();
    }

    // ─── Statistic cards ────────────────────────────────────────────────────

    function statCard(title, value, { tone = '', suffix = '' } = {}) {
        return `<div class="ant-card ant-card-small bud-stat${tone ? ` bud-stat-${tone}` : ''}">
            <div class="ant-card-body">
                <div class="ant-statistic-title">${escapeHtml(title)}</div>
                <div class="ant-statistic-content">${escapeHtml(value)}${suffix
                    ? `<span class="bud-stat-suffix">${escapeHtml(suffix)}</span>` : ''}</div>
            </div>
        </div>`;
    }

    function renderStats(totals) {
        const over = totals.spent > totals.budgeted + CENT_TOLERANCE;
        els.stats.innerHTML = [
            statCard('Budgeted', money(totals.budgeted)),
            statCard('Spent', money(totals.spent)),
            // The title says which side of the line the month is on, so the
            // red is never the only thing that says it.
            statCard(over ? 'Over budget' : 'Left to spend', money(Math.abs(totals.budgeted - totals.spent)),
                { tone: over ? 'over' : '' }),
            // No put-away targets, no card: "$0 of $0" would be noise.
            totals.hasAway
                ? statCard('Saved & invested', money(totals.awayActual), { suffix: `of ${money(totals.awayTarget)}` })
                : '',
        ].join('');
    }

    // ─── Rose ────────────────────────────────────────────────────────────────
    // One wedge per budgeted category in a Nightingale rose (Apache ECharts,
    // widgets/echart-kit.js). Every wedge takes the same angle; its AREA is the
    // target, and a second wedge inside it, from the centre out, is what the
    // month has reached. Area rather than radius, because a target twice the
    // size must get twice the ink: ECharts maps a rose wedge's radius linearly
    // from its value, so each wedge is handed the square root of its amount.
    //
    // The spent wedges share the target wedges' scale by being drawn with a
    // radius cut to the same proportion: the largest spent wedge's square root
    // over the largest target's. Spending past a target is held at the target's
    // edge, where the red says the rest.
    //
    // COLOUR, as for the list: the theme's primary for spending, its info blue
    // for money put away, its error red once spending passes its target.

    const ROSE_RADIUS = 70;   // the largest wedge, as a percent of the box

    function wedgeColor(t, item) {
        if (item.over) return t.error;
        return item.away ? t.info : t.primary;
    }

    function roseOption(t, items) {
        const targetR = items.map((item) => Math.sqrt(item.target));
        const spentR = items.map((item) => Math.sqrt(Math.min(item.actual, item.target)));
        const maxTarget = Math.max(...targetR);
        const maxSpent = Math.max(...spentR);
        const name = (item) => item.label;
        const tip = (p) => {
            const item = items[p.dataIndex];
            return item ? EChartKit.tipHtml({
                rows: [{ color: wedgeColor(t, item), name: describe(item), value: '' }],
                note: 'Click to see its transactions',
            }) : '';
        };
        const series = [{
            type: 'pie',
            roseType: 'area',
            radius: [0, `${ROSE_RADIUS}%`],
            center: ['50%', '52%'],
            startAngle: 90,
            cursor: 'pointer',
            data: items.map((item, i) => {
                const c = wedgeColor(t, item);
                return {
                    name: name(item),
                    value: targetR[i],
                    itemStyle: { color: EChartKit.alpha(c, 0.12), borderColor: c, borderWidth: 1.5 },
                };
            }),
            label: {
                formatter: (p) => {
                    const item = items[p.dataIndex];
                    return `{name|${String(item.label).replace(/[{}|]/g, ' ')}}\n{amount|${money(item.actual)}} {target|/ ${money(item.target)}}`;
                },
                rich: {
                    name: { color: t.text, fontFamily: t.font, fontSize: 13, fontWeight: 600, lineHeight: 18 },
                    amount: { color: t.text, fontFamily: t.font, fontSize: 12, lineHeight: 16 },
                    target: { color: t.textTertiary, fontFamily: t.font, fontSize: 12, lineHeight: 16 },
                },
            },
            labelLine: { lineStyle: { color: t.border } },
            emphasis: { scale: true, scaleSize: 4 },
        }];
        if (maxSpent > 0) {
            series.push({
                type: 'pie',
                roseType: 'area',
                radius: [0, `${ROSE_RADIUS * (maxSpent / maxTarget)}%`],
                center: ['50%', '52%'],
                startAngle: 90,
                cursor: 'pointer',
                label: { show: false },
                labelLine: { show: false },
                data: items.map((item, i) => {
                    const c = wedgeColor(t, item);
                    return { name: name(item), value: spentR[i], itemStyle: { color: EChartKit.alpha(c, 0.55) } };
                }),
            });
        }
        return { tooltip: EChartKit.tooltip(t, { trigger: 'item', formatter: tip }), series };
    }

    function renderRose(items) {
        EChartKit.mount(els.field, (t) => roseOption(t, items), {
            label: `Budgets for ${monthLabel(state.month)}: ${items.map(describe).join('; ')}`,
            on: {
                click: (p) => {
                    const item = items[p.dataIndex];
                    if (item) location.assign(ledgerHref(item.key));
                },
            },
        });
    }

    // ─── List ───────────────────────────────────────────────────────────────

    // Past the target. Every row shares one scale so the target ticks line up
    // down the column: the track runs to the furthest row's figure, never
    // short of the target and never past twice it. A row further over than
    // that fills its track; its percentage still says by how much.
    const MAX_SCALE = 2;

    function scaleOf(items) {
        const furthest = items.reduce((max, item) => Math.max(max, item.ratio), 1);
        return Math.min(furthest, MAX_SCALE);
    }

    function progressHtml(item, scale) {
        const percent = Math.round(item.ratio * 100);
        const tone = item.over ? 'ant-progress-status-exception' : `bud-progress-${item.away ? 'away' : 'spend'}`;
        const fill = Math.min(item.ratio / scale, 1) * 100;
        const target = 100 / scale;
        return `<div class="ant-progress ${tone}">
            <div class="ant-progress-outer bud-progress-outer" aria-hidden="true">
                <div class="ant-progress-inner">
                    <div class="ant-progress-bg" style="width:${fill.toFixed(2)}%"></div>
                </div>
                <span class="bud-target-tick" style="left:${target.toFixed(2)}%" title="Target ${escapeHtml(formatCurrency(item.target))}"></span>
            </div>
            <span class="ant-progress-text">${percent}%</span>
        </div>`;
    }

    /** The table, furthest along first. Each row opens the ledger behind it;
     *  the name is the row's link, so the keyboard reaches it too. */
    function listHtml(items) {
        const scale = scaleOf(items);
        const rows = [...items].sort((a, b) => b.ratio - a.ratio).map((item) => {
            const href = escapeHtml(ledgerHref(item.key));
            return `<tr data-href="${href}">
                <td class="bud-col-name">
                    <a class="bud-table-link" href="${href}">${escapeHtml(item.label)}</a>
                </td>
                <td>${progressHtml(item, scale)}</td>
                <td class="ant-table-cell-end bud-num${item.over ? ' bud-num-over' : ''}">${escapeHtml(formatCurrency(item.actual))}</td>
                <td class="ant-table-cell-end bud-num">${escapeHtml(formatCurrency(item.target))}</td>
                <td class="ant-table-cell-end bud-num">${item.away ? '—' : escapeHtml(formatCurrency(item.target - item.actual))}</td>
            </tr>`;
        }).join('');
        return `<div class="ant-table-wrapper"><table class="ant-table ant-table-large bud-table">
            <thead><tr>
                <th scope="col">Category</th>
                <th scope="col" class="bud-col-progress">Progress</th>
                <th scope="col" class="ant-table-cell-end">Spent</th>
                <th scope="col" class="ant-table-cell-end">Target</th>
                <th scope="col" class="ant-table-cell-end">Left</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    }

    // ─── Unbudgeted ─────────────────────────────────────────────────────────

    /** The line under the card: what the month spent where there is no target. */
    function renderUnbudgeted() {
        const cells = cellsForMonth(state.month);
        const spent = columnsOfType('expense')
            .filter((col) => !(state.budgets.get(col.key) > 0) && (cells[col.key] || 0) > 0)
            .map((col) => ({ label: col.label, amount: cells[col.key] }));

        els.unbudgeted.hidden = !spent.length;
        if (!spent.length) return;
        const total = spent.reduce((sum, s) => sum + s.amount, 0);
        const each = spent.map((s) => `${s.label} ${money(s.amount)}`).join(', ');
        els.unbudgeted.textContent = `Also spent ${money(total)} in categories without a budget: ${each}.`;
    }

    // ─── Render ─────────────────────────────────────────────────────────────

    function renderView(items) {
        const circles = state.view === 'chart';
        els.card.classList.toggle('bud-card-list', !circles);
        els.field.hidden = !circles;
        els.list.hidden = circles;
        // Drawn only while it is on screen; the kit sizes it to the field.
        if (circles) renderRose(items);
        else els.list.innerHTML = listHtml(items);
    }

    function render() {
        renderToolbar();
        const items = buildItems();
        // Read off the items, not off the stored targets: a target left behind
        // by a deleted category would otherwise count as something to draw and
        // leave an empty card on screen.
        const empty = items.length === 0;

        els.empty.hidden = !empty;
        els.stats.hidden = empty;
        els.card.hidden = empty;
        if (empty) {
            els.unbudgeted.hidden = true;
            els.empty.innerHTML = budgetableColumns().length
                ? Ant.empty({
                    title: 'No budgets set',
                    desc: 'Set a monthly target for each kind of spending and watch it fill as the month goes.',
                    action: { label: 'Set Budget', name: 'set-budget' },
                })
                : Ant.empty({
                    title: 'No expense categories yet',
                    desc: 'Budgets are set per category. Add your categories on Statements first.',
                    action: { label: 'Open Statements', href: '/statements' },
                });
            return;
        }

        els.empty.innerHTML = '';
        renderStats(totalsOf(items));
        renderView(items);
        renderUnbudgeted();
    }

    // ─── Set Budget ─────────────────────────────────────────────────────────
    // Every budgetable category and its target in one dialog, saved in one
    // write. Clearing a field (or typing 0) removes that category's target —
    // the backend treats a zero as "no target", which is the same thing the
    // page draws.
    //
    // THREE SECTIONS, in the order the plan is made: the income the month has
    // to work with, what is put away out of it, then what is spent. Income is a
    // read-only figure (see INCOME_MONTHS) rather than a field, so the dialog
    // stays a list of decisions with one fact at the top of it. Each row shows
    // the category's recent average, the figure a target is usually set from.
    //
    // The Alert under the rows is what makes the sections worth having: income
    // minus every target in the dialog, live on each keystroke, so the leftover
    // is visible while the decision is being made rather than after the save.
    // It sits outside the scrolling rows so it stays in view, and turns to a
    // warning when the targets outrun the income, which is a real state and is
    // shown as one.

    function rowHtml(col, averages) {
        const target = state.budgets.get(col.key) || 0;
        const value = target > 0 ? formatCurrency(target, false, { editable: true }) : '';
        const average = averages ? Math.max(averages.get(col.key) || 0, 0) : null;
        return `<label class="bud-row">
            <span class="bud-row-label">
                <span class="bud-row-name">${escapeHtml(col.label)}</span>
                ${average === null ? '' : `<span class="bud-row-hint">avg ${escapeHtml(money(Math.round(average)))}/mo</span>`}
            </span>
            <input type="text" class="ant-input bud-row-input" inputmode="decimal"
                data-category="${escapeHtml(col.key)}"
                value="${escapeHtml(value)}"
                placeholder="No budget"
                spellcheck="false" autocomplete="off">
        </label>`;
    }

    function sectionHtml(title, desc, rowsHtml) {
        return `<section class="bud-section">
            <h3 class="bud-section-title">${escapeHtml(title)}</h3>
            <div class="bud-section-desc">${escapeHtml(desc)}</div>
            <div class="bud-rows">${rowsHtml}</div>
        </section>`;
    }

    function dialogSectionsHtml(income, incomeMonths, averages) {
        const sections = [];
        if (income > 0) {
            sections.push(sectionHtml('Expected income',
                `A typical month, worked out from your last ${incomeMonths} complete month${incomeMonths === 1 ? '' : 's'} of income.`,
                `<div class="bud-row">
                    <span class="bud-row-label"><span class="bud-row-name">Monthly income</span></span>
                    <span class="bud-row-figure">${escapeHtml(formatCurrency(income))}</span>
                </div>`));
        }
        const away = columnsOfType('transfer');
        if (away.length) {
            sections.push(sectionHtml('Savings & investing',
                'What you plan to move into your own accounts.',
                away.map((col) => rowHtml(col, averages)).join('')));
        }
        const spend = columnsOfType('expense');
        if (spend.length) {
            sections.push(sectionHtml('Spending',
                'A monthly limit for each kind of spending. Leave one blank to leave it unbudgeted.',
                spend.map((col) => rowHtml(col, averages)).join('')));
        }
        return sections.length
            ? sections.join('')
            : Ant.empty({ title: 'No categories to budget', desc: 'Add your categories on Statements first.', compact: true });
    }

    /** Income minus every target typed into the dialog, as the Alert under
     *  the rows. Reads the inputs rather than the saved set, so it tracks edits
     *  before they land. Hidden when no complete month recorded any income,
     *  since there is then nothing to measure the targets against. */
    function paintAllocation(dialog, income) {
        const alert = dialog.querySelector('.bud-dialog-alert');
        alert.hidden = income <= 0;
        if (alert.hidden) return;

        let planned = 0;
        for (const input of dialog.querySelectorAll('.bud-row-input')) {
            const amount = parseFloat(stripCurrencyValue(input.value));
            if (Number.isFinite(amount)) planned += amount;
        }
        const left = income - planned;
        const short = left < -CENT_TOLERANCE;

        alert.classList.toggle('ant-alert-success', !short);
        alert.classList.toggle('ant-alert-warning', short);
        alert.querySelector('.ant-alert-icon').innerHTML = Ant.icon(short ? 'exclamation-circle' : 'check-circle');
        alert.querySelector('.ant-alert-message').textContent = short
            ? `${money(-left)} more planned than expected income`
            : `${money(left)} unallocated`;
        alert.querySelector('.ant-alert-description').textContent =
            `Expected income ${money(income)} minus ${money(planned)} of targets.`;
    }

    function openSetBudget() {
        const months = completeMonths();
        const incomes = incomeHistory(months);
        const income = median(incomes);

        const { overlay, dialog, close } = Ant.modal({
            title: 'Set Budget',
            width: 600,
            className: 'bud-dialog',
            body: `<div class="bud-dialog-rows">${dialogSectionsHtml(income, incomes.length, recentAverages(months))}</div>
                <div class="ant-alert ant-alert-with-description bud-dialog-alert" role="status" hidden>
                    <span class="ant-alert-icon"></span>
                    <div class="ant-alert-content">
                        <div class="ant-alert-message"></div>
                        <div class="ant-alert-description"></div>
                    </div>
                </div>
                <div class="ant-form-item-explain bud-dialog-error" role="alert"></div>`,
            footer: `<button type="button" class="ant-btn ant-btn-default confirm-cancel">Cancel</button>
                <button type="button" class="ant-btn ant-btn-primary" data-action="save">Save</button>`,
        });
        const saveBtn = dialog.querySelector('[data-action="save"]');
        const error = dialog.querySelector('.bud-dialog-error');

        /** The dialog as the payload the backend takes, or null when a field
         *  holds something that is not an amount. Every row is sent, blank ones
         *  included, so clearing a field really does clear its target. */
        function collect() {
            const budgets = [];
            for (const input of dialog.querySelectorAll('.bud-row-input')) {
                const raw = stripCurrencyValue(input.value);
                const amount = raw === '' ? 0 : parseFloat(raw);
                if (!Number.isFinite(amount) || amount < 0) {
                    input.setAttribute('aria-invalid', 'true');
                    input.focus();
                    return null;
                }
                budgets.push({ category: input.dataset.category, amount });
            }
            return budgets;
        }

        async function submit() {
            if (Ant.isLoading(saveBtn)) return;
            const budgets = collect();
            if (!budgets) {
                error.textContent = 'Enter an amount of 0 or more.';
                return;
            }
            error.textContent = '';

            const res = await Ant.whileLoading(saveBtn, () => apiFetch('/api/budgets', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ budgets }),
            }));
            const body = res ? await res.json().catch(() => ({})) : {};
            if (!res?.ok) {
                console.error('[budgets] save failed:', res?.status, body.error);
                Ant.message.error("Couldn't save your budget — try again.");
                return;
            }
            // The response carries the stored set, so the page never has to
            // guess what landed.
            state.budgets = toBudgetMap(body.budgets);
            close();
            render();
            Ant.message.success('Budget saved');
        }

        overlay.addEventListener('input', (e) => {
            if (!e.target.classList.contains('bud-row-input')) return;
            applyCurrencyFormat(e.target);
            e.target.removeAttribute('aria-invalid');
            error.textContent = '';
            paintAllocation(dialog, income);
        });
        // Enter in any field saves, the way a form would.
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.classList.contains('bud-row-input')) {
                e.preventDefault();
                submit();
            }
        });
        saveBtn.addEventListener('click', submit);

        paintAllocation(dialog, income);
        const first = dialog.querySelector('.bud-row-input');
        if (first) {
            first.focus();
            first.select();
        }
    }

    // ─── Wiring ─────────────────────────────────────────────────────────────

    function wire() {
        els.monthPrev = document.getElementById('bud-month-prev');
        els.monthNext = document.getElementById('bud-month-next');
        els.monthLabel = document.getElementById('bud-month-label');
        els.monthText = document.getElementById('bud-month-text');
        els.viewSwitch = document.getElementById('bud-view');
        els.stats = document.getElementById('bud-stats');
        els.card = document.getElementById('bud-card');
        els.field = document.getElementById('bud-field');
        els.list = document.getElementById('bud-list');
        els.unbudgeted = document.getElementById('bud-unbudgeted');
        els.empty = document.getElementById('bud-empty');

        // Only the fill moves between months: the targets are the same in
        // every month, so the wedges keep their sizes and their places.
        els.monthPrev.addEventListener('click', () => goToMonth(stepYm(state.month, -1)));
        els.monthNext.addEventListener('click', () => {
            const next = stepYm(state.month, 1);
            if (next <= currentYm()) goToMonth(next);
        });
        els.monthLabel.addEventListener('click', (e) => {
            Ant.monthPicker(e.currentTarget, {
                value: state.month,
                max: currentYm(),
                onPick: (ym) => { if (ym !== state.month) goToMonth(ym); },
            });
        });

        els.viewSwitch.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-view]');
            if (!btn || btn.dataset.view === state.view) return;
            state.view = btn.dataset.view;
            render();
        });

        // A row opens its ledger from anywhere on it; the name's own link
        // handles itself.
        els.list.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            const row = e.target.closest('tr[data-href]');
            if (row) location.assign(row.dataset.href);
        });

        document.getElementById('bud-set-btn').addEventListener('click', openSetBudget);
        els.empty.addEventListener('click', (e) => {
            if (e.target.closest('[data-empty-action="set-budget"]')) openSetBudget();
        });

        // The figures are formatted at render time, so a currency change
        // repaints in place rather than needing a reload. A THEME change needs
        // no listener: the rose's colours are rebuilt by the chart kit, and the
        // rest are CSS tokens the swap re-points on its own.
        window.addEventListener('currencychange', render);

        // An import or an edit made on another page invalidates 'ie'; redraw
        // when the fresh statement lands.
        Store.subscribe('ie', (data) => {
            state.statement = data;
            render();
        });
    }

    async function init() {
        wire();
        renderToolbar();

        const cancelSkeleton = UI.skeletonGuard(() => {
            els.empty.hidden = false;
            els.empty.innerHTML = `<div class="ant-card-body">${UI.skRows(4)}</div>`;
        });
        try {
            // Independent reads — the statement is cached and shared with the
            // other pages, the targets are this page's own.
            const [statement] = await Promise.all([Store.ensure('ie'), loadBudgets()]);
            state.statement = statement;
        } catch (err) {
            // A locked database (423) lands here; the shell puts its own prompt
            // over the page, so this only has to leave something coherent
            // underneath.
            console.error('[budgets] could not load', err);
            state.statement = { years: [], entries: {}, columns: [] };
        }
        cancelSkeleton();
        render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
}());
