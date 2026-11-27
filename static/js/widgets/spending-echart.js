'use strict';

// ─── spending-echart.js ──────────────────────────────────────────────────────
// The Spending Trends chart (Reports → Spending), exposed as window.SpendingChart
// and drawn with Apache ECharts through widgets/echart-kit.js.
//
// TWO FORMS:
//   'stacked' — ECharts' Gradient Stacked Area: smooth stacked lines with no
//               stroke, filled at 0.8 opacity with a vertical gradient, a
//               cross axis pointer, and the other bands faded while one is
//               hovered.
//   'lines'   — one plain line per category, same axes and tooltip.
//
// COLOURS are the theme's category palette (--cat-*, ant.css), in every theme.
// Each band fades from its own colour at the top to the next colour in the
// palette at the bottom, the way the ECharts example pairs its gradients (each
// bottom colour is close to the next band's top). colorMap() hands the page the
// top colours, which the rail swatches and the Top Merchants bars also use, so
// the whole tab agrees on what each colour means.
//
// WHAT THE CALLER OWNS: the data, the colours, and which series is focused.
// A focus change, a series switched on or off, and a theme change are all a
// new render() call, merged into the chart already drawn (series matched by
// `id`), so ECharts animates the change instead of replaying the entrance.
// Only a change of form starts the chart over, because a merge would keep the
// stacked form's fill on the lines.
//
// API:
//   SpendingChart.render(containerId, { view, months, series, onSeriesClick })
//     months: ['YYYY-MM', …]  — the x axis
//     series: [{ id, label, color, values: number[], dim?, active? }]
//             `values` lines up with `months`; `dim` fades a series back.
//     onSeriesClick(id): called when a series is clicked (optional).
//   SpendingChart.clear(containerId)
//   SpendingChart.colorMap(keys) → Map<key, colour>
//
// Globals: EChartKit (echart-kit.js), ChartMath (chartmath.js), axisFormatter
// and formatCurrency (currency.js), MONTHS_SHORT (format.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // From the ECharts example. DIM matches the rail's focus fade.
  const AREA_OPACITY = 0.8;
  const DIM_OPACITY = 0.16;
  const LINE_WIDTH = 2;

  /** containerId → { view } of the chart last drawn there. */
  const drawn = new Map();

  // ─── Colours ────────────────────────────────────────────────────────────

  /** The category palette as gradient pairs, in band order: each colour fades
   *  into the one after it. */
  function gradientPairs() {
    const cats = EChartKit.theme().cat;
    return cats.map((top, i) => ({ top, bottom: cats[(i + 1) % cats.length] }));
  }

  /** Map<key, colour>: the palette's colours, assigned in order. */
  function colorMap(keys) {
    const cats = EChartKit.theme().cat;
    return new Map(keys.map((k, i) => [k, cats[i % cats.length]]));
  }

  // ─── Labels ──────────────────────────────────────────────────────────────

  function parseMonth(ym) {
    const [year, month] = String(ym).split('-').map(Number);
    return { year, monthIdx: month - 1 };
  }

  /** The short month, and the year in place of January when the window spans
   *  more than one year (the same rule as chart.js). */
  function monthLabeler(months) {
    const multiYear = new Set(months.map((ym) => parseMonth(ym).year)).size > 1;
    return (ym) => {
      const { year, monthIdx } = parseMonth(ym);
      return multiYear && monthIdx === 0 ? String(year) : MONTHS_SHORT[monthIdx];
    };
  }

  function monthTitle(ym) {
    const { year, monthIdx } = parseMonth(ym);
    return `${MONTHS[monthIdx]} ${year}`;
  }

  // ─── Option ──────────────────────────────────────────────────────────────

  function tooltipFormatter(series, stacked) {
    const byId = new Map(series.map((s) => [s.id, s]));
    return (params) => {
      const items = Array.isArray(params) ? params : [params];
      if (!items.length) return '';
      let total = 0;
      const rows = [];
      for (const p of items) {
        const s = byId.get(p.seriesId);
        const value = Number(p.value) || 0;
        // Only categories with spending that month, as the rail's totals do.
        if (!s || value <= 0) continue;
        total += value;
        rows.push({ color: s.color, name: s.label, value: formatCurrency(value, true) });
      }
      if (!rows.length) return '';
      if (stacked) rows.push({ name: 'Total', value: formatCurrency(total, true), total: true });
      return EChartKit.tipHtml({ title: monthTitle(items[0].axisValue), rows });
    };
  }

  function valueTicks(series, stacked) {
    let max = 0;
    const n = series[0].values.length;
    for (let i = 0; i < n; i++) {
      let column = 0;
      for (const s of series) {
        const v = s.values[i] || 0;
        column = stacked ? column + v : Math.max(column, v);
      }
      if (column > max) max = column;
    }
    return max > 0 ? ChartMath.niceTicks(0, max, 4) : [0, 1];
  }

  function seriesOption(s, stacked, bottomOf) {
    const base = {
      id: s.id,
      name: s.label,
      type: 'line',
      data: s.values,
      color: s.color,
      showSymbol: false,
      emphasis: { focus: 'series' },
      z: s.active ? 3 : 2,
    };
    if (!stacked) {
      return { ...base, lineStyle: { width: LINE_WIDTH, opacity: s.dim ? DIM_OPACITY : 1 } };
    }
    return {
      ...base,
      stack: 'total',
      smooth: true,
      // Lets a click on the band itself, not only on its edge, name the series.
      triggerLineEvent: true,
      lineStyle: { width: 0 },
      areaStyle: {
        opacity: s.dim ? DIM_OPACITY : AREA_OPACITY,
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: s.color },
            // A colour from outside the palette has no pair, and keeps one hue.
            { offset: 1, color: bottomOf.get(s.color) || s.color },
          ],
        },
      },
    };
  }

  function buildOption(t, { view, months, series }) {
    const stacked = view === 'stacked';
    const bottomOf = new Map(gradientPairs().map((g) => [g.top, g.bottom]));
    const ticks = valueTicks(series, stacked);
    return {
      grid: { left: 0, right: 12, top: 12, bottom: 0, containLabel: true },
      tooltip: EChartKit.tooltip(t, {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          lineStyle: { color: t.textTertiary },
          crossStyle: { color: t.textTertiary },
          label: {
            backgroundColor: t.textSecondary,
            color: t.bgElevated,
            fontFamily: t.font,
            formatter: (p) => (p.axisDimension === 'x'
              ? monthTitle(p.value)
              : formatCurrency(Number(p.value) || 0, true)),
          },
        },
        formatter: tooltipFormatter(series, stacked),
      }),
      xAxis: EChartKit.categoryAxis(t, months, {
        boundaryGap: false,
        axisLabel: EChartKit.axisLabel(t, { hideOverlap: true, formatter: monthLabeler(months) }),
      }),
      yAxis: EChartKit.valueAxis(t, ticks, axisFormatter(ticks)),
      series: series.map((s) => seriesOption(s, stacked, bottomOf)),
    };
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  function render(containerId, { view, months, series, onSeriesClick = null }) {
    if (!series.length || !months.length) { clear(containerId); return; }
    const prev = drawn.get(containerId);
    // The same form merges (series matched by id) so the change animates; a
    // new form starts over.
    const sameView = prev && prev.view === view;
    drawn.set(containerId, { view });
    const ids = series.map((s) => s.id);
    EChartKit.mount(containerId, (t) => buildOption(t, { view, months, series }), {
      setOptionOpts: sameView ? { replaceMerge: ['series'] } : { notMerge: true },
      on: {
        // A click on an area carries only its index, so it is mapped back to
        // the id of the series drawn there.
        click: (p) => {
          if (p.componentType !== 'series' || !onSeriesClick) return;
          const id = ids[p.seriesIndex];
          if (id != null) onSeriesClick(id);
        },
      },
    });
  }

  function clear(containerId) {
    drawn.delete(containerId);
    EChartKit.unmount(containerId);
  }

  window.SpendingChart = { render, clear, colorMap };
}());
