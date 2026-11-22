'use strict';

// ─── outlook.js ─────────────────────────────────────────────────────────────
// The Analyze workspace, as an Ant Design page: how one plan's money changes
// over its length. The plan is the open one; the dropdown in the header opens
// another. The header also holds the plan's length (the chips the scrubber
// has, which change the plan).
//
//   figures     net worth at the end, its change, take-home pay, spending,
//               growth and interest paid over the run
//   Net worth   stacked areas: accounts above zero, debts below, net worth on
//               top, flagging each goal (set in Goals) the plan meets
//   Cash flow   money in against money out, per year (per month under 3 years)
//   Sankey      where one year's money (or the whole plan's) came from and
//               where it went: into spending, taxes, debts and accounts,
//               then module by module (sankey.js)
//   Table       by year (sortable), year-end balances, and every link's total
//
// Hovering a chart scrubs the plan to that month (PlanStore.setScrub), which the
// canvas and inspector follow.

(function () {
    const C = window.PlanCatalog;
    const D = window.Describe;
    const P = window.PlanModel;
    const G = window.PlanGoals;
    const S = window.PlanSummary;
    const K = window.Components;

    const root = document.getElementById('outlook');
    if (!root) return;

    const PREFS = { view: 'outlook-view', table: 'outlook-table' };

    const VIEWS = [['worth', 'Net worth', 'chart-line'], ['flow', 'Cash flow', 'chart-bar'], ['sankey', 'Sankey', 'flow-arrow'],
        ['table', 'Table', 'table']];
    const TABLES = [['year', 'By year'], ['balances', 'Balances'], ['links', 'Money moved']];
    let view = PlanPrefs.get(PREFS.view, 'worth');
    if (!VIEWS.some(([v]) => v === view)) view = 'worth';
    let tableView = PlanPrefs.get(PREFS.table, 'year');
    if (!TABLES.some(([v]) => v === tableView)) tableView = 'year';
    // The By year table's sort: a column and 'asc' or 'desc', or none (plan order).
    let yearSort = { key: null, dir: null };
    const LENGTHS = PlanStore.LENGTHS;
    // Net worth bands: at most this many per family before the rest fold
    // into "Other". Each band wears its module's role colour (style.css).
    const ACCOUNT_BANDS = 6;
    const DEBT_BANDS = 4;
    const SHADES = 6;   // --chart-<role>-1..6
    // The Sankey's span: a plan year (0-based), or -1 for the whole plan. It
    // starts on the whole plan and goes back to it when the plan's length
    // changes, so the length chips always redraw it; the span menu picks a year.
    let sankeyYear = -1;
    const SANKEY_IN = [1, 2, 3, 4, 5, 6].map((i) => `--plan-sankey-in-${i}`);
    const SANKEY_OUT = [1, 2, 3, 4, 5].map((i) => `--plan-sankey-out-${i}`);
    const SANKEY_FEES = [1, 2, 3, 4].map((i) => `--chart-fee-${i}`);
    const SANKEY_DEBTS = [1, 2, 3, 4, 5, 6].map((i) => `--chart-debt-${i}`);
    const SANKEY_ACCOUNTS = [1, 2, 3, 4, 5, 6].map((i) => `--chart-account-${i}`);

    root.innerHTML = `
        <div class="ws-page scroll-y">
            ${K.pageHead({
                start: K.planPick({ act: 'plan', label: 'Plan to analyze' }),
                extra: K.segmented(LENGTHS.map((y) => [y, `${y}Y`]), null, { attr: 'years', label: 'Plan length', chips: true }),
            })}
            <div class="plan-stat-cards" data-stats></div>
            <section class="ant-card outlook-card" aria-label="Charts and tables">
                <div class="outlook-bar">
                    ${K.tabs(VIEWS, view, { label: 'Analyze view' })}
                    <div class="outlook-tools">
                        <button class="ant-btn ant-btn-default span-btn" type="button" data-act="span" aria-haspopup="menu" aria-expanded="false" hidden>${planIcon('calendar-blank')}<span></span>${planIcon('caret-down')}</button>
                        <div data-table-views hidden>${K.segmented(TABLES, tableView, { attr: 'table', label: 'Table' })}</div>
                    </div>
                </div>
                <div class="chart-pane">
                    <div class="chart-legend"></div>
                    <div class="chart-box"></div>
                </div>
                <div class="outlook-table-wrap ant-table-wrapper" hidden></div>
            </section>
        </div>`;

    const planName = root.querySelector('.plan-pick-name');
    const statsEl = root.querySelector('[data-stats]');
    const pane = root.querySelector('.chart-pane');
    const legendEl = root.querySelector('.chart-legend');
    const box = root.querySelector('.chart-box');
    const tableWrap = root.querySelector('.outlook-table-wrap');
    const spanBtn = root.querySelector('[data-act="span"]');
    const tableViews = root.querySelector('[data-table-views]');

    // Analyze draws only while it is the open workspace.
    const showing = () => PlanStore.state.workspace === 'analyze';

    // ── Values ─────────────────────────────────────────────────────────────

    /** The factor each balance point's money is shown at: 1 throughout (the
     *  money of each month). Every figure reads through these. */
    const deflator = (plan, months) => G.deflator(plan, months);

    const balances = (arr, def) => Float64Array.from(arr, (v, k) => v * def[k]);

    const label = (plan, k) => D.monthLabel(plan, k);
    const money = (v, o) => Fmt.money(v, o);

    /** The plan's age from month `from` to `to`: one age, or a range when a
     *  birthday falls in between. For the top of a chart's tooltip; none when
     *  the plan has no age. */
    function people(plan, from, to = from) {
        const a = P.ageAt(plan, P.ymAdd(plan.settings.start, from));
        const b = P.ageAt(plan, P.ymAdd(plan.settings.start, to));
        return a == null ? [] : [{ name: 'Age', age: a === b ? `${a}` : `${a}–${b}` }];
    }

    /** Bands as the chart shows them, top to bottom. They stack away from
     *  zero in array order, so that is the positives reversed, then the debts. */
    const topDown = (bands) => [...bands.filter((b) => b.sign > 0).reverse(), ...bands.filter((b) => b.sign < 0)];

    /** Account and debt bands in module order (never by size), folded into
     *  an "other" band past each family's limit. Each band wears its module's
     *  role colour (accounts blue, debts red); several of one role take
     *  successive shades of it. What a loan is secured by (a home, a car) is
     *  a band of its own, above the accounts. */
    function worthBands(plan, res, def) {
        const bands = [];
        const accounts = plan.nodes.filter((n) => D.roleOf(n) === 'account');
        const debts = plan.nodes.filter((n) => D.roleOf(n) === 'debt');
        const fold = (list, limit, sign, otherLabel) => {
            list.forEach((n, i) => {
                const values = balances(res.nodes[n.id].balance, def);
                if (i < limit - 1 || list.length === limit) {
                    bands.push({ label: n.name, values, sign, id: n.id, role: D.roleOf(n) });
                } else if (i === limit - 1) {
                    bands.push({ label: otherLabel, values: Float64Array.from(values), sign, other: true });
                } else {
                    const other = bands[bands.length - 1];
                    for (let k = 0; k < values.length; k++) other.values[k] += values[k];
                }
            });
        };
        fold(accounts, ACCOUNT_BANDS, 1, 'Other accounts');
        for (const n of debts) {
            const value = res.nodes[n.id] && res.nodes[n.id].assetValue;
            if (value) bands.push({ label: D.assetLabel(n), values: balances(value, def), sign: 1, id: n.id, role: 'asset' });
        }
        if (res.unassigned.some((v) => v > 0.005)) {
            bands.push({ label: 'Unassigned', values: balances(res.unassigned, def), sign: 1 });
        }
        fold(debts, DEBT_BANDS, -1, 'Other debts');
        const used = {};
        for (const b of bands) {
            if (!b.role) { b.color = '--chart-unassigned'; continue; }
            used[b.role] = (used[b.role] || 0) + 1;
            b.color = `--chart-${b.role}-${((used[b.role] - 1) % SHADES) + 1}`;
        }
        return bands;
    }

    // ── Figures ────────────────────────────────────────────────────────────

    function renderStats(plan, res, def) {
        const f = S.headline(res, def);
        statsEl.innerHTML = [
            K.statCard({ title: `Net worth, ${label(plan, res.months)}`, value: money(f.end), tone: f.end < -0.5 ? 'down' : '' }),
            K.statCard({ title: 'Change', value: money(f.change, { sign: true }), tone: f.change >= 0 ? 'up' : 'down' }),
            K.statCard({ title: 'Take-home pay', value: money(f.takeHome) }),
            K.statCard({ title: 'Spent', value: money(f.spent) }),
            K.statCard({ title: 'Growth', value: money(f.growth), tone: f.growth < -0.5 ? 'down' : '' }),
            K.statCard({ title: 'Interest paid', value: money(f.interest), tone: f.interest > 0.5 ? 'down' : '' }),
        ].join('');
    }

    // ── Charts ─────────────────────────────────────────────────────────────

    function legend(items) {
        legendEl.innerHTML = items.map((it) => `<span class="chart-legend-item"><i class="${it.line ? 'is-line' : ''}" style="--swatch: var(${it.color})"></i>${escapeHtml(it.label)}</span>`).join('');
        legendEl.hidden = !items.length;
    }

    /** A flag for each goal the plan meets after its start, at the month it
     *  is met: its badge in the goal's colour, whose white text it is made
     *  for, its rule in the chart shade of it. Goals met from the start are
     *  not events; one met after its deadline says so. */
    function goalMarkers(plan, res) {
        const goals = PlanStore.state.goals;
        if (!goals.length) return [];
        const evs = G.evaluate(plan, res, goals);
        const out = [];
        goals.forEach((g, n) => {
            const ev = evs[n];
            if (!ev.month) return;
            const late = ev.status === 'late';
            out.push({
                i: ev.month, month: ev.month, name: g.name, late,
                label: late ? `${g.name} (late)` : g.name,
                color: `--goal-${g.color}-mark`,
                fill: `--goal-${g.color}`,
            });
        });
        return out;
    }

    function drawWorth(plan, res, def) {
        const count = res.months + 1;
        const bands = worthBands(plan, res, def);
        const worth = balances(res.netWorth, def);
        const markers = goalMarkers(plan, res);
        const listed = topDown(bands);
        // The legend names the bands that hold something at some point.
        const shown = listed.filter((b) => b.values.some((v) => Math.abs(v) > 0.5));
        legend([{ label: 'Net worth', color: '--chart-worth-line', line: true }, ...shown.map((b) => ({ label: b.label, color: b.color }))]);
        PlanChart.draw(box, {
            kind: 'area',
            label: 'Net worth over time',
            count,
            xTicks: PlanChart.yearTicks(plan, count),
            bands,
            line: { label: 'Net worth', color: '--chart-worth-line', values: worth },
            markers,
            format: (v) => money(v, { compact: true }),
            tooltip: (k) => ({
                people: people(plan, k),
                title: label(plan, k),
                rows: [
                    ...listed.filter((b) => Math.abs(b.values[k]) > 0.5).map((b) => ({
                        label: b.label, color: b.color, value: money(b.sign < 0 ? -b.values[k] : b.values[k]),
                    })),
                    { label: 'Net worth', color: '--chart-worth-line', value: money(worth[k]), total: true },
                    ...markers.filter((mk) => mk.i === k).map((mk) => ({
                        label: `${mk.name} met${mk.late ? ' late' : ''}`, color: mk.color, value: label(plan, mk.month),
                    })),
                ],
            }),
            onHover: (k) => PlanStore.setScrub(k),
        });
    }

    function drawFlow(plan, res, def) {
        const F = res.flows;
        const months = res.months;
        const yearly = months >= 36;
        const size = yearly ? 12 : 1;
        const count = Math.ceil(months / size);
        const agg = (fn) => {
            const out = new Float64Array(count);
            for (let m = 0; m < months; m++) out[Math.floor(m / size)] += fn(m) * def[m + 1];
            return out;
        };
        const income = agg((m) => F.earned[m] - F.withheld[m] + F.match[m] + F.cashback[m]);
        const growth = agg((m) => Math.max(0, F.growth[m]));
        const spent = agg((m) => F.spent[m] + F.skimmed[m]);
        const cost = agg((m) => F.interest[m] + Math.max(0, -F.growth[m]));
        const net = Float64Array.from(income, (v, i) => v + growth[i] - spent[i] - cost[i]);
        const bars = [
            { label: 'Income', color: '--chart-in', values: income, sign: 1 },
            { label: 'Growth', color: '--chart-growth', values: growth, sign: 1 },
            { label: 'Spending', color: '--chart-out', values: spent, sign: -1 },
            { label: 'Interest and losses', color: '--chart-interest', values: cost, sign: -1 },
        ].filter((b) => b.values.some((v) => v > 0.5));
        legend([...bars, { label: 'Net change', color: '--chart-networth', line: true }]);
        const periodLabel = (i) => yearly
            ? `${label(plan, i * 12)} to ${label(plan, Math.min(months, (i + 1) * 12) - 1)}`
            : label(plan, i);
        const ticks = yearly
            ? Array.from({ length: count }, (_, i) => ({ i, label: `Y${i + 1}` })).filter((_, i) => count <= 12 || i % Math.ceil(count / 10) === 0)
            : Array.from({ length: count }, (_, i) => ({ i, label: P.MONTHS[P.ymParse(P.ymAdd(plan.settings.start, i)).m - 1] })).filter((_, i) => i % 3 === 0);
        PlanChart.draw(box, {
            kind: 'bars',
            label: 'Cash flow by period',
            count,
            xTicks: ticks,
            bars,
            line: { label: 'Net change', color: '--chart-networth', values: net },
            format: (v) => money(v, { compact: true }),
            tooltip: (i) => ({
                people: people(plan, i * size, Math.min(months, (i + 1) * size) - 1),
                title: periodLabel(i),
                rows: [
                    ...bars.map((b) => ({ label: b.label, color: b.color, value: money(b.sign < 0 ? -b.values[i] : b.values[i]) })),
                    { label: 'Net change', color: '--chart-networth', value: money(net[i], { sign: true }), total: true },
                ],
            }),
            onHover: (i) => PlanStore.setScrub(i == null ? null : Math.min(months, (i + 1) * size)),
        });
    }

    // ── Sankey ─────────────────────────────────────────────────────────────

    /** The spans the Sankey offers: the whole plan, then each calendar year
     *  it touches ("2026"). A plan starting mid-year has a short first year. */
    function sankeySpans(plan, months) {
        const start = P.ymParse(plan.settings.start);
        const startMonth = start ? start.m - 1 : 0;
        const firstYear = start ? start.y : 0;
        const spans = [];
        for (let from = 0; from < months;) {
            const to = Math.min(months, from + 12 - ((startMonth + from) % 12));
            const y = firstYear + Math.floor((startMonth + from) / 12);
            spans.push({ year: spans.length, from, to, label: start ? String(y) : `Year ${spans.length + 1}` });
            from = to;
        }
        if (spans.length > 1) {
            const range = `${spans[0].label}–${spans[spans.length - 1].label}`;
            spans.unshift({ year: -1, from: 0, to: months, label: start ? `All years, ${range}` : `All ${spans.length} years` });
        }
        return spans;
    }

    /** The chosen span; a year past a shortened plan (or the whole of a
     *  one-year plan) falls back to its last year. */
    function currentSpan(plan, months) {
        const spans = sankeySpans(plan, months);
        const years = spans.filter((s) => s.year >= 0);
        return spans.find((s) => s.year === sankeyYear) || years[years.length - 1];
    }

    /** Where the money in months [from, to) came from and where it went.
     *
     *  In: gross income, match, cash back and account growth, plus money drawn
     *  back out of an account or borrowed on a debt over the span.
     *  Out, in groups: spending, taxes and fees (withholding included),
     *  debts (interest, fees and principal paid down), what each account
     *  kept, and losses.
     *
     *  A balance's part is its change over the span, so the two sides agree
     *  to the cent: net worth is accounts + Unassigned - debts, and the
     *  engine's conservation rule makes the flows explain its change. Each
     *  month's step is deflated like that month's flows, which keeps the
     *  identity whatever factor the money is shown at. */
    function sankeyFlows(plan, res, def, from, to) {
        const total = (arr) => {
            let s = 0;
            if (arr) for (let m = from; m < to; m++) s += arr[m] * def[m + 1];
            return s;
        };
        const change = (bal) => {
            let s = 0;
            for (let m = from; m < to; m++) s += (bal[m + 1] - bal[m]) * def[m + 1];
            return s;
        };
        const left = [];
        const group = (name, color, ramp) => ({ label: name, color, ramp, items: [] });
        const spending = group('Spending', '--chart-outflow-1', SANKEY_OUT);
        const fees = group('Taxes and fees', '--chart-fee-1', SANKEY_FEES);
        const debts = group('Debts', '--chart-debt-1', SANKEY_DEBTS);
        const losses = group('Losses', '--chart-interest', SANKEY_DEBTS);
        const accounts = group('Accounts', '--chart-account-1', SANKEY_ACCOUNTS);
        const add = (list, name, value, id, extra) => { if (value > 0.005) list.push({ label: name, value, id, ...extra }); };

        for (const n of plan.nodes) {
            const r = res.nodes[n.id];
            if (!r) continue;
            switch (D.roleOf(n)) {
                case 'source': {
                    // Gross pay in; what is withheld goes out again as a tax.
                    const gross = total(r.gross);
                    const withheld = gross - total(r.produced);
                    add(left, n.name, gross, n.id, withheld > 0.5 ? { note: `Withheld ${money(withheld)}` } : null);
                    add(fees.items, `${n.name} withholding`, withheld, n.id);
                    break;
                }
                case 'expense':
                    add(spending.items, n.name, total(r.consumed), n.id);
                    break;
                case 'modifier':
                    // What a budget group keeps is spending.
                    add(spending.items, n.name, total(r.consumed), n.id);
                    break;
                case 'account': {
                    add(left, `${n.name} match`, total(r.matched), n.id);
                    const growth = total(r.earnings);
                    if (growth >= 0) add(left, `${n.name} growth`, growth, n.id);
                    else add(losses.items, n.name, -growth, n.id);
                    const kept = change(r.balance);
                    if (kept >= 0) add(accounts.items, n.name, kept, n.id);
                    else add(left, `From ${n.name}`, -kept, n.id, { color: '--chart-account-1', pinned: true });
                    break;
                }
                case 'debt': {
                    add(left, `${n.name} cash back`, total(r.cashback), n.id);
                    const interest = total(r.interest);
                    const fee = total(r.fees);
                    const paidDown = -change(r.balance);
                    const note = [['Interest', interest], ['Fees', fee], ['Paid down', paidDown]]
                        .filter(([, v]) => v > 0.5).map(([k, v]) => `${k} ${money(v)}`).join(', ');
                    add(debts.items, n.name, interest + fee + Math.max(0, paidDown), n.id, { note });
                    if (paidDown < 0) add(left, `Borrowed on ${n.name}`, -paidDown, n.id, { color: '--chart-debt-1', pinned: true });
                    break;
                }
            }
        }
        const pool = change(res.unassigned);
        if (pool >= 0) add(accounts.items, 'Unassigned', pool, null, { color: '--chart-unassigned' });
        else add(left, 'From Unassigned', -pool, null, { color: '--chart-unassigned', pinned: true });

        return { left, groups: [spending, fees, debts, losses, accounts] };
    }

    function drawSankey(plan, res, def) {
        const span = currentSpan(plan, res.months);
        spanBtn.querySelector('span').textContent = span.label;
        legend([]);
        const { left, groups } = sankeyFlows(plan, res, def, span.from, span.to);
        PlanSankey.draw(box, {
            label: `Where the money came from and went, ${span.label}`,
            left,
            groups,
            inRamp: SANKEY_IN,
            hubLabel: 'Money in',
            hubColor: '--chart-hub',
            otherLabel: 'Other',
            format: (v) => money(v),
            empty: 'Add income and spending to see where the money goes.',
            onSelect: (id) => PlanStore.select({ kind: 'node', id }),
        });
    }

    // ── Tables ─────────────────────────────────────────────────────────────

    const esc = escapeHtml;
    const td = (v, { negative = false } = {}) => `<td class="is-num${negative ? ' is-negative' : ''}">${esc(money(v))}</td>`;

    /** A sortable column's header: the cell holds a button that cycles
     *  ascending, descending and plan order, as Ant's sorter does. */
    function sortHeader(key, name) {
        const dir = yearSort.key === key ? yearSort.dir : null;
        const sort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
        return `<th scope="col" class="is-num" aria-sort="${sort}"><button class="th-sort" type="button" data-sort="${key}"${dir ? ` data-dir="${dir}"` : ''}>
            <span>${esc(name)}</span><span class="sort-caret" aria-hidden="true">${planIcon('caret-up')}${planIcon('caret-down')}</span></button></th>`;
    }

    /** A row per plan year (PlanSummary.years), in the table's sort. */
    function yearRows(plan, res, def) {
        const rows = S.years(plan, res, def);
        if (yearSort.key) {
            const k = yearSort.key;
            rows.sort((a, b) => (yearSort.dir === 'asc' ? a[k] - b[k] : b[k] - a[k]));
        }
        return { rows, hasAge: plan.settings.age != null };
    }

    function yearTable(plan, res, def) {
        const { rows, hasAge } = yearRows(plan, res, def);
        const sorted = (key) => (yearSort.key === key ? ' is-sorted' : '');
        const num = (key, v, o = {}) => `<td class="is-num${sorted(key)}${o.negative ? ' is-negative' : ''}">${esc(money(v, o.sign ? { sign: true } : undefined))}</td>`;
        return `<table class="ant-table plan-table ant-table-middle">
            <caption class="ant-visually-hidden">The plan year by year</caption>
            <thead><tr>
                <th scope="col" class="is-sticky">Year</th>
                ${hasAge ? '<th scope="col" class="is-num">Age</th>' : ''}
                ${sortHeader('takeHome', 'Take-home pay')}${sortHeader('spent', 'Spent')}${sortHeader('growth', 'Growth')}
                ${sortHeader('interest', 'Interest')}${sortHeader('change', 'Net change')}${sortHeader('worth', 'Net worth at end')}
            </tr></thead>
            <tbody>${rows.map((r) => `<tr>
                <th scope="row" class="is-sticky"><span class="year-cell">Y${r.year}<span>${esc(label(plan, r.from))}</span></span></th>
                ${hasAge ? `<td class="is-num">${r.age == null ? '—' : esc(String(r.age))}</td>` : ''}
                ${num('takeHome', r.takeHome)}${num('spent', r.spent)}${num('growth', r.growth, { negative: r.growth < -0.5 })}
                ${num('interest', r.interest)}${num('change', r.change, { sign: true, negative: r.change < -0.5 })}
                ${num('worth', r.worth, { negative: r.worth < -0.5 })}
            </tr>`).join('')}</tbody>
        </table>`;
    }

    function balancesTable(plan, res, def) {
        const months = res.months;
        const points = [0];
        for (let k = 12; k <= months; k += 12) points.push(k);
        if (points[points.length - 1] !== months) points.push(months);
        const holders = plan.nodes.filter((n) => C.ROLES[D.roleOf(n)].holds);
        // Debts show as negatives; an overdrawn account is one too.
        const cell = (v, neg) => {
            const shown = neg ? -v : v;
            return td(shown, { negative: shown < -0.5 });
        };
        const nameCell = (n) => `<th scope="row" class="is-sticky"><span class="cell-name"><span class="role-tile role-tile--sm" data-role="${D.swatchOf(n)}">${planIcon(P.iconOf(n))}</span>${esc(n.name)}</span></th>`;
        let html = `<table class="ant-table plan-table ant-table-middle"><caption class="ant-visually-hidden">Balances</caption><thead><tr><th scope="col" class="is-sticky">Balance</th>${
            points.map((k) => `<th scope="col" class="is-num">${esc(label(plan, k))}</th>`).join('')}</tr></thead><tbody>`;
        for (const n of holders) {
            const b = res.nodes[n.id].balance;
            const neg = D.roleOf(n) === 'debt';
            html += `<tr>${nameCell(n)}${points.map((k) => cell(b[k] * def[k], neg)).join('')}</tr>`;
            const value = res.nodes[n.id].assetValue;
            if (value) {
                html += `<tr><th scope="row" class="is-sticky"><span class="cell-name"><span class="role-tile role-tile--sm" data-role="account">${planIcon(P.iconOf(n))}</span>${esc(D.assetLabel(n))}</span></th>${
                    points.map((k) => cell(value[k] * def[k], false)).join('')}</tr>`;
            }
        }
        if (res.unassigned.some((v) => v > 0.005)) {
            html += `<tr><th scope="row" class="is-sticky">Unassigned</th>${points.map((k) => cell(res.unassigned[k] * def[k], false)).join('')}</tr>`;
        }
        html += `<tr class="is-total"><th scope="row" class="is-sticky">Net worth</th>${points.map((k) => td(res.netWorth[k] * def[k], { negative: res.netWorth[k] < -0.5 })).join('')}</tr></tbody></table>`;
        return html;
    }

    function linksTable(plan, res, def) {
        const months = res.months;
        // A two-way link's way back is a row of its own, running the other way.
        const linksSorted = plan.links
            .flatMap((l) => {
                const r = res.links[l.id];
                const from = PlanStore.node(l.from);
                const to = PlanStore.node(l.to);
                if (!r || !from || !to) return [];
                const rows = [{ r, from, to, rule: D.linkShort(l, from) }];
                if (r.back) rows.push({ r: r.back, from: to, to: from, rule: D.backShort(l, to) });
                return rows;
            })
            .sort((a, b) => b.r.total - a.r.total);
        let html = `<table class="ant-table plan-table ant-table-middle"><caption class="ant-visually-hidden">Money moved</caption><thead><tr><th scope="col" class="is-sticky">Money moved</th>
            <th scope="col">Rule</th><th scope="col" class="is-num">Total</th><th scope="col" class="is-num">Average a month</th><th scope="col">First</th><th scope="col">Last</th></tr></thead><tbody>`;
        for (const { r, from, to, rule } of linksSorted) {
            let total = 0;
            for (let m = 0; m < r.flow.length; m++) total += r.flow[m] * def[m + 1];
            const first = r.flow.findIndex((v) => v > 0.005);
            let lastIdx = -1;
            for (let m = r.flow.length - 1; m >= 0; m--) if (r.flow[m] > 0.005) { lastIdx = m; break; }
            html += `<tr><th scope="row" class="is-sticky">${esc(from.name)} → ${esc(to.name)}</th>
                <td>${esc(rule)}</td>
                ${td(total)}${td(total / months)}
                <td>${first >= 0 ? esc(label(plan, first)) : '<span class="is-muted">Never</span>'}</td>
                <td>${lastIdx >= 0 ? esc(label(plan, lastIdx)) : '<span class="is-muted">Never</span>'}</td></tr>`;
        }
        html += '</tbody></table>';
        return html;
    }

    function renderTables(plan, res, def) {
        if (tableView === 'balances') tableWrap.innerHTML = balancesTable(plan, res, def);
        else if (tableView === 'links') tableWrap.innerHTML = linksTable(plan, res, def);
        else tableWrap.innerHTML = yearTable(plan, res, def);
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function renderHead() {
        const plan = PlanStore.state.plan;
        const { activeId } = PlanStore.state;
        const name = activeId ? PlanStore.planName(activeId) : '';
        planName.textContent = name;
        root.querySelector('[data-act="plan"]').setAttribute('aria-label', `Plan to analyze: ${name}`);
        root.querySelectorAll('[data-tab]').forEach((b) => {
            const on = b.dataset.tab === view;
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
        });
        root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(!!plan && Number(b.dataset.years) === PlanStore.state.years)));
        root.querySelectorAll('[data-table]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.table === tableView)));
        spanBtn.hidden = view !== 'sankey';
        tableViews.hidden = view !== 'table';
        pane.classList.toggle('is-sankey', view === 'sankey');
    }

    function render() {
        if (!showing()) return;
        renderHead();
        const plan = PlanStore.state.plan;
        const res = PlanStore.state.results;
        if (!plan || !res) return;
        // A redraw (a resize) can land in the frame between an edit that adds a
        // module and its run; the run that follows draws it.
        if (plan.nodes.some((n) => !res.nodes[n.id])) return;
        const def = deflator(plan, res.months);
        renderStats(plan, res, def);
        const isTable = view === 'table';
        pane.hidden = isTable;
        tableWrap.hidden = !isTable;
        if (isTable) renderTables(plan, res, def);
        else if (view === 'flow') drawFlow(plan, res, def);
        else if (view === 'sankey') drawSankey(plan, res, def);
        else drawWorth(plan, res, def);
    }

    // ── Input ──────────────────────────────────────────────────────────────

    function showView(next) {
        view = next;
        PlanPrefs.set(PREFS.view, view);
        PlanStore.setScrub(null);
        render();
    }

    root.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { showView(tab.dataset.tab); return; }
        const y = e.target.closest('[data-years]');
        if (y) {
            const years = Number(y.dataset.years);
            sankeyYear = -1;
            PlanStore.setYears(years);
            return;
        }
        const t = e.target.closest('[data-table]');
        if (t) {
            tableView = t.dataset.table;
            PlanPrefs.set(PREFS.table, tableView);
            render();
            return;
        }
        const sort = e.target.closest('[data-sort]');
        if (sort) {
            const key = sort.dataset.sort;
            const next = yearSort.key !== key ? 'asc' : yearSort.dir === 'asc' ? 'desc' : null;
            yearSort = next ? { key, dir: next } : { key: null, dir: null };
            render();
            root.querySelector(`[data-sort="${key}"]`)?.focus();
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        switch (act.dataset.act) {
            case 'plan': {
                const { tabs, activeId } = PlanStore.state;
                Ant.dropdown(act, {
                    items: tabs.map((id) => ({
                        label: PlanStore.planName(id),
                        iconHtml: planIcon(id === activeId ? 'check' : 'file'),
                        selected: id === activeId,
                        onClick: () => PlanStore.openPlan(id),
                    })),
                });
                return;
            }
            case 'span': {
                const plan = PlanStore.state.plan;
                const res = PlanStore.state.results;
                if (!plan || !res) return;
                const current = currentSpan(plan, res.months);
                const items = sankeySpans(plan, res.months).map((s) => ({
                    label: s.label,
                    iconHtml: planIcon(s.year === current.year ? 'check' : 'calendar-blank'),
                    selected: s.year === current.year,
                    onClick: () => { sankeyYear = s.year; render(); },
                }));
                if (items.length > 1) items.splice(1, 0, { type: 'divider' });
                Ant.dropdown(act, { items, align: 'end' });
                return;
            }
        }
    });

    // Arrow keys move along the tabs, as Ant's Tabs do.
    root.querySelector('.plan-tabs-nav').addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = VIEWS.findIndex(([v]) => v === view);
        const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length][0];
        showView(next);
        root.querySelector(`[data-tab="${next}"]`).focus();
    });

    // Redraw when the chart's box changes size (window resize, the navigation
    // or inspector toggled). Coalesced to one draw per frame.
    let resizeQueued = false;
    new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            if (view !== 'table') render();
        });
    }).observe(box);

    // Goals redraw the Net worth chart, which flags the ones met.
    PlanStore.on((c) => {
        if (c.type === 'results' || c.type === 'goals' || c.type === 'workspace') render();
        else if (!showing()) return;
        else if (c.type === 'plan' || c.type === 'tabs') renderHead();
    });

    window.Outlook = { render };
}());
