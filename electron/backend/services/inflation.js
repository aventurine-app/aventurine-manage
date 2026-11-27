'use strict';

// Personal Inflation (Reports → Inflation) — pure maths, no DB handle.
//
// THE QUESTION: "is the bill at the places I keep going back to getting
// bigger?" Official CPI prices a national basket; this prices YOURS — the
// merchants you visit again and again — from nothing but your own ledger.
//
// WHAT IS MEASURED is the TICKET (what one visit cost), not a shelf price. A
// burrito that went from $9 to $11 shows up, and so does ordering a second
// one. The report says so in its tooltip rather than pretending to be a price
// index; for a regular habit the two move together closely enough to be the
// interesting number.
//
// THE RATE IS A 12-MONTH CHANGE, framed like the CPI figure in the news
// ("prices rose 2.9% over the year to October"): the average bill over the
// latest WINDOW_MONTHS calendar months against the same months a year earlier
// (Sep–Nov 2026 vs Sep–Nov 2025), so a reader can set the two side by side.
// Three months rather than CPI's one because a merchant is visited a few times
// a month at most; a single month is too few tickets to average. A merchant
// with no visit in either window has no rate and is left off the list. A fitted
// slope (least squares, Theil–Sen) was tried once and rejected: tickets cluster
// at a few price points — one burrito, two burritos — and the slope jumped
// between clusters.
//
// STEADY vs VARIED. A grocery run or an Amazon order is a different basket
// every time, so its ticket is not a like-for-like price and its trend is mostly
// noise. A merchant whose tickets spread widely (robust coefficient of
// variation — MAD/median — above VARIED_CV) is still listed, but flagged and
// left out of the headline rate, which is the spend-weighted average of the
// STEADY merchants only.

const MIN_VISITS = 6;        // fewer than this is not a habit, and not a trend
const WINDOW_MONTHS = 3;     // each side of the 12-month comparison
const MAX_MERCHANTS = 200;   // ranked by spend; the list scrolls, so this is only a guard
const VARIED_CV = 0.45;      // robust CV above which the basket is not like-for-like

function median(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sortNum = (a) => [...a].sort((x, y) => x - y);

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

const ymOf = (iso) => String(iso).slice(0, 7);
function ymAdd(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The two windows compared for the month `asOf` ('YYYY-MM'), each [from, to]. */
function windowsFor(asOf) {
  const from = ymAdd(asOf, 1 - WINDOW_MONTHS);
  return { recent: [from, asOf], prior: [ymAdd(from, -12), ymAdd(asOf, -12)] };
}
const inWin = (ym, w) => ym >= w[0] && ym <= w[1];

/** A merchant's visits, cleaned and date-sorted, with its spread; null under MIN_VISITS. */
function profile(visits) {
  const v = visits
    .filter((x) => Number(x.amount) > 0 && /^\d{4}-\d{2}-\d{2}/.test(String(x.date)))
    .map((x) => ({ date: String(x.date).slice(0, 10), amount: Number(x.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (v.length < MIN_VISITS) return null;
  const amounts = sortNum(v.map((x) => x.amount));
  const med = median(amounts);
  const mad = median(sortNum(amounts.map((a) => Math.abs(a - med))));
  const cv = med > 0 ? (1.4826 * mad) / med : Infinity;
  return { v, amounts, med, cv };
}

/**
 * One merchant's visits → its 12-month ticket change as of `asOf` ('YYYY-MM',
 * default: the month of its own latest visit), or null when it does not
 * qualify. `visits` is [{ date: 'YYYY-MM-DD', amount }] in any order.
 */
function merchantTrend(visits, asOf) {
  const p = profile(visits);
  if (!p) return null;
  const { v, amounts, med, cv } = p;
  const w = windowsFor(asOf || ymOf(v[v.length - 1].date));
  const prior = v.filter((x) => inWin(ymOf(x.date), w.prior)).map((x) => x.amount);
  const recent = v.filter((x) => inWin(ymOf(x.date), w.recent)).map((x) => x.amount);
  if (!prior.length || !recent.length) return null;
  const earlyAvg = mean(prior);
  const recentAvg = mean(recent);
  const change = recentAvg / earlyAvg - 1;

  return {
    visits: v.length,
    first_date: v[0].date,
    last_date: v[v.length - 1].date,
    total: round(amounts.reduce((s, a) => s + a, 0)),
    median: round(med),
    // The two windows: their months, visit counts and average bill.
    prior_window: w.prior,
    recent_window: w.recent,
    early_visits: prior.length,
    recent_visits: recent.length,
    early_avg: round(earlyAvg),
    recent_avg: round(recentAvg),
    // Already a 12-month figure, so the rate is the change itself.
    change: round(change, 4),
    rate: round(change, 4),
    cv: round(cv, 3),
    steady: cv <= VARIED_CV,
    points: v.map((x) => [x.date, round(x.amount)]),
  };
}

// ─── The trend line: the 12-month change, month by month ────────────────────
// For each month M, every steady merchant visited both in the WINDOW_MONTHS
// months to M and in the same months a year earlier contributes the ratio of
// its two average bills. The month's figure is the GEOMETRIC MEAN of those
// ratios with every merchant counted equally — a Jevons index, the form
// statistical agencies use for elementary price aggregates — minus one: the
// same "% vs a year ago" a CPI chart plots, so the two lines can be compared.
//
// EQUAL WEIGHTS, NOT SPEND WEIGHTS, deliberately unlike the headline rate. On
// a real ledger, spend weights made the line a rent index: rent was most of
// the steady spend, so every time a rent payment fell in or out of a window
// the whole line jumped. Counted equally, the line answers "are the places I
// go getting pricier"; the spend-weighted view stays in the headline figure.
// A month with fewer than TREND_MIN_MERCHANTS contributors is skipped: an
// index of one or two shops is those shops, not your cost of living.
const TREND_MIN_MERCHANTS = 3;

function buildTrend(profiles) {
  if (!profiles.length) return [];
  const books = profiles.map((p) => {
    const byYm = new Map();
    for (const x of p.v) {
      const e = byYm.get(ymOf(x.date)) || [0, 0];
      e[0] += x.amount;
      e[1] += 1;
      byYm.set(ymOf(x.date), e);
    }
    return byYm;
  });
  const avgOver = (byYm, w) => {
    let sum = 0;
    let cnt = 0;
    for (let ym = w[0]; ym <= w[1]; ym = ymAdd(ym, 1)) {
      const e = byYm.get(ym);
      if (e) { sum += e[0]; cnt += e[1]; }
    }
    return cnt ? sum / cnt : null;
  };
  const first = profiles.reduce((a, p) => (p.v[0].date < a ? p.v[0].date : a), '9999');
  const last = profiles.reduce((a, p) => (p.v[p.v.length - 1].date > a ? p.v[p.v.length - 1].date : a), '0000');
  const out = [];
  for (let ym = ymAdd(ymOf(first), 11 + WINDOW_MONTHS); ym <= ymOf(last); ym = ymAdd(ym, 1)) {
    const w = windowsFor(ym);
    let rSum = 0;
    let n = 0;
    for (const b of books) {
      const now = avgOver(b, w.recent);
      const then = now == null ? null : avgOver(b, w.prior);
      if (now == null || then == null) continue;
      rSum += Math.log(now / then);
      n += 1;
    }
    if (n < TREND_MIN_MERCHANTS) continue;
    out.push({ ym, change: round(Math.exp(rSum / n) - 1, 4), merchants: n });
  }
  return out;
}

/** The latest visit month across every group: the month the windows end on. */
function latestYm(groups) {
  let last = '';
  for (const g of groups) for (const x of g.visits) if (String(x.date) > last) last = String(x.date);
  return last ? ymOf(last) : null;
}

/**
 * Every qualifying merchant, ranked by spend, plus the headline: the
 * spend-weighted average rate across the STEADY ones.
 * `groups` is an iterable of { key, name, category, visits: [{date, amount}] }.
 * `asOf` ('YYYY-MM') is the last month of the recent window; by default the
 * latest month with a visit.
 */
function buildInflation(groupsIn, asOf) {
  const groups = [...groupsIn];
  const at = asOf || latestYm(groups);
  const merchants = [];
  const steadyProfiles = [];
  for (const g of groups) {
    const p = profile(g.visits);
    if (p && p.cv <= VARIED_CV) steadyProfiles.push(p);
    const t = p && merchantTrend(g.visits, at);
    if (t) merchants.push({ key: g.key, name: g.name, category: g.category || null, ...t });
  }
  merchants.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const listed = merchants.slice(0, MAX_MERCHANTS);

  // The headline reads every qualifying steady merchant, not only the listed
  // ones: the cap is about what fits on screen, not about what counts.
  const steady = merchants.filter((m) => m.steady);
  const weight = steady.reduce((s, m) => s + m.total, 0);
  const rate = weight > 0 ? steady.reduce((s, m) => s + m.rate * m.total, 0) / weight : null;
  const rising = steady.filter((m) => m.rate > 0.005).length;
  const falling = steady.filter((m) => m.rate < -0.005).length;

  return {
    rate: round(rate, 4),
    steady_count: steady.length,
    steady_spend: round(weight),
    rising,
    falling,
    qualifying: merchants.length,
    merchants: listed,
    // The trend reads every steady habit, not only today's qualifiers: a
    // place you stopped going to still counts in the months you went.
    trend: buildTrend(steadyProfiles),
    windows: at ? windowsFor(at) : null,
    rules: { min_visits: MIN_VISITS, window_months: WINDOW_MONTHS, varied_cv: VARIED_CV },
  };
}

/**
 * The same ticket change per CATEGORY, for the table's Categories view: every
 * expense in the category is a "visit", so the change reads as "has my average
 * Restaurants bill gone up". A category mixes places, so its ticket drifts with
 * where you went as well as with what they charged; categories are listed for
 * browsing only and never feed the headline rate or the index.
 * `groups` is an iterable of { key, name, visits: [{date, amount}] }; pass the
 * merchants' `asOf` so both views compare the same windows.
 */
function buildCategoryTrends(groupsIn, asOf) {
  const groups = [...groupsIn];
  const at = asOf || latestYm(groups);
  const out = [];
  for (const g of groups) {
    const t = merchantTrend(g.visits, at);
    if (t) out.push({ key: g.key, name: g.name, ...t });
  }
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

module.exports = { buildInflation, buildCategoryTrends, merchantTrend, windowsFor, MIN_VISITS, WINDOW_MONTHS, VARIED_CV };
