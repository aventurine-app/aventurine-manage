'use strict';

// ─── report.js ──────────────────────────────────────────────────────────────
// The PDF report: a printable summary of one plan or all of them. The page
// draws it and Electron prints the page to a PDF file (main.js
// 'plan-save-pdf'), which keeps the fonts, any script in a plan's name and
// vector charts, with no PDF library in the page.
//
// Each plan gets its own pages:
//   - its name, span and the date of the report
//   - the headline figures (PlanSummary.headline)
//   - net worth over time: accounts stacked above zero, debts below, and the
//     net worth line
//   - cash flow by year: money in above zero, money out below
//   - each goal, its rule and whether this plan meets it
//   - the plan year by year (PlanSummary.years)
//   - every account's and debt's balance at the start and the end
//
// The report is built into a <div class="report"> at the end of <body>, which
// report.css shows only in print media (and hides everything else), and taken
// away once the PDF is written. It is drawn in fixed light colours, whatever
// the app's theme, because it is paper.
//
//   PlanReport.save({ entries: [{ plan, results }], goals, title })
//
// The charts are Apache ECharts' server-side SVG (svgChart below).
//
// Needs: escapeHtml, Fmt, PlanModel, PlanEngine, PlanGoals, PlanSummary, Describe,
// echarts (vendor/echarts).
// Used by plan/export-menu.js.

(function () {
    const P = window.PlanModel;
    const G = window.PlanGoals;
    const S = window.PlanSummary;
    const D = window.Describe;
    const esc = escapeHtml;

    // Ant Design's light palettes. Accounts are blues and debts reds, as in
    // the app; the cash flow's colours are its role colours.
    const ACCOUNT_SHADES = ['#0958d9', '#1677ff', '#4096ff', '#69b1ff', '#91caff', '#bae0ff'];
    const DEBT_SHADES = ['#a8071a', '#cf1322', '#ff4d4f', '#ffa39e'];
    const UNASSIGNED = '#bfbfbf';
    const ASSET_SHADES = ['#389e0d', '#73d13d', '#237804', '#95de64'];
    const LINE = '#1f1f1f';
    const FLOW = { income: '#08979c', growth: '#722ed1', spent: '#ad6800', interest: '#a8071a' };
    const GRID = '#e5e5e5';
    const AXIS_TEXT = '#595959';

    // The chart frame, in SVG units (the chart scales to the page's width).
    const W = 720;
    const H = 240;
    const M = { top: 8, right: 8, bottom: 22, left: 64 };

    const money = (v, o) => Fmt.money(v, o);
    const compact = (v) => Fmt.money(v, { compact: true });
    const monthLabel = (plan, k) => P.ymLabel(P.ymAdd(plan.settings.start, k));

    /** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [lo, hi] in about five steps. */
    function niceTicks(lo, hi, count = 5) {
        if (hi - lo < 1e-9) hi = lo + 1;
        const raw = (hi - lo) / count;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
        const ticks = [];
        for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step * 1e-6; v += step) {
            ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        }
        return ticks;
    }

    /** The value axis for values from lo to hi: ticks, dashed grid, the zero
     *  line solid. */
    function valueAxis(lo, hi) {
        // A sliver on one side of zero (a small card balance under a large net
        // worth) would add a whole empty tick step; it is drawn against the zero line instead.
        const span = Math.max(Math.abs(lo), Math.abs(hi));
        if (lo < 0 && -lo < span * 0.02) lo = 0;
        if (hi > 0 && hi < span * 0.02) hi = 0;
        const ticks = niceTicks(Math.min(0, lo), Math.max(0, hi));
        return {
            type: 'value',
            min: ticks[0],
            max: ticks[ticks.length - 1],
            interval: ticks.length > 1 ? ticks[1] - ticks[0] : undefined,
            axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: (v) => compact(v), margin: 8 },
            splitLine: { lineStyle: { color: GRID, type: [3, 3] } },
        };
    }

    /** One chart as vector SVG, rendered by Apache ECharts with no DOM (its
     *  server-side renderer), so the printed PDF keeps sharp lines and text.
     *  Paper colours: the report is drawn in fixed light colours whatever the
     *  app's theme (see the top of this file). */
    function svgChart(label, option) {
        const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: W, height: H });
        try {
            chart.setOption({
                animation: false,
                textStyle: { fontFamily: getComputedStyle(document.body).fontFamily },
                grid: { left: M.left, right: M.right, top: M.top, bottom: M.bottom, containLabel: false },
                ...option,
            });
            return `<div class="report-chart" role="img" aria-label="${esc(label)}">${chart.renderToSVGString({ useViewBox: true })}</div>`;
        } finally {
            chart.dispose();
        }
    }

    /** The x axis: one category per point, labelled only where `labelAt` has one. */
    function categoryAxis(count, labelAt, boundaryGap) {
        return {
            type: 'category',
            boundaryGap,
            data: Array.from({ length: count }, (_, i) => i),
            axisLine: { lineStyle: { color: '#8c8c8c' } },
            axisTick: { show: false },
            axisLabel: {
                color: AXIS_TEXT, fontSize: 11,
                interval: (i) => labelAt.has(i),
                formatter: (_v, i) => labelAt.get(i) || '',
            },
        };
    }

    function legend(items) {
        return `<div class="report-legend">${items.map((it) => `<span><i class="${it.line ? 'is-line' : ''}" style="background:${it.color}"></i>${esc(it.label)}</span>`).join('')}</div>`;
    }

    // ── Net worth ──────────────────────────────────────────────────────────

    /** Bands in module order, folded into "Other" past `limit`. */
    function fold(list, limit, otherLabel, values) {
        const bands = [];
        list.forEach((n, i) => {
            const v = values(n);
            if (i < limit - 1 || list.length === limit) bands.push({ label: n.name, values: Float64Array.from(v) });
            else if (i === limit - 1) bands.push({ label: otherLabel, values: Float64Array.from(v) });
            else for (let k = 0; k < v.length; k++) bands[bands.length - 1].values[k] += v[k];
        });
        return bands;
    }

    function worthChart(plan, res) {
        const count = res.months + 1;
        const of = (role) => plan.nodes.filter((n) => P.roleOf(n) === role && res.nodes[n.id]);
        const ups = fold(of('account'), ACCOUNT_SHADES.length, 'Other accounts', (n) => res.nodes[n.id].balance)
            .map((b, i) => ({ ...b, color: ACCOUNT_SHADES[i] }));
        of('debt').filter((n) => res.nodes[n.id].assetValue).forEach((n, i) => ups.push({
            label: `${n.name} asset`, values: res.nodes[n.id].assetValue, color: ASSET_SHADES[i % ASSET_SHADES.length] }));
        if (res.unassigned.some((v) => Math.abs(v) > 0.005)) ups.push({ label: 'Unassigned', values: res.unassigned, color: UNASSIGNED });
        const downs = fold(of('debt'), DEBT_SHADES.length, 'Other debts', (n) => res.nodes[n.id].balance)
            .map((b, i) => ({ ...b, color: DEBT_SHADES[i] }));

        // Stack away from zero: an overdrawn account (below zero) stacks down,
        // which is ECharts' same-sign stacking.
        const all = [...ups.map((b) => [b, 1]), ...downs.map((b) => [b, -1])]
            .filter(([b]) => b.values.some((v) => Math.abs(v) > 0.5));
        const worth = res.netWorth;
        const up = new Float64Array(count);
        const down = new Float64Array(count);
        for (const [band, sign] of all) {
            for (let k = 0; k < count; k++) {
                const v = band.values[k] * sign;
                if (v >= 0) up[k] += v; else down[k] += v;
            }
        }
        let lo = Math.min(...down);
        let hi = Math.max(...up);
        for (const v of worth) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const chart = svgChart('Net worth over time', {
            xAxis: categoryAxis(count, yearLabels(plan, count), false),
            yAxis: valueAxis(lo, hi),
            series: [
                ...all.map(([band, sign]) => ({
                    type: 'line', stack: 'bands', symbol: 'none', color: band.color,
                    lineStyle: { width: 0 }, areaStyle: { color: band.color, opacity: 1 },
                    data: Array.from(band.values, (v) => v * sign),
                })),
                { type: 'line', symbol: 'none', color: LINE, lineStyle: { width: 2 }, data: Array.from(worth) },
            ],
        });
        const shown = all.map(([b]) => b);
        return `${chart}
            ${legend([{ label: 'Net worth', color: LINE, line: true }, ...shown.map((b) => ({ label: b.label, color: b.color }))])}`;
    }

    /** Year labels at each January, at most about ten: Map<index, year>. */
    function yearLabels(plan, count) {
        const startMonth = P.ymParse(plan.settings.start).m - 1;
        const startYear = P.ymParse(plan.settings.start).y;
        const years = Math.ceil(count / 12);
        const every = Math.max(1, Math.ceil(years / 10));
        const out = new Map();
        for (let k = (12 - startMonth) % 12; k < count; k += 12) {
            const year = startYear + Math.floor((startMonth + k) / 12);
            if ((year - startYear) % every) continue;
            out.set(k, String(year));
        }
        return out;
    }

    // ── Cash flow ──────────────────────────────────────────────────────────

    function flowChart(plan, res) {
        const F = res.flows;
        const months = res.months;
        const yearly = months > 24;
        const size = yearly ? 12 : 1;
        const count = Math.ceil(months / size);
        const agg = (fn) => {
            const out = new Float64Array(count);
            for (let m = 0; m < months; m++) out[Math.floor(m / size)] += fn(m);
            return out;
        };
        const bars = [
            { label: 'Income', color: FLOW.income, sign: 1, values: agg((m) => F.earned[m] - F.withheld[m] + F.match[m] + F.cashback[m]) },
            { label: 'Growth', color: FLOW.growth, sign: 1, values: agg((m) => Math.max(0, F.growth[m])) },
            { label: 'Spending', color: FLOW.spent, sign: -1, values: agg((m) => F.spent[m] + F.skimmed[m]) },
            { label: 'Interest and losses', color: FLOW.interest, sign: -1, values: agg((m) => F.interest[m] + Math.max(0, -F.growth[m])) },
        ].filter((b) => b.values.some((v) => v > 0.5));
        const net = Array.from({ length: count }, (_, i) => bars.reduce((s, b) => s + b.sign * b.values[i], 0));
        let hi = 0;
        let lo = 0;
        for (let i = 0; i < count; i++) {
            hi = Math.max(hi, bars.filter((b) => b.sign > 0).reduce((s, b) => s + b.values[i], 0));
            lo = Math.min(lo, -bars.filter((b) => b.sign < 0).reduce((s, b) => s + b.values[i], 0));
        }
        const every = Math.max(1, Math.ceil(count / 12));
        const labels = new Map();
        for (let i = 0; i < count; i += every) {
            labels.set(i, yearly ? `Y${i + 1}` : P.MONTHS[P.ymParse(P.ymAdd(plan.settings.start, i)).m - 1]);
        }
        const chart = svgChart(yearly ? 'Cash flow by year' : 'Cash flow by month', {
            xAxis: categoryAxis(count, labels, true),
            yAxis: valueAxis(lo, hi),
            series: [
                ...bars.map((b) => ({
                    type: 'bar', stack: 'flow', color: b.color, barCategoryGap: '40%',
                    data: Array.from(b.values, (v) => (v > 0.5 ? b.sign * v : null)),
                })),
                { type: 'line', symbol: 'none', color: LINE, lineStyle: { width: 2 }, data: net },
            ],
        });
        return `${chart}
            ${legend([...bars.map((b) => ({ label: b.label, color: b.color })), { label: 'Net change', color: LINE, line: true }])}`;
    }

    // ── Tables ─────────────────────────────────────────────────────────────

    const num = (v, o) => `<td class="is-num${v < -0.5 ? ' is-negative' : ''}">${esc(money(v, o))}</td>`;

    function headlineFigures(plan, res) {
        const f = S.headline(res);
        const stat = (title, value) => `<div class="report-stat"><div class="report-stat-title">${esc(title)}</div><div class="report-stat-value">${esc(value)}</div></div>`;
        return `<div class="report-stats">
            ${stat(`Net worth, ${monthLabel(plan, res.months)}`, money(f.end))}
            ${stat('Change', money(f.change, { sign: true }))}
            ${stat('Take-home pay', money(f.takeHome))}
            ${stat('Spent', money(f.spent))}
            ${stat('Growth', money(f.growth))}
            ${stat('Interest paid', money(f.interest))}
        </div>`;
    }

    /** Goals are judged over the goal horizon, not the length the report
     *  covers, so their statuses match the Goals page. */
    function goalsTable(plan, goals) {
        if (!goals.length) return '';
        let res = null;
        try {
            res = window.PlanEngine.simulate(G.horizon(plan));
        } catch (e) {
            console.error('[report] goal run failed', plan.id, e);
        }
        if (!res) return '';
        const evs = G.evaluate(plan, res, goals);
        const rows = goals.map((goal, i) => {
            const st = D.goalStatus(evs[i], plan);
            return `<tr><th scope="row">${esc(goal.name)}</th><td>${esc(D.goalSentence(goal))}</td>
                <td>${esc(st.text)}${st.detail ? `<div class="report-muted">${esc(st.detail)}</div>` : ''}</td></tr>`;
        }).join('');
        return `<h3>Goals</h3><table class="report-table"><thead><tr><th scope="col">Goal</th><th scope="col">Rule</th><th scope="col">In this plan</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function yearTable(plan, res) {
        const rows = S.years(plan, res);
        const hasAge = plan.settings.age != null;
        return `<h3>Year by year</h3><table class="report-table"><thead><tr>
            <th scope="col">Year</th>${hasAge ? '<th scope="col" class="is-num">Age</th>' : ''}
            <th scope="col" class="is-num">Take-home pay</th><th scope="col" class="is-num">Spent</th><th scope="col" class="is-num">Growth</th>
            <th scope="col" class="is-num">Interest</th><th scope="col" class="is-num">Net change</th><th scope="col" class="is-num">Net worth at end</th>
        </tr></thead><tbody>${rows.map((r) => `<tr>
            <th scope="row">Y${r.year} <span class="report-muted">${esc(monthLabel(plan, r.from))}</span></th>
            ${hasAge ? `<td class="is-num">${r.age == null ? '—' : esc(String(r.age))}</td>` : ''}
            ${num(r.takeHome)}${num(r.spent)}${num(r.growth)}${num(r.interest)}${num(r.change, { sign: true })}${num(r.worth)}
        </tr>`).join('')}</tbody></table>`;
    }

    function balancesTable(plan, res) {
        const holders = plan.nodes.filter((n) => ['account', 'debt'].includes(P.roleOf(n)) && res.nodes[n.id]);
        if (!holders.length) return '';
        const n = res.months;
        const rows = holders.map((node) => {
            const b = res.nodes[node.id].balance;
            const debt = P.roleOf(node) === 'debt';
            const a = res.nodes[node.id].assetValue;
            return `<tr><th scope="row">${esc(node.name)}</th><td>${debt ? 'Debt' : 'Account'}</td>${num(debt ? -b[0] : b[0])}${num(debt ? -b[n] : b[n])}</tr>`
                + (a ? `<tr><th scope="row">${esc(node.name)} asset</th><td>Asset</td>${num(a[0])}${num(a[n])}</tr>` : '');
        }).join('');
        return `<h3>Accounts, assets and debts</h3><table class="report-table"><thead><tr><th scope="col">Module</th><th scope="col">Kind</th>
            <th scope="col" class="is-num">${esc(monthLabel(plan, 0))}</th><th scope="col" class="is-num">${esc(monthLabel(plan, n))}</th></tr></thead>
            <tbody>${rows}<tr class="is-total"><th scope="row">Net worth</th><td></td>${num(res.netWorth[0])}${num(res.netWorth[n])}</tr></tbody></table>`;
    }

    // ── The report ─────────────────────────────────────────────────────────

    function planSection(plan, res, goals, printed) {
        // The length it was run over (the app's), not the one saved in the plan.
        const years = res ? res.months / 12 : (window.PlanStore?.state.years ?? plan.settings.years);
        const head = `<header class="report-head">
            <div class="report-brand">Aventurine Planner</div>
            <h2>${esc(plan.name)}</h2>
            <div class="report-muted">${esc(monthLabel(plan, 0))} to ${esc(monthLabel(plan, years * 12))} · ${years} ${years === 1 ? 'year' : 'years'} · Report made ${esc(printed)}</div>
        </header>`;
        if (!res) {
            return `<section class="report-plan">${head}<p>This plan could not be simulated, so it has no figures.</p></section>`;
        }
        return `<section class="report-plan">${head}
            ${headlineFigures(plan, res)}
            <div class="report-figure"><h3>Net worth over time</h3>${worthChart(plan, res)}</div>
            <div class="report-figure"><h3>Cash flow</h3>${flowChart(plan, res)}</div>
            ${goalsTable(plan, goals)}
            ${yearTable(plan, res)}
            ${balancesTable(plan, res)}
            <p class="report-note">Projections are estimates from the figures in the plan, not advice. Amounts are in each month's money.</p>
        </section>`;
    }

    /**
     * Save a report of `entries` ([{ plan, results }], results null for a plan
     * the engine failed on) as a PDF, after asking where (`title` names the
     * file). The report is put in the page for the time it is printed;
     * report.css shows only it in print media. Resolves { saved }, { canceled }
     * or { error }.
     */
    async function save({ entries, goals, title }) {
        if (!window.electronFile?.savePlanPdf) return { error: 'Reports can be saved only in the app.' };
        const printed = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
        const el = document.createElement('div');
        el.className = 'report';
        el.innerHTML = entries.map(({ plan, results }) => planSection(plan, results, goals, printed)).join('');
        document.body.append(el);
        try {
            return await window.electronFile.savePlanPdf(title);
        } finally {
            el.remove();
        }
    }

    window.PlanReport = { save };
}());
