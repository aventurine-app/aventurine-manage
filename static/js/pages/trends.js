'use strict';

// ─── Spending Trends (Reports) ────────────────────────────────────────────────
// Plots each expense category's monthly spending over a trailing window, in one
// of two forms, beside a rail that states every category's window total.
//
// Data comes from GET /api/trends (monthly per-category expense sums). Both
// forms are drawn with Apache ECharts by SpendingChart (spending-echart.js),
// off the same payload; the stacked form is ECharts' Gradient Stacked Area.
//
// TWO FORMS, ONE PAYLOAD. Stacked (the default) answers "what makes up my
// spending" and gives the card the mass the Cash Flow sankey has; lines answer
// "did this one category move", which a stack can only show for its bottom
// band. Neither is a better chart, so the header carries a switch and the
// choice is remembered in localStorage. Bands stack in the order the payload
// ranks them (biggest first), so the palette's order grades MAGNITUDE rather than
// identity — the rule the sankey applies to its own expense side.
//
// THE RAIL IS THE LEGEND AND THE TABLE. The row of chips it replaced carried a
// colour and a name and no value, so every figure on this card was reachable
// only by hovering the chart. Each row states its category's window total, and
// the rail heads with the total of the rows that are switched on.
//
// A ROW HAS TWO TARGETS. The swatch shows or hides the band (what the chip did),
// which also drops that category's transactions from the Top Merchants ranking
// below — the rail is the tab's legend, so a category switched off is off both
// cards. The NAME focuses the category — the chart steps every other band back,
// and the Top Merchants card below narrows to that category. Focus travels as
// the `aventurine:category-focus` event so neither page script has to know the
// other exists. The swatch COLOURS travel the same way, over
// `aventurine:category-colors`: this card assigns them, and the bars below are
// painted from them; the switched-off keys travel over
// `aventurine:category-hidden`.
//
// A BAND IS ITS OWN NAME. Clicking a band in the stacked view runs the same
// focus toggle its rail NAME does, so the thing on screen is the control for
// itself and the reader does not have to find its row first. Focus, not
// visibility: a click on a band asks about the band, and answering by removing
// it from the chart takes away the thing that was pointed at. The rail stays
// the keyboard path, and the swatch stays the only way to hide a category.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency (currency.js),
// SpendingChart (spending-echart.js), UI (ui.js), Ant (ant.js).

(function () {
  const WINDOW_LABELS = { 3: '3 Months', 6: '6 Months', 12: '1 Year', 24: '2 Years', 60: '5 Years' };
  const ALLOWED_WINDOWS = [3, 6, 12, 24, 60];
  const VIEWS = ['stacked', 'lines'];
  const VIEW_KEY = 'trends_view';
  const FOCUS_EVENT = 'aventurine:category-focus';
  // The rail's swatch colours, published for the Top Merchants card below,
  // whose bars are drawn in the colour of the category each merchant sits in.
  // Broadcast rather than recomputed there: SpendingChart.colorMap walks the
  // palette in the order the trends payload ranks its categories, so a second
  // caller over a different window would hand the same category a different
  // hue and the two cards of this tab would disagree about what blue means.
  const COLORS_EVENT = 'aventurine:category-colors';
  // The categories the swatches have switched off, published for the Top
  // Merchants card below, which drops their transactions from its ranking. A
  // swatch takes a band out of the chart and its figure out of the rail's
  // period total, so leaving the bars beneath it untouched would put one
  // category on half the tab and not the other half. The whole set travels on
  // each change rather than a delta, so a card that starts listening late is
  // still in step.
  const HIDDEN_EVENT = 'aventurine:category-hidden';

  const state = {
    window: 12,
    view: 'stacked',
    data: null,      // { window, months, categories:[{key,name,monthly}] }
    enabled: null,   // Set<categoryKey> currently plotted
    seenKeys: null,  // Set<categoryKey> seen on a previous load
    colors: null,    // Map<key, color>
    focus: null,     // categoryKey the rail has focused, or null
  };

  function readView() {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (VIEWS.includes(saved)) return saved;
    } catch { /* private mode / blocked storage — the default is fine */ }
    return 'stacked';
  }

  function saveView(view) {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* nothing to recover */ }
  }

  const totalOf = (c) => Object.values(c.monthly).reduce((a, b) => a + b, 0);

  /** Hand the current key -> colour map to whoever else on the tab paints
   *  categories. Fired on every load and on every theme change. */
  function publishColors() {
    window.dispatchEvent(new CustomEvent(COLORS_EVENT, { detail: { colors: state.colors } }));
  }

  /** Hand the switched-off category keys to the rest of the tab. */
  function publishHidden() {
    const hidden = !state.data || !state.enabled
      ? []
      : state.data.categories.map((c) => c.key).filter((k) => !state.enabled.has(k));
    window.dispatchEvent(new CustomEvent(HIDDEN_EVENT, { detail: { hidden } }));
  }

  // ─── Data ────────────────────────────────────────────────────────────────────

  async function load() {
    const res = await apiFetch(`/api/trends?window=${state.window}`);
    if (!res.ok) return;
    state.data = await res.json();

    const keys = state.data.categories.map((c) => c.key);
    // Preserve the user's on/off choices across window changes; default-on for
    // categories we haven't seen before.
    if (!state.enabled) {
      state.enabled = new Set(keys);
    } else {
      const next = new Set();
      for (const k of keys) if (state.enabled.has(k) || !state.seenKeys.has(k)) next.add(k);
      state.enabled = next;
    }
    state.seenKeys = new Set(keys);
    // A focused category the new window has no spending in has nothing left to
    // focus, so the focus is dropped rather than left pointing at a row that is
    // no longer on the rail.
    if (state.focus && !keys.includes(state.focus)) setFocus(null);
    // The current theme's gradient colours (spending-echart.js), so the chart,
    // the rail's swatches and the Top Merchants bars share one set.
    state.colors = SpendingChart.colorMap(keys);
    publishColors();
    // The window's own category set decides what "switched off" can mean, so
    // this follows the load rather than only the swatch.
    publishHidden();

    render();
  }

  function render() {
    UI.setPickerLabel(document.getElementById('trends-range-btn'), WINDOW_LABELS[state.window]);
    renderViewSwitch();
    renderRail();
    renderChart();
  }

  // ─── Rail ────────────────────────────────────────────────────────────────────

  function renderRail() {
    const el = document.getElementById('trends-rail');
    if (!el || !state.data) return;
    const cats = state.data.categories;
    if (!cats.length) {
      el.innerHTML = '';   // the chart column beside it shows the full empty state
      return;
    }

    const total = cats
      .filter((c) => state.enabled.has(c.key))
      .reduce((sum, c) => sum + totalOf(c), 0);

    const rows = cats
      .map((c) => {
        const on = state.enabled.has(c.key);
        const color = state.colors.get(c.key);
        const key = escapeHtml(c.key);
        const name = escapeHtml(c.name);
        return `<div class="tr-row" data-on="${on}" data-focused="${state.focus === c.key}">
        <button type="button" class="tr-sw" data-toggle="${key}" aria-pressed="${on}"
          aria-label="${on ? 'Hide' : 'Show'} ${name}"
          style="background:${on ? color : 'transparent'};border-color:${color}"></button>
        <button type="button" class="tr-name" data-focus="${key}"
          aria-pressed="${state.focus === c.key}">${name}</button>
        <span class="tr-amt">${escapeHtml(formatCurrency(totalOf(c), true))}</span>
      </div>`;
      })
      .join('');

    el.innerHTML = `
      <div class="tr-head">
        <span class="tr-head-label">Period Total</span>
        <span class="tr-head-value">${escapeHtml(formatCurrency(total, true))}</span>
      </div>
      ${rows}`;

    el.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => toggleCategory(b.dataset.toggle)));

    el.querySelectorAll('[data-focus]').forEach((b) =>
      b.addEventListener('click', () => toggleFocus(b.dataset.focus)));
  }

  /** Focus one category or clear it, from the rail's name or from its own band. */
  function toggleFocus(key) {
    if (!state.enabled) return;
    if (state.focus === key) { setFocus(null); } else {
      // Focusing a hidden category shows it: the click asked for that one
      // category, and answering with a chart it isn't drawn on is a refusal.
      state.enabled.add(key);
      // Before the focus goes out, or the card below would take a focus on a
      // category it is still excluding and answer with an empty ranking.
      publishHidden();
      setFocus(key);
    }
    renderRail();
    renderChart();
  }

  /** Show or hide one category, from the rail's swatch. */
  function toggleCategory(key) {
    if (!state.enabled) return;
    // The last visible category cannot be switched off: an empty chart is not a
    // state the rail can be read out of, and a band clicked away would have no
    // chart left to click it back on.
    if (state.enabled.has(key) && state.enabled.size === 1) return;
    if (state.enabled.has(key)) {
      state.enabled.delete(key);
      if (state.focus === key) setFocus(null);
    } else {
      state.enabled.add(key);
    }
    publishHidden();
    renderRail();
    renderChart();
  }

  /** Set the focused category and tell the rest of the tab. `silent` applies an
   *  incoming event without echoing it back out. */
  function setFocus(key, silent) {
    state.focus = key || null;
    if (silent) return;
    const cat = state.data && state.focus
      ? state.data.categories.find((c) => c.key === state.focus)
      : null;
    window.dispatchEvent(new CustomEvent(FOCUS_EVENT, {
      detail: cat ? { key: cat.key, name: cat.name } : null,
    }));
  }

  // ─── Chart ───────────────────────────────────────────────────────────────────

  /** Draw the chart, or the empty state in its place. A focus change or a
   *  category switched on or off is merged into the chart already drawn (see
   *  spending-echart.js), so it animates rather than redraws from scratch. */
  function renderChart() {
    const empty = document.getElementById('trends-empty');
    if (!empty || !state.data) return;
    const { months, categories } = state.data;

    const series = categories
      .filter((c) => state.enabled.has(c.key))
      .map((c) => ({
        id: c.key,
        label: c.name,
        color: state.colors.get(c.key),
        dim: Boolean(state.focus) && state.focus !== c.key,
        active: state.focus === c.key,
        values: months.map((ym) => c.monthly[ym] || 0),
      }));

    if (!series.length) {
      SpendingChart.clear('trends-chart');
      empty.innerHTML = categories.length === 0
        ? Ant.empty({
            title: 'No spending to chart yet',
            desc: 'Categorize some transactions and Aventurine Manage will chart how your spending shifts over time.',
            action: { label: 'Add transactions', href: '/transactions' },
          })
        : Ant.empty({
            compact: true,
            title: 'Nothing selected',
            desc: 'Pick a category to plot it.',
          });
      return;
    }
    empty.innerHTML = '';

    // Clicking a band runs the same focus toggle as its rail name. Stacked only:
    // in the line form the only mark is a thin line, which is too easy to miss.
    SpendingChart.render('trends-chart', {
      view: state.view,
      months,
      series,
      onSeriesClick: state.view === 'stacked' ? toggleFocus : null,
    });
  }

  // ─── Controls ────────────────────────────────────────────────────────────────

  function renderViewSwitch() {
    document.querySelectorAll('#trends-view [data-view]').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('active', on);
    });
  }

  function wireViewSwitch() {
    document.querySelectorAll('#trends-view [data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        const view = b.dataset.view;
        if (!VIEWS.includes(view) || view === state.view) return;
        state.view = view;
        saveView(view);
        renderViewSwitch();
        renderChart();
      }));
  }

  function wireRangePicker() {
    UI.wirePicker('trends-range-btn', 'trends-range-menu', (b) => {
      const w = parseInt(b.dataset.window, 10);
      if (!ALLOWED_WINDOWS.includes(w)) return;
      state.window = w;
      load();
    });
  }

  /** The rail is exactly as wide as the header's control block, so the two line
   *  up on both edges and the controls read as the rail's heading. Measured
   *  rather than declared: the toggle is as wide as its own labels make it, at
   *  whatever the app zoom and the loaded font resolve to, so a hard-coded
   *  column would drift the moment any of that changed. Observed rather than
   *  measured once, because the Spending panel starts hidden behind its tab and
   *  the first reading of a hidden element is zero. */
  function wireRailWidth() {
    const controls = document.getElementById('trends-controls');
    const body = document.querySelector('.trends-body');
    if (!controls || !body || typeof ResizeObserver === 'undefined') return;
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      // Keep the last good width while the panel is hidden, rather than
      // collapsing the column to nothing behind the tab.
      if (w > 0) body.style.setProperty('--trends-rail-w', `${w}px`);
    }).observe(controls);
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('trends-chart') || !document.getElementById('trends-empty')) return;
    state.view = readView();
    wireViewSwitch();
    wireRailWidth();
    wireRangePicker();
    window.addEventListener('currencychange', render);
    // Focus can also be cleared from the Top Merchants card's chip. Applied
    // silently, or the two cards would answer each other in a loop.
    window.addEventListener(FOCUS_EVENT, (e) => {
      const key = e.detail ? e.detail.key : null;
      if (key === state.focus) return;
      // Nothing to focus before the first response has built the category set.
      if (key && !state.enabled) return;
      setFocus(key, true);
      if (key) { state.enabled.add(key); publishHidden(); }
      renderRail();
      renderChart();
    });
    // Each theme has its own category colours (spending-echart.js), so re-map
    // and repaint from the data already held (no round trip).
    window.addEventListener('themechange', () => {
      if (state.data) {
        state.colors = SpendingChart.colorMap(state.data.categories.map((c) => c.key));
        publishColors();
      }
      render();
    });
    load();
  });
}());
