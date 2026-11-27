'use strict';

// ─── Inflation + Lifestyle Beta (Reports) ────────────────────────────────────
// Two tabs of the Reports page that borrow their idea from investing.
//
// PERSONAL INFLATION (GET /api/insights/inflation): the merchants you keep
// going back to, each one's average bill in the first half of its history
// against the second half. The headline is the spend-weighted rate across the
// steady ones (see services/inflation.js for what "steady" means), shown beside
// the typical (median) merchant so one big bill — rent — cannot be the whole
// story. Picking a row opens that merchant's every visit as dots over time,
// with the two averages drawn as level lines across their halves: the question
// "has my Chipotle bill averaged up?" answered as a picture. The table toggles
// to Categories, the same rows and chart with every expense in a category as a
// "visit"; categories are browsed, not counted in the headline or the index.
//
// LIFESTYLE BETA (GET /api/insights/lifestyle-beta): monthly spending regressed
// on monthly income, both as 3-month rolling averages. The scatter carries the
// fitted line and the break-even line (spend = income), so a point's distance
// above or below the diagonal is that quarter's saving or overspending. The
// category list itemises β: the slopes add up to the total.
//
// Every chart is hand-rolled SVG coloured from CSS custom properties, so a
// theme flip restyles it without a redraw. Hover reads every mark in a small
// tooltip; the lists beside each chart are its table view.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), merchantAvatarHtml (avatar.js), ChartMath (chartmath.js),
// Ant (ant.js).

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // sort: { key: 'name' | 'visits' | 'change', order: 'ascend' | 'descend' },
  // or null for the backend's order (most spent first).
  // view: which list the table shows, 'merchants' or 'categories'. selected
  // is a row key from either list (category keys start 'c:', so they never
  // collide with a merchant's).
  const state = { inflation: null, beta: null, selected: null, sort: null, view: 'merchants' };
  // Both inflation charts share one height, so swapping between the index and
  // a merchant does not move the list under them.
  const CHART_H = 200;

  // ─── Formatting ────────────────────────────────────────────────────────────

  const money = (v) => formatCurrency(v);
  const moneyRound = (v) => formatCurrency(Math.round(v)).replace(/\.00$/, '');
  const pct = (v, dp = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(dp)}%`;
  const dateLabel = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  };
  const ymLabel = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  };
  const ymShift = (ym, n) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  // A window of months, ['2026-09', '2026-11'] → "Sep–Nov 2026" (the year is
  // repeated only when the window crosses one: "Nov 2025–Jan 2026").
  const rangeLabel = ([a, b]) => {
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return ya === yb ? `${MONTHS[ma - 1]}–${MONTHS[mb - 1]} ${yb}` : `${MONTHS[ma - 1]} ${ya}–${MONTHS[mb - 1]} ${yb}`;
  };
  // Direction of a price change. Under half a percent is "flat": a rounding
  // difference is not a trend and should not be painted as one.
  const dirOf = (v) => (v > 0.005 ? 'up' : v < -0.005 ? 'down' : 'flat');
  const arrow = (v) => ({ up: '▲', down: '▼', flat: '■' }[dirOf(v)]);

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  // An ⓘ after a title, its text on hover and focus (Ant's info tip). Each
  // headline figure carries its own: how that one number is worked out.
  function infoTip(text) {
    const safe = escapeHtml(text);
    return `<span class="ant-info-tip" tabindex="0" role="note" aria-label="${safe}" data-tip="${safe}">${Ant.icon('info-circle-outlined')}</span>`;
  }

  function statHtml(title, value, foot = '', cls = '') {
    return `<div class="ins-stat ${cls}">
      <div class="ant-statistic-title">${title}</div>
      <div class="ant-statistic-content">${value}</div>
      ${foot ? `<div class="ins-stat-foot">${foot}</div>` : ''}
    </div>`;
  }

  // ─── Tooltip (one per plot) ────────────────────────────────────────────────

  function tooltip(host) {
    let tip = host.querySelector('.ins-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'ins-tip';
      tip.hidden = true;
      host.appendChild(tip);
    }
    return {
      show(html, x, y) {
        tip.innerHTML = html;
        tip.hidden = false;
        const w = tip.offsetWidth;
        const left = Math.min(Math.max(x - w / 2, 0), host.clientWidth - w);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
      },
      hide() { tip.hidden = true; },
    };
  }

  // ─── Axis frame shared by both plots ───────────────────────────────────────

  // Calendar x ticks: the first of each quarter, labelled "Apr", "Jul", "Oct",
  // with Jan 1 labelled by its year ("2025") so the year boundary stands out.
  // A month-and-two-digit-year label ("Apr 25") read as a day, hence the change.
  // Thinned to half-years, then years, when the quarters would crowd.
  // `first`/`last` are { y, m } (m 0-11); returns [{ y, m, year }].
  function quarterTicks(first, last, plotW) {
    const months = (last.y - first.y) * 12 + (last.m - first.m);
    let step = 3;
    while (step < 12 && (months / step) * 44 > plotW) step *= 2;
    const ticks = [];
    let y = first.y;
    let m = Math.ceil(first.m / step) * step;
    for (; y < last.y || (y === last.y && m <= last.m); m += step) {
      if (m >= 12) { y += 1; m -= 12; }
      if (y > last.y || (y === last.y && m > last.m)) break;
      ticks.push({ y, m, year: m === 0 });
    }
    return ticks;
  }
  const quarterLabel = (q) => (q.year ? String(q.y) : MONTHS[q.m]);

  function frame(host, { height, xTicks, yTicks, x, y, xFmt, yFmt, xClass, pad, xLabelY = height - 8 }) {
    host.querySelectorAll('svg').forEach((s) => s.remove());
    const W = host.clientWidth;
    const svg = el('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, class: 'ins-svg', role: 'img' });
    const grid = el('g', { class: 'ins-grid' }, svg);
    for (const t of yTicks) {
      el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t) }, grid);
      el('text', { x: pad.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'ins-axis' }, grid).textContent = yFmt(t);
    }
    for (const t of xTicks) {
      el('text', { x: x(t), y: xLabelY, 'text-anchor': 'middle', class: `ins-axis ${xClass ? xClass(t) : ''}` }, grid).textContent = xFmt(t);
    }
    host.prepend(svg);
    return { svg, W };
  }

  // ─── Personal Inflation ────────────────────────────────────────────────────

  async function loadInflation() {
    const res = await apiFetch('/api/insights/inflation');
    if (!res.ok) return;
    state.inflation = await res.json();
    // Open on the overall index; a merchant is something the reader picks.
    if (!findItem(state.selected)) state.selected = null;
    renderInflation();
  }

  function renderInflation() {
    const d = state.inflation;
    const stats = document.getElementById('inflation-stats');
    const split = document.getElementById('inflation-split');
    if (!d || !stats) return;
    // The card above the split only carries the empty state.
    const card = stats.closest('.ins-infl-stats');

    if (!d.merchants.length) {
      split.hidden = true;
      card.hidden = false;
      stats.innerHTML = Ant.empty({
        title: 'No regular merchants yet',
        desc: `A merchant appears here once you have visited it ${d.rules.min_visits} times, including at least once in ${windowsText(d)}.`,
        action: { label: 'Add transactions', href: '/transactions' },
      });
      return;
    }
    split.hidden = false;
    card.hidden = true;
    stats.innerHTML = '';

    renderInflationList();
    renderMerchantDetail();
  }

  // "Sep–Nov 2026 and Sep–Nov 2025", or a general phrase on an empty ledger.
  const windowsText = (d) => (d.windows
    ? `both ${rangeLabel(d.windows.recent)} and ${rangeLabel(d.windows.prior)}`
    : `the last ${d.rules.window_months} months and the same months a year earlier`);

  const isCatView = () => state.view === 'categories';
  const listItems = () => (isCatView() ? state.inflation.categories || [] : state.inflation.merchants);
  function findItem(key) {
    const d = state.inflation;
    if (!d || !key) return null;
    return (key.startsWith('c:') ? d.categories || [] : d.merchants).find((x) => x.key === key) || null;
  }

  function renderInflationList() {
    const d = state.inflation;
    const cats = isCatView();
    const items = listItems();
    const body = document.getElementById('inflation-list');
    const tbody = document.getElementById('inflation-tbody');
    const sortKey = state.sort ? state.sort.key : null;
    const sorted = (key) => (sortKey === key ? ' ant-table-column-sort' : '');
    // Bars share one scale, capped so one merchant that doubled does not
    // flatten every other bar to a sliver.
    // Categories carry no Varied flag, so every one of them sets the scale.
    const cap = Math.min(1, Math.max(0.1, ...items.filter((m) => m.steady || cats).map((m) => Math.abs(m.change))));
    const rows = sortedMerchants(items).map((m) => {
      const dir = dirOf(m.change);
      const len = Math.min(1, Math.abs(m.change) / cap) * 50;
      const bar = `<span class="ins-dbar" aria-hidden="true"><span class="ins-dbar-fill ins-fill-${dir} ${m.change >= 0 ? 'ins-dbar-right' : 'ins-dbar-left'}"
        style="${m.change >= 0 ? 'left:50%' : `left:${50 - len}%`};width:${len}%"></span></span>`;
      // Categories never feed the rate, so they carry no Varied flag (badge or
      // dimming): it only says "left out of your rate", which is a merchant's.
      const varied = m.steady || cats ? '' : '<span class="ant-tag ins-varied" data-tip="Bills here vary too much to compare like for like, so this merchant is not in your rate.">Varied</span>';
      const sel = m.key === state.selected;
      // The row is the control: click or Enter/Space opens the merchant in the
      // chart above, and the selected-row tint (Ant's) marks which one is open.
      return `<tr class="ins-tr${sel ? ' ant-table-row-selected' : ''}${m.steady || cats ? '' : ' is-varied'}"
          data-key="${escapeHtml(m.key)}" tabindex="0" aria-selected="${sel}">
        <td class="${sorted('name').trim()}"><div class="ins-merchant">${cats ? '' : merchantAvatarHtml(m.name)}<span class="ins-name">${escapeHtml(m.name)}</span>${varied}</div></td>
        <td class="ant-table-cell-end ins-num${sorted('visits')}">${m.visits}</td>
        <td class="ins-change-cell${sorted('change')}"><div class="ins-change-wrap">${bar}
          <span class="ins-change ins-${dir}">${arrow(m.change)} ${pct(m.change, 0)}</span></div></td>
      </tr>`;
    });
    document.getElementById('inflation-thead').innerHTML = `<tr>
        ${sorterHtml('name', cats ? 'Category' : 'Merchant', '')}${sorterHtml('visits', 'Transactions', 'ant-table-cell-end')}${sorterHtml('change', 'Change', 'ant-table-cell-end')}
      </tr>`;
    const scroll = body.scrollTop;
    tbody.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="3">${Ant.empty({ compact: true,
      title: 'No regular categories yet',
      desc: `A category appears here once it has ${d.rules.min_visits} transactions, including at least one in ${windowsText(d)}.` })}</td></tr>`;
    body.scrollTop = scroll;
  }

  // ─── Sorting ───────────────────────────────────────────────────────────────
  // The Ant table sorter (as on Transactions): click cycles ascending →
  // descending → off, and off is the backend's order, most spent first. Text
  // sorts A→Z first; numbers sort largest first on the first click, since
  // "most transactions" and "biggest rise" are what a reader reaches for.
  const SORT_FIRST = { name: 'ascend', visits: 'descend', change: 'descend' };
  const SORT_LABEL = { ascend: 'ascending', descend: 'descending' };

  function nextSort(key) {
    const cur = state.sort && state.sort.key === key ? state.sort.order : null;
    const first = SORT_FIRST[key];
    const second = first === 'ascend' ? 'descend' : 'ascend';
    if (!cur) return { key, order: first };
    if (cur === first) return { key, order: second };
    return null;
  }

  function sortedMerchants(list) {
    if (!state.sort) return list;
    const { key, order } = state.sort;
    const dirMul = order === 'ascend' ? 1 : -1;
    const cmp = key === 'name'
      ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : (a, b) => a[key] - b[key];
    // Ties fall back to spend, the default order, so equal rows hold still.
    return [...list].sort((a, b) => dirMul * cmp(a, b) || b.total - a.total);
  }

  function sorterHtml(key, title, cls) {
    const order = state.sort && state.sort.key === key ? state.sort.order : null;
    const caret = (dir, name) => `<span class="${order === dir ? 'ant-table-column-sorter-on' : ''}">${Ant.icon(name)}</span>`;
    const next = nextSort(key);
    const tip = next ? `Sort ${SORT_LABEL[next.order]}` : 'Clear sorting';
    return `<th scope="col" class="${cls} ant-table-column-has-sorters${order ? ' ant-table-column-sort' : ''}"${order ? ` aria-sort="${SORT_LABEL[order]}"` : ''}>
      <button type="button" class="ant-table-column-sorters" data-sort="${key}" data-tip="${tip}">
        <span class="ant-table-column-title">${title}</span>
        <span class="ant-table-column-sorter" aria-hidden="true">${caret('ascend', 'caret-up')}${caret('descend', 'caret-down')}</span>
      </button></th>`;
  }

  function renderMerchantDetail() {
    const d = state.inflation;
    const m = findItem(state.selected);
    const title = document.getElementById('inflation-detail-title');
    const statsEl = document.getElementById('inflation-detail-stats');
    const link = document.getElementById('inflation-detail-link');
    const host = document.getElementById('inflation-chart');
    if (!host) return;
    if (!m) { renderOverall(); return; }

    const isCat = m.key.startsWith('c:');
    title.innerHTML = `${isCat ? '' : merchantAvatarHtml(m.name)}<span>${escapeHtml(m.name)}</span>`;
    const href = isCat ? `/transactions?cat=${encodeURIComponent(m.cat)}`
      : m.search ? `/transactions?name=${encodeURIComponent(m.search)}` : '';
    link.innerHTML = `${href
      ? `<a class="ant-btn ant-btn-link ant-btn-sm" href="${escapeHtml(href)}">See transactions</a>`
      : ''}<button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-action="overall">${Ant.icon('close')}<span>Back to overall</span></button>`;
    const dir = dirOf(m.change);
    const mini = (label, value, foot) =>
      `<span class="ins-mini"><span class="ins-mini-label">${label}</span><strong>${value}</strong><span class="ins-mini-foot">${foot}</span></span>`;
    statsEl.innerHTML = [
      mini(rangeLabel(m.prior_window), money(m.early_avg), `avg of ${m.early_visits}`),
      mini(rangeLabel(m.recent_window), money(m.recent_avg), `avg of ${m.recent_visits}`),
      mini('Change', `<span class="ins-${dir}">${arrow(m.change)} ${pct(m.change)}</span>`, 'over 12 months'),
    ].join('');
    drawVisits(host, m);
  }

  // ─── The overall index (no merchant picked) ───────────────────────────────

  function renderOverall() {
    const d = state.inflation;
    const host = document.getElementById('inflation-chart');
    document.getElementById('inflation-detail-link').innerHTML = '';
    const statsEl = document.getElementById('inflation-detail-stats');
    const tr = d.trend || [];
    if (tr.length < 2) {
      statsEl.innerHTML = '';
      host.querySelectorAll('svg').forEach((x) => x.remove());
      host.innerHTML = Ant.empty({ compact: true, title: 'Not enough history for a trend yet',
        desc: `Pick a ${isCatView() ? 'category' : 'merchant'} below to see its bills.` });
      return;
    }
    const lastPt = tr[tr.length - 1];
    const chg = lastPt.change;
    // The title carries the answer: the latest 12-month change, beside the
    // name, with the method behind the ⓘ.
    document.getElementById('inflation-detail-title').innerHTML = `<span>Personal Price Index</span>${infoTip(
      'How much more or less you paid per visit at the places you go regularly than a year earlier, month by month: the same 12-month change the reported CPI is quoted as. '
      + 'Each month compares the average bill at each place over the 3 months to that month with the same 3 months a year before, averaged with every place counted equally.')}
      <span class="ins-head-figure ins-${dirOf(chg)}">${arrow(chg)} ${pct(chg)}</span><span class="ins-head-since">over the year to ${ymLabel(lastPt.ym)}</span>`;
    // No caption: the row keeps its height (min-height in insights.css), so
    // opening a merchant's figures does not push the chart or the list down.
    statsEl.innerHTML = '';
    drawTrend(host, tr);
  }

  function drawTrend(host, tr) {
    host.querySelectorAll('.ant-empty').forEach((x) => x.remove());
    if (!host.clientWidth) return;
    // Plotted as the 12-month change in percent, on a 0% (no change) baseline,
    // the way CPI charts are drawn.
    const chgOf = (p) => p.change * 100;
    const vals = tr.map(chgOf);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const spread = Math.max(4, hi - lo);
    const yTicks = ChartMath.niceTicks(lo - spread * 0.1, hi + spread * 0.1, 4);
    const yMin = yTicks[0];
    const yMax = yTicks[yTicks.length - 1];
    const H = CHART_H;
    const pad = { l: 48, r: 16, t: 16, b: 32 };
    const W = host.clientWidth;
    const n = tr.length;
    const x = (i) => pad.l + (n > 1 ? i / (n - 1) : 0.5) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
    // Each point is a month, so a quarter tick sits on that month's index.
    const ymOf = (p) => { const [yy, mm] = p.ym.split('-').map(Number); return { y: yy, m: mm - 1 }; };
    const m0 = ymOf(tr[0]);
    const qs = quarterTicks(m0, ymOf(tr[n - 1]), W - pad.l - pad.r);
    const qAt = new Map(qs.map((q) => [(q.y - m0.y) * 12 + (q.m - m0.m), q]));
    const { svg } = frame(host, {
      height: H, pad, x, y, yTicks, xTicks: [...qAt.keys()],
      yFmt: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}%`,
      xFmt: (i) => quarterLabel(qAt.get(i)),
      xClass: (i) => (qAt.get(i).year ? 'ins-axis-year' : ''),
    });
    svg.setAttribute('aria-label', `Personal price index, 12-month change by month from ${ymLabel(tr[0].ym)} to ${ymLabel(tr[n - 1].ym)}; latest ${pct(tr[n - 1].change)}.`);
    el('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'ins-diag' }, svg);
    // The line is one fixed blue, not the up/down red or green: it is a series
    // to read, and the title's arrowed figure already says which way it went.
    const pts = tr.map((p, i) => ({ x: x(i), y: y(chgOf(p)) }));
    el('path', { d: ChartMath.smoothPath(pts), class: 'ins-trend' }, svg);
    const end = pts[n - 1];
    el('circle', { cx: end.x, cy: end.y, r: 4, class: 'ins-trend-end' }, svg);

    const tip = tooltip(host);
    const guide = el('line', { y1: pad.t, y2: H - pad.b, class: 'ins-guide', visibility: 'hidden' }, svg);
    const ring = el('circle', { r: 5, class: 'ins-dot-hi', visibility: 'hidden' }, svg);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      const p = tr[i];
      guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
      ring.setAttribute('cx', x(i)); ring.setAttribute('cy', y(chgOf(p))); ring.setAttribute('visibility', 'visible');
      const w = [ymShift(p.ym, -2), p.ym];
      tip.show(`<strong>${pct(p.change)} vs a year earlier</strong><span>${rangeLabel(w)} vs ${rangeLabel(w.map((v) => ymShift(v, -12)))}</span>
        <span>${p.merchants} merchants</span>`, x(i), y(chgOf(p)));
    });
    svg.addEventListener('pointerleave', () => { tip.hide(); guide.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden'); });
  }

  function drawVisits(host, m) {
    host.querySelectorAll('.ant-empty').forEach((x) => x.remove());
    if (!host.clientWidth) return;
    // The chart spans the 15 months from the start of the year-ago window to
    // the end of the recent one; the two windows are shaded bands, and visits
    // between them are drawn faint (they are not in the comparison).
    const ymStart = (ym, add = 0) => { const [yy, mm] = ym.split('-').map(Number); return Date.UTC(yy, mm - 1 + add, 1); };
    const tA = ymStart(m.prior_window[0]);
    const tB = ymStart(m.recent_window[1], 1);
    const inW = (date, w) => date.slice(0, 7) >= w[0] && date.slice(0, 7) <= w[1];
    const pts = m.points
      .map(([date, amount]) => ({ date, amount, t: Date.parse(`${date}T00:00:00Z`),
        inWin: inW(date, m.prior_window) || inW(date, m.recent_window) }))
      .filter((p) => p.t >= tA && p.t < tB);
    const yMax = Math.max(...pts.map((p) => p.amount), m.early_avg, m.recent_avg);
    const yTicks = ChartMath.niceTicks(0, yMax * 1.08, 4);
    const top = yTicks[yTicks.length - 1];
    const H = CHART_H;
    const pad = { l: 56, r: 16, t: 22, b: 32 };
    const W = host.clientWidth;
    const x = (t) => pad.l + ((t - tA) / (tB - tA)) * (W - pad.l - pad.r);
    const y = (v) => H - pad.b - (v / top) * (H - pad.t - pad.b);

    const ymT = (t) => { const dt = new Date(t); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() }; };
    const qAt = new Map(quarterTicks(ymT(tA), ymT(tB), W - pad.l - pad.r)
      .map((q) => [Date.UTC(q.y, q.m, 1), q]));
    const { svg } = frame(host, {
      height: H, pad, x, y, yTicks, xTicks: [...qAt.keys()],
      yFmt: moneyRound,
      xFmt: (t) => quarterLabel(qAt.get(t)),
      xClass: (t) => (qAt.get(t).year ? 'ins-axis-year' : ''),
    });
    svg.setAttribute('aria-label', `${m.name}: average bill ${money(m.early_avg)} in ${rangeLabel(m.prior_window)}, ${money(m.recent_avg)} in ${rangeLabel(m.recent_window)}.`);

    // The two windows: a band each, named above the plot.
    const bands = el('g', {}, svg);
    for (const w of [m.prior_window, m.recent_window]) {
      const a = ymStart(w[0]);
      const b = ymStart(w[1], 1);
      el('rect', { x: x(a), y: pad.t, width: x(b) - x(a), height: H - pad.t - pad.b, class: 'ins-window' }, bands);
      el('text', { x: (x(a) + x(b)) / 2, y: pad.t - 6, 'text-anchor': 'middle', class: 'ins-axis' }, bands)
        .textContent = rangeLabel(w);
    }

    const dots = el('g', { class: 'ins-dots' }, svg);
    for (const p of pts) el('circle', { cx: x(p.t), cy: y(p.amount), r: 4, class: p.inWin ? '' : 'ins-dot-out' }, dots);

    // The two averages, each across its own window, labelled inside it.
    const tP0 = ymStart(m.prior_window[0]);
    const tP1 = ymStart(m.prior_window[1], 1);
    const tR0 = ymStart(m.recent_window[0]);
    const tR1 = ymStart(m.recent_window[1], 1);
    const dir = dirOf(m.change);
    const seg = (a, b, v, cls, label, anchorEnd) => {
      el('line', { x1: x(a), x2: x(b), y1: y(v), y2: y(v), class: `ins-avg ${cls}` }, svg);
      const tx = el('text', {
        x: anchorEnd ? x(b) : x(a) + 4, y: y(v) - 8,
        'text-anchor': anchorEnd ? 'end' : 'start', class: 'ins-avg-label',
      }, svg);
      tx.textContent = label;
    };
    seg(tP0, tP1, m.early_avg, 'ins-avg-early', `Avg ${money(m.early_avg)}`, false);
    seg(tR0, tR1, m.recent_avg, `ins-avg-recent ins-stroke-${dir}`, `Avg ${money(m.recent_avg)}`, true);

    // Hover: the nearest visit along x, within reach.
    const tip = tooltip(host);
    const hi = el('circle', { r: 6, class: 'ins-dot-hi', visibility: 'hidden' }, svg);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let best = null;
      let bd = Infinity;
      for (const p of pts) {
        const dd = Math.hypot(x(p.t) - px, (y(p.amount) - py) * 0.5);
        if (dd < bd) { bd = dd; best = p; }
      }
      if (!best || bd > 28) { tip.hide(); hi.setAttribute('visibility', 'hidden'); return; }
      hi.setAttribute('cx', x(best.t));
      hi.setAttribute('cy', y(best.amount));
      hi.setAttribute('visibility', 'visible');
      tip.show(`<strong>${money(best.amount)}</strong><span>${dateLabel(best.date)}</span>`, x(best.t), y(best.amount));
    });
    svg.addEventListener('pointerleave', () => { tip.hide(); hi.setAttribute('visibility', 'hidden'); });
  }

  // ─── Lifestyle Beta ────────────────────────────────────────────────────────

  async function loadBeta() {
    const res = await apiFetch('/api/insights/lifestyle-beta');
    if (!res.ok) return;
    state.beta = await res.json();
    renderBeta();
  }

  const CONFIDENCE = {
    clear: { tag: 'ant-tag-success', label: 'Clear signal', note: 'The pattern holds up across the months it was measured on.' },
    tentative: { tag: 'ant-tag-warning', label: 'Tentative', note: 'There is a pattern, but a few more months could move it.' },
    unclear: { tag: '', label: 'Unclear', note: 'Your spending does not follow your income closely yet, so read the number loosely. More months will sharpen it.' },
  };

  function betaSentence(b) {
    const per100 = Math.round(b * 100);
    if (b < -0.05) return `When your income rises, your spending tends to <strong>fall</strong>: about ${moneyRound(Math.abs(per100))} less for each extra ${moneyRound(100)}.`;
    if (b < 0.05) return `Your spending barely moves with your income. Almost all of a raise would be kept.`;
    if (b <= 1) return `Of each extra ${moneyRound(100)} a month you bring in, about <strong>${moneyRound(per100)}</strong> ends up spent and ${moneyRound(100 - per100)} is kept.`;
    return `Your spending rises <strong>faster</strong> than your income: about ${moneyRound(per100)} more for each extra ${moneyRound(100)}.`;
  }

  function renderBeta() {
    const b = state.beta;
    const stats = document.getElementById('beta-stats');
    const split = document.getElementById('beta-split');
    const years = document.getElementById('beta-years');
    if (!b || !stats) return;

    if (b.beta == null) {
      split.hidden = true;
      years.innerHTML = '';
      stats.innerHTML = Ant.empty({
        title: b.confidence === 'flat-income' ? 'Your income has not changed yet' : 'Not enough months yet',
        desc: b.confidence === 'flat-income'
          ? 'Beta measures how spending follows income, so it needs income that moves.'
          : `Lifestyle beta needs about ${b.smooth_months + 5} complete months of income and spending. You have ${b.months}.`,
      });
      return;
    }
    split.hidden = false;
    const c = CONFIDENCE[b.confidence] || CONFIDENCE.unclear;
    stats.innerHTML = `
      ${statHtml('Lifestyle beta', b.beta.toFixed(2), `± ${b.se.toFixed(2)}`)}
      <div class="ins-verdict">
        <p class="ins-sentence">${betaSentence(b.beta)}</p>
        <p class="ins-confidence"><span class="ant-tag ${c.tag}">${c.label}</span>
          <span>${c.note} R² ${b.r2.toFixed(2)} over ${b.points.length} rolling 3-month periods.</span></p>
      </div>`;
    drawScatter(document.getElementById('beta-chart'), b);
    renderBetaCats(b);
    renderBetaYears(b);
  }

  function drawScatter(host, b) {
    if (!host || !host.clientWidth) return;
    const pts = b.points;
    const all = pts.flatMap((p) => [p.income, p.spend]);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const ticks = ChartMath.niceTicks(Math.max(0, lo - (hi - lo) * 0.1), hi + (hi - lo) * 0.1, 4);
    const min = ticks[0];
    const max = ticks[ticks.length - 1];
    const W = host.clientWidth;
    const pad = { l: 64, r: 16, t: 16, b: 40 };
    // Square plot area: one dollar is the same length on both axes, so the
    // break-even diagonal really is at 45°.
    const side = Math.max(160, Math.min(W - pad.l - pad.r, 520));
    const H = side + pad.t + pad.b;
    const x = (v) => pad.l + ((v - min) / (max - min)) * side;
    const y = (v) => pad.t + side - ((v - min) / (max - min)) * side;

    const { svg } = frame(host, { height: H, pad: { ...pad, r: W - pad.l - side }, x, y, xTicks: ticks, yTicks: ticks, xFmt: moneyRound, yFmt: moneyRound, xLabelY: pad.t + side + 18 });
    svg.setAttribute('aria-label', `Scatter of ${pts.length} rolling 3-month periods, income against spending. Fitted beta ${b.beta}.`);
    el('text', { x: pad.l + side / 2, y: H - 4, 'text-anchor': 'middle', class: 'ins-axis-title' }, svg).textContent = 'Income per month →';
    const yt = el('text', { x: 14, y: pad.t + side / 2, 'text-anchor': 'middle', class: 'ins-axis-title', transform: `rotate(-90 14 ${pad.t + side / 2})` }, svg);
    yt.textContent = 'Spending per month →';

    // Break-even: on this line, a quarter spent exactly what came in.
    el('line', { x1: x(min), y1: y(min), x2: x(max), y2: y(max), class: 'ins-diag' }, svg);
    const dl = el('text', { x: x(max) - 4, y: y(max) + 14, 'text-anchor': 'end', class: 'ins-avg-label ins-muted' }, svg);
    dl.textContent = 'Spend = income';

    // The fitted line, across the income range actually observed.
    const iLo = Math.min(...pts.map((p) => p.income));
    const iHi = Math.max(...pts.map((p) => p.income));
    const fy = (i) => b.alpha + b.beta * i;
    el('line', { x1: x(iLo), y1: y(fy(iLo)), x2: x(iHi), y2: y(fy(iHi)), class: 'ins-fit' }, svg);
    const fl = el('text', { x: x(iHi) + 8, y: y(fy(iHi)) + 4, 'text-anchor': 'start', class: 'ins-avg-label' }, svg);
    fl.textContent = `β ${b.beta.toFixed(2)}`;

    // Older periods lighter, newer darker: one hue, so recency reads as order.
    const dots = el('g', { class: 'ins-bdots' }, svg);
    pts.forEach((p, i) => {
      const op = 0.3 + 0.7 * (pts.length > 1 ? i / (pts.length - 1) : 1);
      el('circle', { cx: x(p.income), cy: y(p.spend), r: 5, 'fill-opacity': op.toFixed(2) }, dots);
    });

    const tip = tooltip(host);
    const ring = el('circle', { r: 7, class: 'ins-dot-hi', visibility: 'hidden' }, svg);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let best = null;
      let bd = Infinity;
      for (const p of pts) {
        const dd = Math.hypot(x(p.income) - px, y(p.spend) - py);
        if (dd < bd) { bd = dd; best = p; }
      }
      if (!best || bd > 24) { tip.hide(); ring.setAttribute('visibility', 'hidden'); return; }
      ring.setAttribute('cx', x(best.income));
      ring.setAttribute('cy', y(best.spend));
      ring.setAttribute('visibility', 'visible');
      const kept = best.income - best.spend;
      tip.show(`<strong>3 months to ${ymLabel(best.ym)}</strong>
        <span>Income ${money(best.income)} / mo</span>
        <span>Spending ${money(best.spend)} / mo</span>
        <span>${kept >= 0 ? 'Kept' : 'Overspent'} ${money(Math.abs(kept))} / mo</span>`, x(best.income), y(best.spend));
    });
    svg.addEventListener('pointerleave', () => { tip.hide(); ring.setAttribute('visibility', 'hidden'); });
  }

  function renderBetaCats(b) {
    const host = document.getElementById('beta-cats');
    const cap = Math.max(0.05, ...b.categories.map((c) => Math.abs(c.beta)));
    const rows = b.categories.map((c) => {
      const per = c.beta * 100;
      const len = (Math.abs(c.beta) / cap) * 50;
      const sign = c.beta >= 0 ? 'pos' : 'neg';
      const label = per >= 0.5 ? `+${money(per)}` : per <= -0.5 ? `−${money(-per)}` : money(0);
      return `<div class="ins-crow">
        <span class="ins-cname">${escapeHtml(c.name)}</span>
        <span class="ins-dbar" aria-hidden="true"><span class="ins-dbar-fill ins-fill-${sign} ${c.beta >= 0 ? 'ins-dbar-right' : 'ins-dbar-left'}"
          style="${c.beta >= 0 ? 'left:50%' : `left:${50 - len}%`};width:${len}%"></span></span>
        <span class="ins-cval">${label}</span>
      </div>`;
    });
    const more = b.categories_total > b.categories.length
      ? `<p class="ins-note">${b.categories_total - b.categories.length} smaller categories not shown.</p>` : '';
    host.innerHTML = `<p class="ins-note">For each extra ${moneyRound(100)} of monthly income, how much more (or less) each category gets. These add up to the total beta.</p>
      ${rows.join('')}${more}`;
  }

  function renderBetaYears(b) {
    const host = document.getElementById('beta-years');
    if (!b.years.length) { host.innerHTML = ''; return; }
    const rows = b.years.map((yr) => {
      const kept = yr.income > 0 ? 1 - yr.spend / yr.income : null;
      return `<tr><td>${yr.year}${yr.months < 12 ? ` <span class="ins-muted">(${yr.months} mo)</span>` : ''}</td>
        <td>${money(yr.income)}</td><td>${money(yr.spend)}</td>
        <td>${kept == null ? '—' : pct(kept, 0).replace('+', '')}</td></tr>`;
    });
    // Year over year: the same question as beta, asked once of the two latest
    // years, in plain arithmetic a reader can check against the table.
    let delta = '';
    if (b.years.length >= 2) {
      const [a, z] = b.years.slice(-2);
      const di = z.income - a.income;
      const ds = z.spend - a.spend;
      const verb = (v) => (v >= 0 ? 'rose' : 'fell');
      delta = `<p class="ins-note">From ${a.year} to ${z.year}, your average monthly income ${verb(di)} ${money(Math.abs(di))}
        and your spending ${verb(ds)} ${money(Math.abs(ds))}.</p>`;
    }
    host.innerHTML = `<table class="ins-table">
      <thead><tr><th>Year</th><th>Income / mo</th><th>Spending / mo</th><th>Kept</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>${delta}`;
  }

  // ─── Wiring ────────────────────────────────────────────────────────────────

  function redraw() {
    renderInflation();
    renderBeta();
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('inflation-list')) return;
    const tableCard = document.querySelector('.ins-table-card');
    // Merchants ⇄ Categories. A switch goes back to the overall index, so the
    // chart never shows a row the table is not listing.
    document.getElementById('inflation-view').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn || btn.dataset.view === state.view) return;
      state.view = btn.dataset.view;
      state.selected = null;
      for (const b of e.currentTarget.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === btn));
      tableCard.setAttribute('aria-label', isCatView() ? 'Categories' : 'Merchants');
      if (!state.inflation) return;
      renderInflationList();
      renderMerchantDetail();
      document.getElementById('inflation-list').scrollTop = 0;
    });
    const openRow = (row) => {
      // Clicking the open merchant again closes it, back to the index.
      state.selected = state.selected === row.dataset.key ? null : row.dataset.key;
      renderInflationList();
      renderMerchantDetail();
      const again = document.querySelector(`.ins-tr[data-key="${CSS.escape(row.dataset.key)}"]`);
      if (again) again.focus({ preventScroll: true });
    };
    tableCard.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.ins-tr[data-key]');
      if (!row || e.target !== row) return;
      e.preventDefault();
      openRow(row);
    });
    tableCard.addEventListener('click', (e) => {
      const sorter = e.target.closest('[data-sort]');
      if (sorter) {
        state.sort = nextSort(sorter.dataset.sort);
        renderInflationList();
        document.getElementById('inflation-list').scrollTop = 0;
        return;
      }
      const row = e.target.closest('.ins-tr[data-key]');
      if (row) openRow(row);
    });
    // Hidden panels draw at zero width; redraw whenever a plot gets its size.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (state.inflation) renderMerchantDetail();
        if (state.beta && state.beta.beta != null) drawScatter(document.getElementById('beta-chart'), state.beta);
      });
    });
    ro.observe(document.getElementById('inflation-chart'));
    ro.observe(document.getElementById('beta-chart'));
    document.getElementById('inflation-detail-link').addEventListener('click', (e) => {
      if (!e.target.closest('[data-action="overall"]')) return;
      state.selected = null;
      renderInflationList();
      renderMerchantDetail();
    });
    window.addEventListener('currencychange', redraw);
    loadInflation();
    loadBeta();
  });
}());
