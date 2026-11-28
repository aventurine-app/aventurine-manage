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
// Every chart is Apache ECharts (widgets/echart-kit.js) in the theme's colours
// and this page's own (--ins-*, insights.css), so a theme flip recolours it.
// Hover reads every mark in a tooltip; the lists beside each chart are its
// table view.
//
// Globals: apiFetch (api.js), escapeHtml (escape.js), formatCurrency
// (currency.js), merchantAvatarHtml (avatar.js), ChartMath (chartmath.js),
// Ant (ant.js), EChartKit (echart-kit.js).

(function () {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // sort: { key: 'name' | 'visits' | 'change', order: 'ascend' | 'descend' },
  // or null for the backend's order (most spent first).
  // view: which list the table shows, 'merchants' or 'categories'. selected
  // is a row key from either list (category keys start 'c:', so they never
  // collide with a merchant's).
  const state = { inflation: null, beta: null, selected: null, sort: null, view: 'merchants' };
  // Both inflation charts share one height, so swapping between the index and
  // a merchant does not move the list under them.
  // 242 = the old 200 plus the 30px the figures row under the title took,
  // then 5% taller.
  const CHART_H = 242;

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

  // ─── Chart box ─────────────────────────────────────────────────────────────
  // Each plot is an Apache ECharts chart (widgets/echart-kit.js) in a canvas
  // box of its own inside the host, so the host can still hold an empty state
  // instead. The box's height is set here: CHART_H for the inflation charts,
  // square for the scatter.

  function canvasBox(host, height) {
    host.querySelectorAll('.ant-empty').forEach((x) => x.remove());
    let box = host.querySelector('.ins-canvas');
    if (!box) {
      box = document.createElement('div');
      box.className = 'ins-canvas';
      host.prepend(box);
    }
    box.style.height = `${height}px`;
    return box;
  }

  /** Clear a host's chart, for an empty state to take its place. */
  function clearChart(host) {
    const box = host.querySelector('.ins-canvas');
    if (box) { EChartKit.unmount(box); box.remove(); }
  }

  /** The page's own colours (--ins-*, insights.css), read off the host they
   *  are scoped to. */
  const insColor = (host, name) => EChartKit.color(`--ins-${name}`, host);

  /** A dashed reference line: the zero baseline, or break-even. */
  const refLine = (t) => ({ color: t.textTertiary, width: 1.5, type: [6, 5] });

  // ─── Axis ticks ────────────────────────────────────────────────────────────

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

  /** Rich text styles for the quarter labels: a year label is set apart. */
  const quarterRich = (t) => ({
    year: { color: t.text, fontWeight: 600, fontFamily: t.font, fontSize: 11 },
  });
  const quarterText = (q) => (q.year ? `{year|${quarterLabel(q)}}` : quarterLabel(q));

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
    const m = findItem(state.selected);
    const title = document.getElementById('inflation-detail-title');
    const link = document.getElementById('inflation-detail-link');
    const host = document.getElementById('inflation-chart');
    if (!host) return;
    if (!m) { renderOverall(); return; }

    const isCat = m.key.startsWith('c:');
    // The change sits in the title, as on the overall index; the chart keeps
    // the two windows' bills, so no caption row of figures under it.
    const dir = dirOf(m.change);
    title.innerHTML = `${isCat ? '' : merchantAvatarHtml(m.name)}<span>${escapeHtml(m.name)}</span>`
      + `<span class="ins-head-figure ins-${dir}">${arrow(m.change)} ${pct(m.change)}</span><span class="ins-head-since">over 12 months</span>`;
    const href = isCat ? `/transactions?cat=${encodeURIComponent(m.cat)}`
      : m.search ? `/transactions?name=${encodeURIComponent(m.search)}` : '';
    link.innerHTML = `${href
      ? `<a class="ant-btn ant-btn-link ant-btn-sm" href="${escapeHtml(href)}">See transactions</a>`
      : ''}<button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-action="overall">${Ant.icon('close')}<span>Back to overall</span></button>`;
    drawVisits(host, m);
  }

  // ─── The overall index (no merchant picked) ───────────────────────────────

  function renderOverall() {
    const d = state.inflation;
    const host = document.getElementById('inflation-chart');
    document.getElementById('inflation-detail-link').innerHTML = '';
    const tr = d.trend || [];
    if (tr.length < 2) {
      clearChart(host);
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
    drawTrend(host, tr);
  }

  function drawTrend(host, tr) {
    // Plotted as the 12-month change in percent, on a 0% (no change) baseline,
    // the way CPI charts are drawn.
    const chgOf = (p) => p.change * 100;
    const vals = tr.map(chgOf);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(0, ...vals);
    const spread = Math.max(4, hi - lo);
    const yTicks = ChartMath.niceTicks(lo - spread * 0.1, hi + spread * 0.1, 4);
    const n = tr.length;
    // Each point is a month, so a quarter tick sits on that month's index.
    const ymOf = (p) => { const [yy, mm] = p.ym.split('-').map(Number); return { y: yy, m: mm - 1 }; };
    const m0 = ymOf(tr[0]);
    const qs = quarterTicks(m0, ymOf(tr[n - 1]), Math.max(0, host.clientWidth - 64));
    const qAt = new Map(qs.map((q) => [(q.y - m0.y) * 12 + (q.m - m0.m), q]));
    const box = canvasBox(host, CHART_H);
    EChartKit.mount(box, (t) => {
      // The line is one fixed colour, not the up/down red or green: it is a
      // series to read, and the title's arrowed figure already says which way
      // it went.
      const color = insColor(host, 'index') || t.info;
      return {
        grid: { left: 0, right: 16, top: 16, bottom: 0, containLabel: true },
        tooltip: EChartKit.tooltip(t, {
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: t.border } },
          formatter: (params) => {
            const p = tr[params[0].dataIndex];
            const w = [ymShift(p.ym, -2), p.ym];
            return EChartKit.tipHtml({
              title: `${pct(p.change)} vs a year earlier`,
              rows: [
                { name: `${rangeLabel(w)} vs ${rangeLabel(w.map((v) => ymShift(v, -12)))}`, value: '' },
                { name: 'Merchants', value: String(p.merchants) },
              ],
            });
          },
        }),
        xAxis: EChartKit.categoryAxis(t, tr.map((p) => p.ym), {
          boundaryGap: false,
          axisLine: { show: false },
          axisLabel: EChartKit.axisLabel(t, {
            interval: (i) => qAt.has(i),
            formatter: (_v, i) => (qAt.has(i) ? quarterText(qAt.get(i)) : ''),
            rich: quarterRich(t),
          }),
        }),
        yAxis: EChartKit.valueAxis(t, yTicks,
          (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}%`),
        series: [{
          type: 'line',
          smooth: true,
          color,
          lineStyle: { width: 2.5 },
          symbol: 'none',
          data: vals.map((v, i) => (i === n - 1
            ? { value: v, symbol: 'circle', symbolSize: 8, itemStyle: { borderColor: t.bgContainer, borderWidth: 2 } }
            : v)),
          markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: refLine(t), data: [{ yAxis: 0 }] },
        }],
      };
    }, {
      label: `Personal price index, 12-month change by month from ${ymLabel(tr[0].ym)} to ${ymLabel(tr[n - 1].ym)}; latest ${pct(tr[n - 1].change)}.`,
    });
  }

  function drawVisits(host, m) {
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

    const ymT = (t) => { const dt = new Date(t); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() }; };
    const qAt = new Map(quarterTicks(ymT(tA), ymT(tB), Math.max(0, host.clientWidth - 72))
      .map((q) => [Date.UTC(q.y, q.m, 1), q]));
    const dir = dirOf(m.change);
    const box = canvasBox(host, CHART_H);
    EChartKit.mount(box, (t) => {
      const dot = t.textSecondary;
      const recent = insColor(host, dir) || t.text;
      // The two averages, each across its own window, labelled inside it.
      const avg = (w, v, color, end) => [
        { coord: [ymStart(w[0]), v], lineStyle: { color, width: 2.5, type: 'solid' },
          label: { show: true, position: end ? 'insideEndTop' : 'insideStartTop', formatter: `Avg ${money(v)}`,
            color: t.text, fontFamily: t.font, fontSize: 12, fontWeight: 600 } },
        { coord: [ymStart(w[1], 1), v] },
      ];
      return {
        // Room under the plot for the quarter labels: containLabel does not
        // count labels placed by customValues, so they would sit on the
        // canvas's bottom edge and be cut off.
        grid: { left: 0, right: 16, top: 24, bottom: 22, containLabel: true },
        tooltip: EChartKit.tooltip(t, {
          trigger: 'item',
          formatter: (p) => {
            const v = pts[p.dataIndex];
            return v ? EChartKit.tipHtml({ title: dateLabel(v.date), rows: [{ name: 'Bill', value: money(v.amount) }] }) : '';
          },
        }),
        // A plain value axis over UTC timestamps, not a time axis: the ticks
        // are the quarter starts chosen above (customValues), which a time
        // axis cannot take.
        xAxis: {
          type: 'value',
          min: tA,
          max: tB,
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: EChartKit.axisLabel(t, {
            customValues: [...qAt.keys()],
            formatter: (v) => (qAt.has(v) ? quarterText(qAt.get(v)) : ''),
            rich: quarterRich(t),
          }),
        },
        // Two value axes make ECharts draw the y axis's line and ticks too;
        // the grid alone carries the scale, as on every other chart.
        yAxis: EChartKit.valueAxis(t, yTicks, moneyRound, { axisLine: { show: false }, axisTick: { show: false } }),
        series: [{
          type: 'scatter',
          symbolSize: 8,
          data: pts.map((p) => ({
            value: [p.t, p.amount],
            itemStyle: { color: dot, opacity: p.inWin ? 0.7 : 0.25, borderColor: t.bgContainer, borderWidth: 1 },
          })),
          // The two windows: a band each, named above the plot.
          markArea: {
            silent: true,
            itemStyle: { color: t.fillTertiary },
            label: { position: 'top', color: t.textSecondary, fontFamily: t.font, fontSize: 11 },
            data: [m.prior_window, m.recent_window].map((w) => [
              { xAxis: ymStart(w[0]), name: rangeLabel(w) },
              { xAxis: ymStart(w[1], 1) },
            ]),
          },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              avg(m.prior_window, m.early_avg, t.text, false),
              avg(m.recent_window, m.recent_avg, recent, true),
            ],
          },
        }],
      };
    }, {
      label: `${m.name}: average bill ${money(m.early_avg)} in ${rangeLabel(m.prior_window)}, ${money(m.recent_avg)} in ${rangeLabel(m.recent_window)}.`,
    });
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
    const pad = { l: 72, r: 16, t: 16, b: 48 };
    // Square plot area: one dollar is the same length on both axes, so the
    // break-even diagonal really is at 45°.
    const side = Math.max(160, Math.min(host.clientWidth - pad.l - pad.r, 520));
    const box = canvasBox(host, side + pad.t + pad.b);
    // The fitted line, across the income range actually observed.
    const iLo = Math.min(...pts.map((p) => p.income));
    const iHi = Math.max(...pts.map((p) => p.income));
    const fy = (i) => b.alpha + b.beta * i;

    EChartKit.mount(box, (t) => {
      const color = insColor(host, 'pos') || t.primary;
      const axis = (name, rotate) => ({
        ...EChartKit.valueAxis(t, ticks, moneyRound),
        name,
        nameLocation: 'middle',
        nameGap: rotate ? 56 : 30,
        nameRotate: rotate ? 90 : 0,
        nameTextStyle: { color: t.textSecondary, fontFamily: t.font, fontSize: 12 },
      });
      return {
        grid: { left: pad.l, top: pad.t, width: side, height: side },
        tooltip: EChartKit.tooltip(t, {
          trigger: 'item',
          formatter: (p) => {
            const v = pts[p.dataIndex];
            if (!v || p.seriesIndex !== 0) return '';
            const kept = v.income - v.spend;
            return EChartKit.tipHtml({
              title: `3 months to ${ymLabel(v.ym)}`,
              rows: [
                { name: 'Income', value: `${money(v.income)} / mo` },
                { name: 'Spending', value: `${money(v.spend)} / mo` },
                { name: kept >= 0 ? 'Kept' : 'Overspent', value: `${money(Math.abs(kept))} / mo` },
              ],
            });
          },
        }),
        xAxis: axis('Income per month →', false),
        yAxis: axis('Spending per month →', true),
        series: [
          {
            // Older periods lighter, newer darker: one hue, so recency reads as order.
            type: 'scatter',
            symbolSize: 10,
            z: 3,
            data: pts.map((p, i) => ({
              value: [p.income, p.spend],
              itemStyle: {
                color,
                opacity: 0.3 + 0.7 * (pts.length > 1 ? i / (pts.length - 1) : 1),
                borderColor: t.bgContainer,
                borderWidth: 2,
              },
            })),
            // Break-even: on this line, a quarter spent exactly what came in.
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: refLine(t),
              label: { position: 'insideEndBottom', formatter: 'Spend = income', color: t.textTertiary, fontFamily: t.font, fontSize: 12 },
              data: [[{ coord: [min, min] }, { coord: [max, max] }]],
            },
          },
          {
            type: 'line',
            silent: true,
            symbol: 'none',
            color,
            lineStyle: { width: 2 },
            data: [[iLo, fy(iLo)], [iHi, fy(iHi)]],
            endLabel: {
              show: true,
              formatter: `β ${b.beta.toFixed(2)}`,
              color: t.text,
              fontFamily: t.font,
              fontSize: 12,
              fontWeight: 600,
            },
          },
        ],
      };
    }, {
      label: `Scatter of ${pts.length} rolling 3-month periods, income against spending. Fitted beta ${b.beta}.`,
    });
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
