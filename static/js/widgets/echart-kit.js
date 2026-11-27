'use strict';

// ─── echart-kit.js ───────────────────────────────────────────────────────────
// The one layer between the app and Apache ECharts (vendor/echarts). Every
// chart in the app is drawn by ECharts and mounted through here, so the things
// every chart needs are written once:
//
//   THEME    Colours come from the active theme's tokens (theme.css, themes.css,
//            ant.css), never from ECharts' own palette. theme(el) reads them as
//            resolved colours: a token can be a var() chain, rgba() or
//            color-mix(), and ECharts can only parse hex and rgb(a), so every
//            value is normalised to one of those first.
//   SIZE     A chart fills its container, whose size is set by CSS. The chart is
//            created on the container's first non-zero size (a hidden tab or
//            panel has none) and follows it with a ResizeObserver.
//   REPAINT  On 'themechange' (shell/settings.js) every live chart rebuilds its
//            option, so a theme swap recolours it with no work from the page.
//            A chart hidden at the time (an inactive tab) is marked stale and
//            repainted when it is shown, not merely resized.
//   CLEANUP  A container that leaves the document takes its chart with it: the
//            observer sees it go and disposes the instance, so pages that redraw
//            by replacing innerHTML (the Dashboard's cards) never leak one.
//   LOOK     The shared frame (dashed grid, tertiary axis labels, the tooltip
//            card) so every chart reads as one family. The tooltip's content
//            classes are styled in css/echart.css.
//
// API (window.EChartKit):
//   mount(el, build, opts) → handle
//       build(theme) returns the ECharts option; it is called again on every
//       theme change, so it must read colours from `theme`, not cache them.
//       opts: { on: { eventName: fn(params, chart) }, afterRender(chart),
//               animate = true, setOptionOpts, renderer = 'canvas', label }
//       Mounting the same element again replaces its build and redraws it.
//       handle: { chart() → the instance or null, dispose() }
//   unmount(el)               Dispose the element's chart, if it has one.
//   theme(el?)                Resolved theme colours (see readTheme).
//   color(token, el?)         One token as a resolved colour ('' when unset).
//   palette(prefix, n, el?)   [--prefix-1 … --prefix-n], resolved.
//   alpha(color, a)           The colour at opacity `a`, as rgba().
//   tooltip(theme, extra)     The shared tooltip component.
//   tipHtml({ title, rows })  Tooltip content: rows [{ color, name, value, total }].
//   valueAxis(theme, ticks, fmt, extra)  A value axis on precomputed ticks.
//   categoryAxis(theme, data, extra)     A category axis in the shared style.
//   splitLine(theme)          The dashed grid line style.
//
// Globals: echarts (vendor/echarts), escapeHtml (escape.js).

(function () {
  // ─── Colour resolution ────────────────────────────────────────────────────

  let canvasCtx = null;
  function ctx2d() {
    if (!canvasCtx) canvasCtx = document.createElement('canvas').getContext('2d');
    return canvasCtx;
  }

  /** A colour in a form ECharts can parse (#hex or rgb/rgba). The canvas
   *  serialises anything it accepts to one of those; a color(srgb …) value
   *  (what color-mix() computes to) is converted by hand, since the canvas
   *  can hand that form back unchanged. */
  function normalise(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^(#|rgba?\()/i.test(text)) return text;
    const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(text);
    if (srgb) return fromSrgb(srgb[1]);
    const c = ctx2d();
    if (!c) return text;
    c.fillStyle = '#000';
    c.fillStyle = text;
    const out = String(c.fillStyle);
    const again = /^color\(srgb\s+([^)]+)\)$/i.exec(out);
    return again ? fromSrgb(again[1]) : out;
  }

  /** 'r g b / a' with channels in 0–1 → rgba(). */
  function fromSrgb(body) {
    const [rgb, a] = body.split('/');
    const [r, g, b] = rgb.trim().split(/\s+/).map((n) => Math.round(Number(n) * 255));
    const alphaValue = a == null ? 1 : Number(a);
    if (![r, g, b, alphaValue].every(Number.isFinite)) return '';
    return `rgba(${r}, ${g}, ${b}, ${alphaValue})`;
  }

  /** One custom property, read off `el` (scoped tokens resolve there) or the
   *  root, as a colour ECharts can use. A custom property's computed value has
   *  its var() references already substituted. */
  function color(token, el = document.documentElement) {
    const name = token.startsWith('--') ? token : `--${token}`;
    return normalise(getComputedStyle(el).getPropertyValue(name));
  }

  function palette(prefix, count, el = document.documentElement) {
    const cs = getComputedStyle(el);
    const out = [];
    for (let i = 1; i <= count; i++) {
      const c = normalise(cs.getPropertyValue(`--${prefix}-${i}`));
      if (c) out.push(c);
    }
    return out;
  }

  /** `c` at opacity `a`. Accepts #hex and rgb(a), which is all normalise()
   *  returns. */
  function alpha(c, a) {
    const text = String(c || '');
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
    let rgb = null;
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
      rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    } else {
      const m = /^rgba?\(([^)]+)\)$/i.exec(text);
      if (m) rgb = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    }
    if (!rgb || !rgb.every(Number.isFinite)) return text;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
  }

  // ─── The theme ────────────────────────────────────────────────────────────
  // The root theme is read once per theme: it costs a few dozen style reads,
  // and a Dashboard of a dozen cards asks for it a dozen times per paint. Only
  // a theme swap moves these tokens, and every swap dispatches 'themechange'.
  // A chart inside a scope with tokens of its own (Insights' --ins-*) reads
  // those with color(token, el) itself.

  let rootTheme = null;

  function readTheme() {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const get = (name) => normalise(cs.getPropertyValue(name));
    const raw = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      text: get('--ant-color-text'),
      textSecondary: get('--ant-color-text-secondary'),
      textTertiary: get('--ant-color-text-tertiary'),
      textQuaternary: get('--ant-color-text-quaternary'),
      border: get('--ant-color-border'),
      borderSecondary: get('--ant-color-border-secondary'),
      bgContainer: get('--ant-color-bg-container'),
      bgElevated: get('--ant-color-bg-elevated'),
      fillTertiary: get('--ant-color-fill-tertiary'),
      primary: get('--ant-color-primary'),
      success: get('--ant-color-success'),
      warning: get('--ant-color-warning'),
      error: get('--ant-color-error'),
      info: get('--ant-color-info'),
      font: raw('--ant-font-family', 'sans-serif'),
      fontSize: parseFloat(raw('--ant-font-size-sm', '12')) || 12,
      // The chart palettes (ant.css maps the theme's --ant-chart-* onto them).
      chart: palette('chart', 8, root),
      cat: palette('cat', 8, root),
      inflow: palette('chart-inflow', 6, root),
      outflow: ChartRamp.outflow().map(normalise),
      net: get('--chart-net'),
      tag: get('--chart-tag'),
      transfer: get('--chart-transfer'),
      income: get('--ant-chart-income'),
      expense: get('--ant-chart-expense'),
      neutral: get('--ant-chart-neutral'),
    };
  }

  function theme() {
    if (!rootTheme) rootTheme = readTheme();
    return rootTheme;
  }

  const reducedMotion = () =>
    Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ─── Shared pieces ────────────────────────────────────────────────────────

  /** The grid: a 0.5px [3, 4] dash in the text colour at 0.1, as G2 draws it. */
  function splitLine(t) {
    return { lineStyle: { color: alpha(t.text, 0.1), width: 0.5, type: [3, 4] } };
  }

  function axisLabel(t, extra) {
    return { color: t.textTertiary, fontFamily: t.font, fontSize: t.fontSize, ...extra };
  }

  /** A value axis on ticks the caller computed (ChartMath.niceTicks), so every
   *  chart in the app agrees on where its gridlines fall and what "$1.5K"
   *  means. `fmt` labels each tick. */
  function valueAxis(t, ticks, fmt, extra = {}) {
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : undefined;
    return {
      type: 'value',
      min: ticks[0],
      max: ticks[ticks.length - 1],
      interval: step,
      axisLabel: axisLabel(t, { formatter: (v) => fmt(v) }),
      splitLine: splitLine(t),
      ...extra,
    };
  }

  function categoryAxis(t, data, extra = {}) {
    return {
      type: 'category',
      data,
      axisLine: { lineStyle: { color: t.borderSecondary } },
      axisTick: { show: false },
      axisLabel: axisLabel(t, { hideOverlap: true }),
      ...extra,
    };
  }

  /** The tooltip card: on the elevated surface, appended to <body> so no card
   *  or panel can clip it. Content comes from a formatter, built with tipHtml. */
  function tooltip(t, extra = {}) {
    return {
      appendTo: 'body',
      className: 'ec-tip',
      backgroundColor: t.bgElevated,
      borderWidth: 0,
      padding: 12,
      textStyle: { color: t.textSecondary, fontFamily: t.font, fontSize: 12 },
      extraCssText: 'border-radius:4px;box-shadow:0 6px 12px 0 rgba(0,0,0,0.12);min-width:120px;',
      ...extra,
    };
  }

  /** Tooltip markup: a title, then a row per item (a swatch, its name, its
   *  value). Names come from the user's data, so everything is escaped. */
  function tipHtml({ title = '', rows = [], note = '' }) {
    const row = (r) => {
      const dot = r.color
        ? `<span class="ec-tip-marker" style="background:${escapeHtml(r.color)}"></span>`
        : '<span class="ec-tip-marker ec-tip-marker-none"></span>';
      return `<li class="ec-tip-row${r.total ? ' is-total' : ''}"><span class="ec-tip-name">${dot}`
        + `<span class="ec-tip-label">${escapeHtml(r.name)}</span></span>`
        + `<span class="ec-tip-value">${escapeHtml(r.value)}</span></li>`;
    };
    return (title ? `<div class="ec-tip-title">${escapeHtml(title)}</div>` : '')
      + (rows.length ? `<ul class="ec-tip-list">${rows.map(row).join('')}</ul>` : '')
      + (note ? `<div class="ec-tip-note">${escapeHtml(note)}</div>` : '');
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** element → { el, chart, observer, build, opts, handlers } */
  const records = new WeakMap();
  /** The records with a live observer, for the theme repaint. */
  const live = new Set();

  const hasSize = (el) => el.clientWidth > 0 && el.clientHeight > 0;

  function bindEvents(rec) {
    for (const name of Object.keys(rec.opts.on || {})) {
      if (rec.handlers.has(name)) continue;
      // The handler is looked up on every event, so a remount with new
      // callbacks takes effect without rebinding.
      rec.chart.on(name, (params) => {
        const fn = rec.opts.on && rec.opts.on[name];
        if (fn) fn(params, rec.chart);
      });
      rec.handlers.add(name);
    }
  }

  function paint(rec, { fresh = false } = {}) {
    const { el, opts } = rec;
    // The observer paints it once it has a size. A chart already drawn is
    // marked stale, so showing it again repaints it rather than only resizing
    // it (a hidden tab's chart would otherwise keep the old theme's colours).
    if (!hasSize(el)) {
      if (rec.chart) rec.stale = true;
      return;
    }
    rec.stale = false;
    if (!rec.chart) {
      // The container may hold an empty state or a previous engine's markup.
      el.replaceChildren();
      rec.chart = echarts.init(el, null, { renderer: opts.renderer || 'canvas' });
      rec.handlers = new Set();
      fresh = true;
    }
    bindEvents(rec);
    let option;
    try {
      option = rec.build(theme());
    } catch (err) {
      console.error('[EChartKit] could not build a chart option', err);
      return;
    }
    if (!option) return;
    const animate = opts.animate !== false && !reducedMotion();
    const t = theme();
    const full = {
      animation: animate,
      textStyle: { fontFamily: t.font, fontSize: t.fontSize },
      aria: { enabled: true, ...(opts.label ? { label: { description: opts.label } } : {}) },
      ...option,
    };
    const setOpts = fresh ? { notMerge: true } : (opts.setOptionOpts || { notMerge: true });
    rec.chart.setOption(full, setOpts);
    if (opts.afterRender) opts.afterRender(rec.chart);
  }

  function dispose(rec) {
    rec.observer.disconnect();
    if (rec.chart) rec.chart.dispose();
    rec.chart = null;
    live.delete(rec);
    records.delete(rec.el);
  }

  function createRecord(el) {
    const rec = { el, chart: null, observer: null, build: null, opts: {}, handlers: new Set(), stale: false };
    rec.observer = new ResizeObserver(() => {
      // A container taken out of the document is done with: free the chart.
      if (!el.isConnected) { dispose(rec); return; }
      if (!hasSize(el)) return;
      if (rec.chart && rec.stale) {
        // Hidden through a theme change or a redraw: paint it whole now.
        rec.chart.resize();
        paint(rec, { fresh: true });
      } else if (rec.chart) {
        rec.chart.resize();
        if (rec.opts.afterRender) rec.opts.afterRender(rec.chart);
      } else {
        paint(rec);
      }
    });
    rec.observer.observe(el);
    records.set(el, rec);
    live.add(rec);
    return rec;
  }

  function resolve(target) {
    return typeof target === 'string' ? document.getElementById(target) : target;
  }

  function mount(target, build, opts = {}) {
    const el = resolve(target);
    if (!el) return null;
    const rec = records.get(el) || createRecord(el);
    rec.build = build;
    rec.opts = opts;
    paint(rec);
    return {
      chart: () => rec.chart,
      dispose: () => { if (records.get(el) === rec) dispose(rec); },
    };
  }

  function unmount(target) {
    const el = resolve(target);
    const rec = el && records.get(el);
    if (rec) dispose(rec);
  }

  window.addEventListener('themechange', () => {
    rootTheme = null;
    for (const rec of [...live]) {
      if (!rec.el.isConnected) { dispose(rec); continue; }
      if (rec.chart) paint(rec, { fresh: true });
    }
  });

  window.EChartKit = {
    mount, unmount, theme, color, palette, alpha, reducedMotion,
    tooltip, tipHtml, valueAxis, categoryAxis, splitLine, axisLabel,
  };
}());
