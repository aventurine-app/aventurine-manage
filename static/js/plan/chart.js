'use strict';

// ─── chart.js ───────────────────────────────────────────────────────────────
// The charts of Analyze and Compare, drawn by Apache ECharts through the app's
// chart kit (widgets/echart-kit.js):
//
//   area   stacked bands over time (accounts above zero, debts below) with
//          lines on top (net worth; or Compare's plans, with no bands)
//   bars   stacked bars per period, ups above zero and downs below, with a
//          line on top (cash flow)
//
// Both share the same frame (recessive dashed grid, compact currency ticks,
// year ticks along the bottom) and the same hover: an axis pointer, a tooltip
// listing every series at that point, and onHover(index) so the rest of the
// app can follow the cursor through time.
//
// Colours arrive as CSS custom-property names (the Plan section's chart
// tokens, plan/base.css) and are resolved by the kit, which rebuilds the chart
// when the theme changes.

(function () {
    // The plot's margins. Fixed rather than fitted to the labels, so a marker's
    // x position is known before the chart is drawn (see goalMarks).
    const M = { top: 10, right: 16, bottom: 26, left: 60 };
    // Height of the marker label strip above the plot.
    const MARKER_STRIP = 22;
    const BADGE_PAD = 16;

    /** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [lo, hi] in ~5 steps. */
    function niceTicks(lo, hi, count = 5) {
        if (hi - lo < 1e-9) hi = lo + 1;
        const raw = (hi - lo) / count;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
        const start = Math.floor(lo / step) * step;
        const end = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        return ticks;
    }

    /** The width of a marker label (12px semibold) in the chart's font. */
    let measurer = null;
    function labelWidth(box, text) {
        if (!measurer) measurer = document.createElement('canvas').getContext('2d');
        if (!measurer) return text.length * 7;
        const weight = getComputedStyle(document.documentElement).getPropertyValue('--font-weight-strong').trim() || '600';
        measurer.font = `${weight} 12px ${getComputedStyle(box).fontFamily}`;
        return measurer.measureText(text).width;
    }

    /** The element the chart is drawn into: a box of its own filling `box`,
     *  shared by PlanChart and PlanSankey so a view switch reuses one chart. */
    function canvasOf(box) {
        let canvas = box.querySelector(':scope > .chart-canvas');
        if (!canvas) {
            canvas = document.createElement('div');
            canvas.className = 'chart-canvas';
            box.prepend(canvas);
        }
        return canvas;
    }

    /** A token name ('--chart-in') as a colour, read off the box. */
    const colorOf = (box, name, fallback = '') => (name ? EChartKit.color(name, box) : '') || fallback;

    /** The tooltip card's content: who is how old, the title, then a row per
     *  series. Every string is escaped (plan and module names are the user's). */
    function tipContent(box, t) {
        const people = (t.people || []).map((p) => `<div class="chart-tip-person"><span>${escapeHtml(p.name)}</span>${p.age ? `<b>${escapeHtml(p.age)}</b>` : ''}</div>`).join('');
        return (people ? `<div class="chart-tip-people">${people}</div>` : '')
            + EChartKit.tipHtml({
                title: t.title,
                rows: t.rows.map((r) => ({ color: colorOf(box, r.color || '--chart-grid'), name: r.label, value: r.value, total: r.total })),
            });
    }

    /** Which markers keep their label: a label goes right of its rule, else
     *  left, and is left off where it would cover another or run off the plot
     *  (the tooltip still names every marker). */
    function goalMarks(box, markers, X, W) {
        let end = -Infinity;
        return [...markers].sort((a, b) => a.i - b.i).map((mk) => {
            const x = X(mk.i);
            const w = labelWidth(box, mk.label) + BADGE_PAD;
            let side = null;
            if (x >= end + 4 && x + w <= W) side = 'right';
            else if (x - w >= Math.max(0, end + 4)) side = 'left';
            if (side) end = side === 'right' ? x + w : x;
            return { mk, side };
        });
    }

    /**
     * Draw into `box` (a positioned element).
     *   opts.kind       'area' | 'bars'
     *   opts.count      number of x positions
     *   opts.xTicks     [{ i, label }]
     *   opts.bands      area: [{ label, color, values, sign }]   sign -1 stacks below zero
     *   opts.bars       bars: [{ label, color, values, sign }]   sign -1 stacks below zero
     *                   (a negative value flips its side too: an overdrawn
     *                   account stacks below zero with the debts)
     *   opts.line       { label, color, values }
     *   opts.lines      [{ label, color, values }], drawn in order, for more than
     *                   one line (opts.line is the one-line form)
     *   opts.between    shade the gap between the first two lines (Compare)
     *   opts.markers    optional [{ i, label, color, fill }]: a dated event at
     *                   index i (a goal met), drawn as a dashed rule topped with
     *                   a badge in a strip above the plot. `color` and `fill`
     *                   are custom property names for the rule and the badge.
     *   opts.format     value → axis label
     *   opts.tooltip    index → { people, title, rows: [{ label, color, value, total }] }
     *   opts.onHover    index | null
     *   opts.label      the chart's accessible name
     */
    function draw(box, opts) {
        const canvas = canvasOf(box);
        if (opts.count < 2) { EChartKit.unmount(canvas); return; }
        const n = opts.count;
        const bars = opts.kind === 'bars';
        const markers = opts.markers || [];
        const lines = opts.lines || (opts.line ? [opts.line] : []);
        const layers = (bars ? opts.bars : opts.bands) || [];

        // Where a layer's value at i sits: above zero (positive) or below.
        // Less than half a cent is nothing, so float dust picks no side.
        const signed = (s, i) => {
            const v = (s.sign < 0 ? -1 : 1) * (s.values[i] || 0);
            return Math.abs(v) < 0.005 ? 0 : v;
        };
        const rows = layers.map((s) => Array.from({ length: n }, (_, i) => signed(s, i)));

        // ── Domain ─────────────────────────────────────────────────────────
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < n; i++) {
            let up = 0;
            let down = 0;
            for (const row of rows) { if (row[i] < 0) down += row[i]; else up += row[i]; }
            hi = Math.max(hi, up);
            lo = Math.min(lo, down);
        }
        for (const ln of lines) for (let i = 0; i < n; i++) { hi = Math.max(hi, ln.values[i]); lo = Math.min(lo, ln.values[i]); }
        // A flat-zero plan still gets a readable axis rather than $0..$1.
        if (hi - lo < 1) hi = lo + 1000;
        const ticks = niceTicks(lo, hi);
        const tickAt = new Map((opts.xTicks || []).map((t) => [t.i, t.label]));

        EChartKit.mount(canvas, (t) => {
            const W = canvas.clientWidth;
            const top = M.top + (markers.length ? MARKER_STRIP : 0);
            const pw = W - M.left - M.right;
            const X = bars ? (i) => M.left + (pw / n) * (i + 0.5) : (i) => M.left + (i / (n - 1)) * pw;
            const series = [];

            // The gap between two lines, shaded under them (Compare's plans):
            // the lower of the two at each point, then the difference stacked
            // on it as a filled band.
            if (opts.between && lines.length >= 2) {
                const [a, b] = lines;
                const base = Array.from({ length: n }, (_, i) => Math.min(a.values[i], b.values[i]));
                const gap = Array.from({ length: n }, (_, i) => Math.abs(a.values[i] - b.values[i]));
                const band = { type: 'line', stack: 'between', symbol: 'none', silent: true, lineStyle: { opacity: 0 }, z: 1 };
                series.push(
                    { ...band, data: base },
                    { ...band, data: gap, areaStyle: { color: colorOf(box, '--color-fill-secondary', t.fillTertiary), opacity: 1 } },
                );
            }

            layers.forEach((s, li) => {
                const color = colorOf(box, s.color, t.textTertiary);
                const row = rows[li];
                if (!bars) {
                    series.push({
                        type: 'line', name: s.label, stack: 'bands', symbol: 'none', color,
                        lineStyle: { width: 0 },
                        areaStyle: { color, opacity: 0.85 },
                        data: row,
                    });
                    return;
                }
                // Only the outermost segment of each stack gets the rounded data
                // end; the others are square.
                series.push({
                    type: 'bar', name: s.label, stack: 'bars', color,
                    barMaxWidth: 36,
                    barCategoryGap: '38%',
                    data: row.map((v, i) => {
                        if (v === 0) return null;
                        const outer = !rows.slice(li + 1).some((r) => r[i] !== 0 && (r[i] < 0) === (v < 0));
                        if (!outer) return v;
                        return { value: v, itemStyle: { borderRadius: v < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } };
                    }),
                });
            });

            lines.forEach((ln, k) => {
                const color = colorOf(box, ln.color, t.text);
                const s = {
                    type: 'line', name: ln.label, color, symbol: 'circle', showSymbol: false, symbolSize: 9,
                    lineStyle: { width: 2 },
                    itemStyle: { borderColor: t.bgContainer, borderWidth: 2 },
                    emphasis: { disabled: true },
                    z: 4,
                    data: Array.from(ln.values),
                };
                // Goal markers hang from the first line.
                if (k === 0 && markers.length) {
                    s.markLine = {
                        silent: true,
                        symbol: 'none',
                        data: goalMarks(box, markers, X, W).map(({ mk, side }) => {
                            const fill = colorOf(box, mk.fill || mk.color, t.primary);
                            return {
                                xAxis: mk.i,
                                lineStyle: { color: colorOf(box, mk.color, t.primary), type: [3, 3], width: 1, opacity: 0.8 },
                                label: {
                                    show: Boolean(side),
                                    position: 'end',
                                    align: side === 'left' ? 'right' : 'left',
                                    offset: [side === 'left' ? 8 : -8, 0],
                                    formatter: mk.label,
                                    color: colorOf(box, '--goal-ink', '#fff'),
                                    backgroundColor: fill,
                                    padding: [3, 8],
                                    borderRadius: 4,
                                    fontFamily: t.font,
                                    fontSize: 12,
                                    fontWeight: 600,
                                },
                            };
                        }),
                    };
                }
                series.push(s);
            });

            return {
                grid: { left: M.left, right: M.right, top, bottom: M.bottom, containLabel: false },
                tooltip: EChartKit.tooltip(t, {
                    trigger: 'axis',
                    className: 'ec-tip plan-chart-tip',
                    axisPointer: {
                        type: bars ? 'shadow' : 'line',
                        lineStyle: { color: t.textQuaternary, type: [3, 3] },
                        shadowStyle: { color: EChartKit.alpha(t.text, 0.04) },
                    },
                    formatter: (params) => {
                        const i = Array.isArray(params) && params.length ? params[0].dataIndex : null;
                        return i == null ? '' : tipContent(box, opts.tooltip(i));
                    },
                }),
                xAxis: {
                    type: 'category',
                    boundaryGap: bars,
                    data: Array.from({ length: n }, (_, i) => i),
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: EChartKit.axisLabel(t, {
                        interval: (i) => tickAt.has(i),
                        formatter: (_v, i) => tickAt.get(i) || '',
                    }),
                },
                yAxis: {
                    ...EChartKit.valueAxis(t, ticks, opts.format),
                    axisLabel: EChartKit.axisLabel(t, { formatter: (v) => opts.format(v), margin: 10 }),
                },
                series,
            };
        }, {
            label: opts.label || 'Chart',
            animate: false,
            on: {
                updateAxisPointer: (e) => {
                    const info = e.axesInfo && e.axesInfo.find((a) => a.axisDim === 'x');
                    if (info && opts.onHover) opts.onHover(Number(info.value));
                },
                globalout: () => { if (opts.onHover) opts.onHover(null); },
            },
        });
    }

    /** Ticks for a monthly series of `count` points from `plan`'s start:
     *  each point that starts a calendar year (the first only if it is a
     *  January), thinned to at most ~8 labels. */
    function yearTicks(plan, count) {
        const P = window.PlanModel;
        const ticks = [];
        let prev = null;
        for (let i = 0; i < count; i++) {
            const { y, m } = P.ymParse(P.ymAdd(plan.settings.start, i));
            if (i === 0 ? m === 1 : y !== prev) ticks.push({ i, label: String(y) });
            prev = y;
        }
        const step = Math.ceil(ticks.length / 8);
        return ticks.filter((_, i) => i % step === 0);
    }

    window.PlanChart = { draw, yearTicks, canvasOf, colorOf };
}());
