'use strict';

// ─── chart.js ────────────────────────────────────────────────────────────────
// The app's month-by-month charts, exposed as window.FinanceChart and drawn by
// Apache ECharts through widgets/echart-kit.js. Used by the Dashboard's line
// and Spending cards and by Reports → Saved & Invested.
//
// Three forms over the same months:
//   render()        LINES: one measure over time, smoothed, each with a soft
//                   gradient under it and a dot per month (the last one larger;
//                   `dots: false` leaves the dots off).
//   renderArea()    LARGE AREA: ECharts' "Large scale area chart", without its
//                   zoom slider. One measure as a filled area with no dots,
//                   thinned by LTTB sampling when the months outnumber the
//                   pixels. The Dashboard's Net Worth card.
//   renderStacked() STACKED COLUMNS: a part-to-whole breakdown per month. The
//                   months are separate amounts, and a month with nothing in it
//                   is a real gap, which columns draw.
//
// Series shape:  [{ label, color, points: [{ year, monthIdx, value }] }]
// Slots:         [{ year, monthIdx }], the x-axis months to plot across.
//
// The y axis ticks come from ChartMath (core/chartmath.js) and their labels from
// axisFormatter (currency.js), handed the whole tick set so neighbouring ticks
// never share a label. The container's CSS sets the chart's size (.ec-box in
// css/echart.css for a chart alone in a card; a Dashboard card's plot box).
//
// Globals: EChartKit (echart-kit.js), ChartMath (chartmath.js), axisFormatter
// and formatCurrency (currency.js), MONTHS_SHORT (format.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const LINE_W = 2.25;
  const DOT = 6;
  const END_DOT = 9;
  const BAR_MAX = 24;
  const BAR_RADIUS = 4;
  const GRID = { left: 0, right: 16, top: 16, bottom: 0, containLabel: true };

  const fmtTip = (n) => formatCurrency(n, true);
  const slotKey = (s) => `${s.year}-${s.monthIdx}`;
  const slotTitle = (s) => `${MONTHS[s.monthIdx]} ${s.year}`;

  /** The x labels: the short month, or the year in place of January when the
   *  span crosses one, the only date context a 12- or 24-month axis needs. */
  function slotLabels(slots) {
    const multiYear = new Set(slots.map((s) => s.year)).size > 1;
    return slots.map((s) => (multiYear && s.monthIdx === 0 ? String(s.year) : MONTHS_SHORT[s.monthIdx]));
  }

  /** Each series' values lined up with `slots`; null where it has no point. */
  function alignValues(series, slots) {
    const index = new Map(slots.map((s, i) => [slotKey(s), i]));
    return series.map((s) => {
      const row = new Array(slots.length).fill(null);
      for (const p of s.points) {
        const i = index.get(slotKey(p));
        if (i !== undefined) row[i] = (row[i] || 0) + (Number(p.value) || 0);
      }
      return row;
    });
  }

  /** The y ticks for lines.
   *
   *  By default they fit the data. `zeroBase` floors the axis at zero: right
   *  once a line carries an area fill, because a filled shape reads its height
   *  from the baseline, and for a line read beside a zero-based stack.
   *
   *  `centred` gives the data a minimum span (a quarter of its magnitude) and
   *  centres it with headroom, so a balance that barely moves sits mid-card
   *  rather than filling it edge to edge (the Dashboard). A FLAT series always
   *  takes this path: fitted ticks for a zero-height range collapse to one. */
  function lineTicks(values, { zeroBase = false, centred = false } = {}) {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    if (centred || hi === lo) {
      const mid = (lo + hi) / 2;
      const span = Math.max(hi - lo, Math.abs(mid) * 0.25, 1);
      const pad = span * 0.1;
      const bottom = mid - span / 2 - pad;
      return ChartMath.niceTicks(zeroBase ? Math.min(0, bottom) : bottom, mid + span / 2 + pad, 4);
    }
    return ChartMath.niceTicks(zeroBase ? Math.min(0, lo) : lo, hi, 4);
  }

  /** The shared tooltip: the month, then every series with a value in it, and
   *  for a stack the month's total. */
  function tipFormatter(series, slots, { total = false } = {}) {
    return (params) => {
      const items = Array.isArray(params) ? params : [params];
      if (!items.length) return '';
      const slot = slots[items[0].dataIndex];
      let sum = 0;
      const rows = [];
      for (const p of items) {
        const s = series[p.seriesIndex];
        const v = p.value;
        if (!s || v == null || (total && !(v > 0))) continue;
        sum += Number(v) || 0;
        rows.push({ color: s.color, name: s.label, value: fmtTip(Number(v)) });
      }
      if (!rows.length) return '';
      if (total && rows.length > 1) rows.push({ name: 'Total', value: fmtTip(sum), total: true });
      return EChartKit.tipHtml({ title: slot ? slotTitle(slot) : '', rows });
    };
  }

  function lineOption(t, { series, slots, zeroBase, centred, dots }) {
    const rows = alignValues(series, slots);
    const values = rows.flat().filter((v) => v != null);
    if (!values.length) return null;
    const ticks = lineTicks(values, { zeroBase, centred });
    const fmt = axisFormatter(ticks);
    return {
      grid: GRID,
      tooltip: EChartKit.tooltip(t, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.textTertiary, type: 'dashed' } },
        formatter: tipFormatter(series, slots),
      }),
      xAxis: EChartKit.categoryAxis(t, slotLabels(slots), { boundaryGap: false }),
      yAxis: EChartKit.valueAxis(t, ticks, fmt),
      series: series.map((s, si) => {
        const row = rows[si];
        const last = row.reduce((at, v, i) => (v == null ? at : i), -1);
        // Without dots a lone month has no line to draw, so it keeps its dot.
        const showSymbol = dots || row.filter((v) => v != null).length === 1;
        return {
          type: 'line',
          name: s.label,
          smooth: true,
          connectNulls: true,
          color: s.color,
          lineStyle: { width: LINE_W },
          symbol: 'circle',
          symbolSize: DOT,
          showSymbol,
          data: row.map((v, i) => (i === last && v != null ? { value: v, symbolSize: END_DOT } : v)),
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: EChartKit.alpha(s.color, 0.3) },
                { offset: 1, color: EChartKit.alpha(s.color, 0) },
              ],
            },
          },
          emphasis: { focus: 'series' },
        };
      }),
    };
  }

  function areaOption(t, { series, slots, centred }) {
    const s = series[0];
    const row = alignValues([s], slots)[0];
    const values = row.filter((v) => v != null);
    if (!values.length) return null;
    const ticks = lineTicks(values, { centred });
    return {
      grid: GRID,
      tooltip: EChartKit.tooltip(t, {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.textTertiary, type: 'dashed' } },
        formatter: tipFormatter([s], slots),
      }),
      xAxis: EChartKit.categoryAxis(t, slotLabels(slots), { boundaryGap: false }),
      yAxis: EChartKit.valueAxis(t, ticks, axisFormatter(ticks)),
      series: [{
        type: 'line',
        name: s.label,
        color: s.color,
        connectNulls: true,
        sampling: 'lttb',
        // No dots, as the example draws it: the area is the reading. A lone
        // month has no line to draw, so it alone keeps its dot.
        symbol: 'circle',
        symbolSize: END_DOT,
        showSymbol: values.length === 1,
        lineStyle: { width: LINE_W },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: EChartKit.alpha(s.color, 0.5) },
              { offset: 1, color: EChartKit.alpha(s.color, 0.04) },
            ],
          },
        },
        data: row,
      }],
    };
  }

  function stackedOption(t, { series, slots }) {
    const rows = alignValues(series, slots).map((row) => row.map((v) => (v > 0 ? v : null)));
    const totals = slots.map((_, i) => rows.reduce((sum, row) => sum + (row[i] || 0), 0));
    const maxTotal = Math.max(...totals);
    if (!(maxTotal > 0)) return null;
    // Only the top of each column is rounded: the baseline end is a shared
    // zero, not a data end. So each month finds its topmost series.
    const topOf = slots.map((_, i) => rows.reduce((at, row, si) => (row[i] != null ? si : at), -1));
    const ticks = ChartMath.niceTicks(0, maxTotal, 4);
    return {
      grid: GRID,
      tooltip: EChartKit.tooltip(t, {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: EChartKit.alpha(t.text, 0.04) } },
        formatter: tipFormatter(series, slots, { total: true }),
      }),
      xAxis: EChartKit.categoryAxis(t, slotLabels(slots)),
      yAxis: EChartKit.valueAxis(t, ticks, axisFormatter(ticks)),
      series: series.map((s, si) => ({
        type: 'bar',
        name: s.label,
        stack: 'total',
        color: s.color,
        barMaxWidth: BAR_MAX,
        barCategoryGap: '38%',
        data: rows[si].map((v, i) => (v != null && topOf[i] === si
          ? { value: v, itemStyle: { borderRadius: [BAR_RADIUS, BAR_RADIUS, 0, 0] } }
          : v)),
        emphasis: { focus: 'series' },
      })),
    };
  }

  /** Draw into `target` (an element or its id), or clear it when there is
   *  nothing to draw. A cleared container is left empty for the caller's own
   *  empty state. */
  function draw(target, hasData, build, animate) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    if (!hasData) {
      EChartKit.unmount(el);
      el.innerHTML = '';
      return;
    }
    EChartKit.mount(el, build, { animate: animate !== false });
  }

  /** Lines. `zeroBase` floors the y axis at zero, `centred` gives a flat
   *  series headroom (see lineTicks), `dots` false draws the lines bare,
   *  `animate` false skips the entrance. */
  function render(target, { series, slots, zeroBase = false, centred = false, dots = true, animate = true }) {
    draw(target, series.length > 0 && slots.length > 0,
      (t) => lineOption(t, { series, slots, zeroBase, centred, dots }), animate);
  }

  /** The large area: the first series alone. `centred` as for render(). */
  function renderArea(target, { series, slots, centred = false, animate = true }) {
    draw(target, series.length > 0 && slots.length > 0,
      (t) => areaOption(t, { series, slots, centred }), animate);
  }

  /** Stacked columns, the first series at the bottom. */
  function renderStacked(target, { series, slots, animate = true }) {
    draw(target, series.length > 0 && slots.length > 0,
      (t) => stackedOption(t, { series, slots }), animate);
  }

  /** Map<key, colour>, assigned in order from the theme's chart palette.
   *  'categorical' reads --cat-* (series that are CATEGORIES); the default
   *  'accent' reads --chart-* (one measure over time). Read fresh, so call it
   *  again after a theme change. */
  function colorMap(keys, palette = 'accent') {
    const t = EChartKit.theme();
    const colors = palette === 'categorical' ? t.cat : t.chart;
    return new Map(keys.map((k, i) => [k, colors[i % colors.length]]));
  }

  window.FinanceChart = { render, renderArea, renderStacked, colorMap };
}());
