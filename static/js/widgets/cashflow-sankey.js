'use strict';

// ─── Cash Flow (Reports) — Sankey diagram ────────────────────────────────────
// The Reports page's landing report (pages/reports.html), shown when the
// "Cash Flow" tab is selected. Visualises a year's money movement as a
// Sankey: income categories on the left gather into a Net Inflow bar, that
// total crosses the middle as a channel of its own, and a Net Outflow bar fans
// it back out to the expense categories on the right. Each band is sized by that
// category's total over the span on screen, and every ribbon is a gradient
// running between the colours of the two bars it joins.
//
// Tags add one more junction at each outer edge. A category's tagged money
// flows on to a node per tag, and a tag gathers from every category on its side
// whose rows carry it, so "Vacation" shows what it took from Travel, Dining and
// the rest. A transaction has at most one tag, so no money reaches two tag
// nodes; untagged money simply ends at its category. A side with no tagged
// money in the span draws no tag column at all, and the diagram is the
// four-column one.
//
// Nothing balances the two sides here: they are two sums over the same span,
// not one amount conserved through the diagram. So the inflow bar is sized by
// the income and the outflow bar by the spending, and the channel between them
// by the smaller of the two: money kept shows as inflow bar standing past the
// channel, and a year that outspent its income as outflow bar reaching past it.
//
// Pure renderer. It reuses GET /api/data (the Cash Flow table payload) and
// GET /api/data/tags (the same cells split by tag) and aggregates each
// category and tag on the client, over the span the header's joined
// year+month picker names: a whole year, or one month of it. Drawn by Apache
// ECharts' Sankey through widgets/echart-kit.js. A click on a band opens its
// rows in the ledger; the same links are listed, visually hidden, beside the
// canvas for the keyboard and screen readers.
//
// Globals in play (loaded before this script): apiFetch (api.js), escapeHtml
// (escape.js), UI (ui.js), Ant.empty (ant.js), formatCurrency (currency.js),
// EChartKit (echart-kit.js).

(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // GREEN on the left, GOLD on the right, GREY in the middle. The two sides of
  // this diagram are not two sets of categories, they are money arriving and
  // money leaving, and the colour split is how that reads before a single label
  // is:
  //
  //   income (left)   — the green --chart-inflow-* ramp, six steps deepest
  //       first. Green is what money arriving means on any bank statement, and
  //       it is the app's income colour everywhere else too — the Dashboard's
  //       Income line and the income half of its Monthly Cash Flow bars read
  //       these same tokens. Same size-order rule as the outflow side, so the
  //       main earner takes the strongest step.
  //   expenses (right)— the --chart-outflow-* ramp, deepest first, starting at
  //       --chart-expense rather than at the ramp's own first step, so the
  //       biggest band wears the gold the Dashboard's Expenses line wears
  //       (core/chartramp.js carries that rule, which this shares with the
  //       Dashboard's two gold cards).
  //       The ramp is a set of hues (ant.css maps it onto the --ant-chart-*
  //       palette), laid out in size order, so neighbouring bands never share
  //       a hue family; every band prints its own name and figure on itself,
  //       so colour never has to carry identity alone.
  //
  // This is the one place the expense side stopped sharing --cat-* with the
  // Spending report and the Saved & Invested by Account card. Those two rank and itemize
  // categories, where a colour is a NAME; here it is a direction.
  //
  // The hub is neither ramp: --chart-net is the palette's green (ant.css). The
  // two hub bars are the
  // one place all the money on each side has landed as a single amount, which
  // makes them something held rather than something flowing, and a hub from a
  // third family cannot be read as one more source. Both bars take the same
  // colour: they are two ends of one stage, not two stages.
  // Colours are read from the theme's tokens on every paint (EChartKit.theme),
  // so a theme change re-colours the diagram.
  //
  // Ribbons are GRADIENTS rather than flat fills: one starts in the colour of
  // the bar it leaves and ends in the colour of the bar it meets - category to
  // net on the income side, net to category on the expense side - so the middle
  // channel's colour is what both halves hand off through. A flat ribbon had to
  // take one end's colour, which left a seam at the other end.
  const state = {
    data: null,   // last /api/data payload
    tagNames: new Map(),  // tag id → name, from /api/data/tags
    tagCells: {},         // {year → {month → {catKey → {tagId → total}}}}
    year: null,   // selected year (number)
    month: null,  // selected month name, or null for the whole year
  };

  const ENTIRE_YEAR = 'Entire year';

  // Deep-link a category to the Transactions ledger, pre-filtered to that
  // category and the year on screen. The Transactions page reads these back from
  // location.search (txApplyUrlFilters). `cat` is the stable category key — the
  // same slug both this diagram (GET /api/data columns) and the Transactions
  // category list share — so it survives renames.
  function categoryHref(key) {
    // `month` narrows the ledger to the same span the diagram is drawing, so a
    // band clicked while January is on screen does not open the whole year.
    const month = state.month ? `&month=${MONTHS.indexOf(state.month) + 1}` : '';
    return `/transactions?year=${state.year}${month}&cat=${encodeURIComponent(key)}`;
  }

  // A tag band links the same way, narrowed to its side of the ledger: a tag
  // can carry income and spending both, and each side's band is only one.
  function tagHref(id, type) {
    const month = state.month ? `&month=${MONTHS.indexOf(state.month) + 1}` : '';
    return `/transactions?year=${state.year}${month}&tag=${id}&type=${type}`;
  }

  // ─── Currency helpers ──────────────────────────────────────────────────────
  // One form, used for the printed amounts and the tooltips alike: the full
  // figure, grouped and in the user's own format. The labels are spaced a whole
  // label apart now, so there is room for it — a rounded "$14.8K" under a
  // category was hiding digits nothing else on the page hides.
  const fmtMoney = (n) => formatCurrency(n, true);

  /** A category's share of its OWN side's total — income bands read against
   *  income, expense bands against expenses — so the two columns each add up to
   *  100% and a small category is measured against something it belongs to.
   *  Under 10% keeps a decimal, since whole percents would flatten the tail of a
   *  dozen categories into a row of 1s and 0s. */
  function fmtShare(value, total) {
    if (!(total > 0)) return '';
    const pct = (value / total) * 100;
    if (pct > 0 && pct < 0.1) return '(<0.1%)';
    return `(${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)`;
  }

  // ─── Data ───────────────────────────────────────────────────────────────────

  async function load() {
    const [res, tagRes] = await Promise.all([
      apiFetch('/api/data'),
      apiFetch('/api/data/tags').catch((err) => { console.error(err); return null; }),
    ]);
    if (!res.ok) return;
    state.data = await res.json();
    // The tag layer is extra: without it the diagram is still whole.
    if (tagRes && tagRes.ok) {
      const tags = await tagRes.json();
      state.tagNames = new Map((tags.tags || []).map((t) => [t.id, t.name]));
      state.tagCells = tags.cells || {};
    } else {
      state.tagNames = new Map();
      state.tagCells = {};
    }

    const years = (state.data.years || []).slice().sort((a, b) => b - a);
    if (state.year === null || !years.includes(state.year)) {
      state.year = years.length ? years[0] : null;
    }
    buildYearMenu(years);
    render();
  }

  /** Sum each category over `year` — all 12 months, or the one named by
   *  `month` — split by income/expense. Returns
   *  { income:[{key,label,total}], expense:[…], totalIncome, totalExpense },
   *  zero categories dropped, sorted by total desc (largest bands lead).
   *  One month is the same sum over a one-element span, so the diagram, its
   *  shares and the empty state all keep working with no second code path. */
  function aggregate(year, month) {
    const cols = (state.data.columns || []);
    const months = ((state.data.entries || {})[String(year)]) || {};
    const span = month ? [month] : MONTHS;

    const totals = new Map(); // key -> running sum
    for (const m of span) {
      const cells = months[m];
      if (!cells) continue;
      for (const [key, value] of Object.entries(cells)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          totals.set(key, (totals.get(key) || 0) + value);
        }
      }
    }

    const side = (type) => cols
      .filter((c) => c.type === type)
      .map((c) => ({ key: c.key, label: c.label, total: totals.get(c.key) || 0 }))
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total);

    const income = side('income');
    const expense = side('expense');
    const sum = (arr) => arr.reduce((a, c) => a + c.total, 0);
    return { income, expense, totalIncome: sum(income), totalExpense: sum(expense) };
  }

  /** The tag nodes for one side: the tagged money in `categories` (one side's
   *  aggregate() output) over the same span, gathered per tag. Returns
   *  [{ id, label, total, flows: [{ key, value }] }], where each flow is the
   *  part of one category that carries the tag. */
  function tagSide(categories, year, month) {
    const months = state.tagCells[String(year)] || {};
    const span = month ? [month] : MONTHS;
    const onSide = new Set(categories.map((c) => c.key));
    const byTag = new Map();   // tag id -> { id, label, total, flows: Map(key -> value) }
    for (const m of span) {
      for (const [key, tags] of Object.entries(months[m] || {})) {
        if (!onSide.has(key)) continue;
        for (const [rawId, value] of Object.entries(tags)) {
          const id = Number(rawId);
          const label = state.tagNames.get(id);
          if (label === undefined || !(value > 0)) continue;
          let node = byTag.get(id);
          if (!node) byTag.set(id, (node = { id, label, total: 0, flows: new Map() }));
          node.total += value;
          node.flows.set(key, (node.flows.get(key) || 0) + value);
        }
      }
    }
    return [...byTag.values()].map((n) => ({
      ...n,
      flows: [...n.flows].map(([key, value]) => ({ key, value })),
    }));
  }

  // ─── Diagram ─────────────────────────────────────────────────────────────────
  // Apache ECharts' Sankey (widgets/echart-kit.js). The columns are fixed by
  // each node's `depth`, and layoutIterations: 0 keeps every column in the
  // order given (largest first), so the biggest band leads each side. The
  // node gap is a label's height, so every label sits on its own band.

  const NODE_W = 13;          // node-bar thickness
  const LABEL_GAP = 32;       // a label block's height (name over amount); the gap between bands
  const LINK_OPACITY = 0.4;   // G2's Sankey links sit at about a third of their colour

  /** A user label made safe for ECharts rich text, where braces and bars are
   *  markup: they are swapped for look-alikes so a name can never restyle or
   *  break its own label. */
  const richSafe = (text) => String(text).replace(/[{}|]/g, (c) => ({ '{': '❴', '}': '❵', '|': '¦' }[c]));

  /** Everything the diagram draws for the span on screen, or null when it
   *  has no money in it. */
  function buildModel() {
    const { income, expense, totalIncome, totalExpense } = aggregate(state.year, state.month);
    if (totalIncome <= 0 && totalExpense <= 0) return null;
    const incomeTags = tagSide(income, state.year, state.month);
    const expenseTags = tagSide(expense, state.year, state.month);

    // Column numbers: a side with tagged money adds its tag column at the
    // outer edge, and everything inside it moves one column in.
    let col = 0;
    const depth = {};
    if (incomeTags.length) depth.incomeTag = col++;
    depth.income = col++;
    depth.hubIn = col++;
    depth.hubOut = col++;
    depth.expense = col++;
    if (expenseTags.length) depth.expenseTag = col++;

    const nodes = [];
    const links = [];
    const node = (id, n) => nodes.push({ name: id, ...n });
    const link = (source, target, value, extra) => {
      if (value > 0) links.push({ source, target, value, ...extra });
    };
    const IN = 'hub:in';
    const OUT = 'hub:out';
    const span = state.month ? 'month' : 'year';

    income.forEach((c, i) => {
      node(`in:${c.key}`, { label: c.label, total: c.total, side: 'income', depth: depth.income, rank: i,
        href: categoryHref(c.key), share: fmtShare(c.total, totalIncome) });
      link(`in:${c.key}`, IN, c.total, { href: categoryHref(c.key), label: `${c.label} → Net Inflow` });
    });
    expense.forEach((c, i) => {
      node(`out:${c.key}`, { label: c.label, total: c.total, side: 'expense', depth: depth.expense, rank: i,
        href: categoryHref(c.key), share: fmtShare(c.total, totalExpense) });
      link(OUT, `out:${c.key}`, c.total, { href: categoryHref(c.key), label: `Net Inflow → ${c.label}` });
    });
    if (totalIncome > 0) node(IN, { label: 'Net Inflow', total: totalIncome, side: 'hub', depth: depth.hubIn });
    if (totalExpense > 0 || totalIncome > 0) node(OUT, { label: 'Net Outflow', total: totalExpense, side: 'hub', depth: depth.hubOut });
    // The channel across the middle carries the money that arrived AND left.
    // A node is as tall as the larger of its two sides, so this is what lets
    // each hub bar keep its own total: with money left over, the inflow bar
    // stands taller than the channel by what was kept; a year that outspent
    // its income shows the outflow bar reaching past it by the difference.
    link(IN, OUT, Math.min(totalIncome, totalExpense), { label: 'Net Inflow → Net Outflow' });

    // Tags: a tag gathers from every category on its side whose rows carry
    // it, so "Vacation" shows what it took from Travel, Dining and the rest.
    for (const t of incomeTags) {
      const href = tagHref(t.id, 'income');
      node(`intag:${t.id}`, { label: t.label, total: t.total, side: 'incomeTag', depth: depth.incomeTag,
        href, share: fmtShare(t.total, totalIncome) });
      for (const f of t.flows) link(`intag:${t.id}`, `in:${f.key}`, f.value, { href, label: `${t.label} → ${(income.find((c) => c.key === f.key) || {}).label}` });
    }
    for (const t of expenseTags) {
      const href = tagHref(t.id, 'expense');
      node(`outtag:${t.id}`, { label: t.label, total: t.total, side: 'expenseTag', depth: depth.expenseTag,
        href, share: fmtShare(t.total, totalExpense) });
      for (const f of t.flows) link(`out:${f.key}`, `outtag:${t.id}`, f.value, { href, label: `${(expense.find((c) => c.key === f.key) || {}).label} → ${t.label}` });
    }
    return { nodes, links, span };
  }

  // GREEN on the left, GOLD on the right, GREY in the middle (see the block at
  // the top of this file): each node's colour by its side and its rank.
  function nodeColor(t, n) {
    if (n.side === 'hub') return t.net;
    if (n.side === 'incomeTag' || n.side === 'expenseTag') return t.tag;
    const ramp = n.side === 'income' ? t.inflow : t.outflow;
    return ramp[n.rank % ramp.length];
  }

  /** Labels hang off each bar's INNER face, out over its own ribbon: to the
   *  right on the income side, to the left on the expense side. */
  const LABEL_SIDE = { income: 'right', incomeTag: 'right', expense: 'left', expenseTag: 'left' };

  function buildOption(t, model) {
    const labelFor = (n) => {
      const amount = fmtMoney(n.total);
      return `{name|${richSafe(n.label)}}\n{amount|${richSafe(amount)}}${n.share ? ` {share|${n.share}}` : ''}`;
    };
    const rich = {
      name: { color: t.textSecondary, fontFamily: t.font, fontSize: t.fontSize, lineHeight: 16 },
      amount: { color: t.text, fontFamily: t.font, fontSize: 13, fontWeight: 600, lineHeight: 18 },
      share: { color: t.textTertiary, fontFamily: t.font, fontSize: t.fontSize, lineHeight: 18 },
    };
    return {
      tooltip: EChartKit.tooltip(t, {
        trigger: 'item',
        formatter: (p) => {
          const d = p.data;
          if (p.dataType === 'edge') {
            return EChartKit.tipHtml({ rows: [{ color: p.color && p.color.colorStops ? null : p.color, name: d.label, value: fmtMoney(d.value) }] });
          }
          return EChartKit.tipHtml({
            rows: [{ color: nodeColor(t, d), name: d.label, value: fmtMoney(d.total) }],
            note: d.href ? `Click to see its transactions for this ${model.span}` : '',
          });
        },
      }),
      series: [{
        type: 'sankey',
        left: 10,
        right: 10,
        top: 28,
        bottom: 28,
        nodeWidth: NODE_W,
        nodeGap: LABEL_GAP,
        nodeAlign: 'justify',
        layoutIterations: 0,
        draggable: false,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', curveness: 0.5, opacity: LINK_OPACITY },
        label: { distance: 10, rich },
        data: model.nodes.map((n) => ({
          ...n,
          itemStyle: { color: nodeColor(t, n), borderWidth: 0 },
          label: {
            position: n.side === 'hub' ? (n.name === 'hub:in' ? 'right' : 'left') : LABEL_SIDE[n.side],
            formatter: () => labelFor(n),
          },
          cursor: n.href ? 'pointer' : 'default',
        })),
        links: model.links.map((l) => ({
          ...l,
          // The channel is a stage, not a category: it holds the hub's grey.
          ...(l.source === 'hub:in' && l.target === 'hub:out' ? { lineStyle: { color: t.net, opacity: LINK_OPACITY } } : {}),
        })),
      }],
    };
  }

  /** The diagram's links as real links, for the keyboard and screen readers:
   *  a canvas has no focusable parts, so each category and tag the diagram
   *  draws is listed, visually hidden, beside it. */
  function renderLinks(model) {
    const chart = document.getElementById('cashflow-chart');
    if (!chart) return;
    let nav = document.getElementById('cashflow-links');
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'cashflow-links';
      nav.className = 'ant-visually-hidden';
      nav.setAttribute('aria-label', 'Cash flow categories');
      chart.after(nav);
    }
    nav.innerHTML = model
      ? `<ul>${model.nodes.filter((n) => n.href).map((n) =>
        `<li><a href="${escapeHtml(n.href)}">${escapeHtml(`${n.label}: ${fmtMoney(n.total)} — view transactions for ${state.year}`)}</a></li>`).join('')}</ul>`
      : '';
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  function showEmpty(show) {
    const el = document.getElementById('cashflow-empty');
    const chart = document.getElementById('cashflow-chart');
    if (!el || !chart) return;
    if (show) {
      el.innerHTML = Ant.empty({
        title: state.year === null
          ? 'No data yet'
          : `Nothing to chart for this ${state.month ? 'month' : 'year'}`,
        // Name the destination, not the statement: this empty state sits
        // directly under a tab also labelled "Cash Flow", so "the Cash Flow
        // page" would read as somewhere on this page rather than Statements.
        desc: 'Add income and expenses to your Cash Flow statement and the diagram will map how your money moves.',
        action: { label: 'Open Statements', href: '/statements#cash-flow' },
      });
      EChartKit.unmount(chart);
      chart.innerHTML = '';
    } else {
      el.innerHTML = '';
    }
  }

  function render() {
    const el = document.getElementById('cashflow-chart');
    if (!el || !state.data) return;
    const model = state.year === null ? null : buildModel();
    renderLinks(model);
    if (!model) { showEmpty(true); return; }
    showEmpty(false);
    EChartKit.mount(el, (t) => buildOption(t, model), {
      label: `Cash flow for ${state.month ? `${state.month} ` : ''}${state.year}`,
      on: {
        click: (p) => {
          const href = p.data && p.data.href;
          if (href) location.assign(href);
        },
      },
    });
  }

  // ─── Span picker: year + month, one joined control ───────────────────────────
  // Two .range-selector halves sharing a seam (.range-selector-pair in
  // forecast.css). The left half picks the year, the right half picks how much
  // of it to draw: "Entire year" — the option the report opened on before the
  // month half existed — or one of the twelve months, which draws that month
  // alone with the year still shown in the half to its left.
  //
  // All twelve months are listed whatever the ledger holds, so the list is the
  // same twelve rows in the same order every time it opens and does not shuffle
  // when the year changes; a month with no rows draws the card's empty state.
  // The month choice SURVIVES a year change — "March, and now show me last
  // March" is the comparison the pair is for.

  function buildYearMenu(years) {
    const btn = document.getElementById('cashflow-year-btn');
    const menu = document.getElementById('cashflow-year-menu');
    if (!btn || !menu) return;

    const monthBtn = document.getElementById('cashflow-month-btn');
    if (!years.length) {
      UI.setPickerLabel(btn, 'No data');
      btn.disabled = true;
      menu.innerHTML = '';
      if (monthBtn) monthBtn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (monthBtn) monthBtn.disabled = false;
    UI.setPickerLabel(btn, String(state.year));
    menu.innerHTML = years
      .map((y) => `<button type="button" data-year="${y}">${y}</button>`)
      .join('');
  }

  function buildMonthMenu() {
    const menu = document.getElementById('cashflow-month-menu');
    if (!menu) return;
    // data-month is empty for the whole-year option, which is what state.month
    // being null means — one attribute covers both cases with no sentinel.
    menu.innerHTML = [`<button type="button" data-month="">${ENTIRE_YEAR}</button>`]
      .concat(MONTHS.map((m) => `<button type="button" data-month="${m}">${m}</button>`))
      .join('');
    // Pin the half to its widest caption, so picking September does not widen
    // the pair and shove the seam sideways under the year beside it.
    UI.lockPickerWidth(document.getElementById('cashflow-month-btn'),
      [ENTIRE_YEAR].concat(MONTHS));
  }

  function wirePickers() {
    UI.wirePicker('cashflow-year-btn', 'cashflow-year-menu', (b) => {
      const y = parseInt(b.dataset.year, 10);
      if (y === state.year) return;
      state.year = y;
      UI.setPickerLabel(document.getElementById('cashflow-year-btn'), String(y));
      render();
    });

    UI.wirePicker('cashflow-month-btn', 'cashflow-month-menu', (b) => {
      const m = b.dataset.month || null;
      if (m === state.month) return;
      state.month = m;
      UI.setPickerLabel(document.getElementById('cashflow-month-btn'), m || ENTIRE_YEAR);
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('cashflow-chart')) return;
    buildMonthMenu();
    wirePickers();
    load();
    // Retone amounts when the currency symbol changes in Settings. A theme
    // change needs nothing here: the kit rebuilds the diagram's colours.
    window.addEventListener('currencychange', render);
  });
}());
