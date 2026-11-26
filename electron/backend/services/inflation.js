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
// THE RATE IS AVERAGE-THEN vs AVERAGE-NOW. The span from first to last visit
// is cut at its midpoint DATE; the average bill on each side is compared, and
// the change is annualised over the time between the two halves' average
// dates. That is exactly the question a person asks ("has my Chipotle bill
// averaged up?") and it can be checked by hand from the ledger. A fitted slope
// (least squares, Theil–Sen) was tried first and rejected: tickets cluster at a
// few price points — one burrito, two burritos — and the slope jumped between
// clusters, disagreeing in sign with the two averages it was meant to explain.
//
// STEADY vs VARIED. A grocery run or an Amazon order is a different basket
// every time, so its ticket is not a like-for-like price and its trend is mostly
// noise. A merchant whose tickets spread widely (robust coefficient of
// variation — MAD/median — above VARIED_CV) is still listed, but flagged and
// left out of the headline rate, which is the spend-weighted average of the
// STEADY merchants only.

const MIN_VISITS = 6;        // fewer than this is not a habit, and not a trend
const MIN_SPAN_DAYS = 300;   // shorter, and annualising a small gap magnifies noise
const MAX_MERCHANTS = 200;   // ranked by spend; the list scrolls, so this is only a guard
const VARIED_CV = 0.45;      // robust CV above which the basket is not like-for-like

const DAY_MS = 86400000;
const YEAR_DAYS = 365.25;

function median(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sortNum = (a) => [...a].sort((x, y) => x - y);

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const dayOf = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * One merchant's visits → its ticket trend, or null when it does not qualify.
 * `visits` is [{ date: 'YYYY-MM-DD', amount }] in any order.
 */
function merchantTrend(visits) {
  const v = visits
    .filter((x) => Number(x.amount) > 0 && Number.isFinite(dayOf(x.date)))
    .map((x) => ({ date: String(x.date).slice(0, 10), amount: Number(x.amount), d: dayOf(x.date) }))
    .sort((a, b) => a.d - b.d);
  if (v.length < MIN_VISITS) return null;
  const d0 = v[0].d;
  const span = (v[v.length - 1].d - d0) / DAY_MS;
  if (span < MIN_SPAN_DAYS) return null;

  // Early vs recent: the visits either side of the span's midpoint DATE, not the
  // midpoint visit, so "early" and "recent" are periods a reader can picture.
  const midD = d0 + (span * DAY_MS) / 2;
  const earlyV = v.filter((x) => x.d < midD);
  const recentV = v.filter((x) => x.d >= midD);
  if (earlyV.length < 2 || recentV.length < 2) return null;
  const early = earlyV.map((x) => x.amount);
  const recent = recentV.map((x) => x.amount);
  const earlyAvg = mean(early);
  const recentAvg = mean(recent);
  const gapYears = (mean(recentV.map((x) => x.d)) - mean(earlyV.map((x) => x.d))) / DAY_MS / YEAR_DAYS;
  const change = recentAvg / earlyAvg - 1;
  const rate = gapYears > 0 ? (recentAvg / earlyAvg) ** (1 / gapYears) - 1 : 0;

  const amounts = sortNum(v.map((x) => x.amount));
  const med = median(amounts);
  const mad = median(sortNum(amounts.map((a) => Math.abs(a - med))));
  const cv = med > 0 ? (1.4826 * mad) / med : Infinity;

  return {
    visits: v.length,
    first_date: v[0].date,
    last_date: v[v.length - 1].date,
    span_days: Math.round(span),
    total: round(amounts.reduce((s, a) => s + a, 0)),
    median: round(med),
    // The two halves: their visit counts, average bill, and where they split.
    split_date: new Date(midD).toISOString().slice(0, 10),
    early_visits: early.length,
    recent_visits: recent.length,
    early_avg: round(earlyAvg),
    recent_avg: round(recentAvg),
    change: round(change, 4),
    gap_years: round(gapYears, 2),
    rate: round(rate, 4),
    cv: round(cv, 3),
    steady: cv <= VARIED_CV,
    points: v.map((x) => [x.date, round(x.amount)]),
  };
}

// ─── The trend line: a monthly personal price index ─────────────────────────
// For each month, every steady merchant visited in the trailing TREND_MONTHS
// months contributes its average bill over that window RELATIVE TO ITS OWN
// usual bill (its mean over all its visits), so a $1,900 rent and a $15
// burrito both start near 1.0. The month's figure is the GEOMETRIC MEAN of
// those ratios with every merchant counted equally — a Jevons index, the form
// statistical agencies use for elementary price aggregates — and the series is
// rebased so its first month is 100.
//
// EQUAL WEIGHTS, NOT SPEND WEIGHTS, deliberately unlike the headline rate. On
// a real ledger, spend weights made the line a rent index: rent was most of
// the steady spend, so every month a rent payment fell in or out of the
// trailing window the whole line jumped 20–30 points. Counted equally, the
// line answers "are the places I go getting pricier", which is what a trend of
// bills is read for; the spend-weighted view stays in the headline figure. A month with fewer than
// TREND_MIN_MERCHANTS contributors is skipped: an index of one or two shops is
// those shops, not your cost of living.
const TREND_MONTHS = 3;
const TREND_MIN_MERCHANTS = 3;

const ymOf = (iso) => iso.slice(0, 7);
function ymAdd(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildTrend(steady) {
  if (!steady.length) return [];
  const books = steady.map((m) => {
    const byYm = new Map();
    for (const [date, amount] of m.points) {
      const e = byYm.get(ymOf(date)) || [0, 0];
      e[0] += amount;
      e[1] += 1;
      byYm.set(ymOf(date), e);
    }
    return { usual: m.total / m.visits, byYm };
  });
  const first = steady.reduce((a, m) => (m.first_date < a ? m.first_date : a), '9999');
  const last = steady.reduce((a, m) => (m.last_date > a ? m.last_date : a), '0000');
  const out = [];
  let base = null;
  for (let ym = ymAdd(ymOf(first), TREND_MONTHS - 1); ym <= ymOf(last); ym = ymAdd(ym, 1)) {
    let rSum = 0;
    let n = 0;
    for (const b of books) {
      let sum = 0;
      let cnt = 0;
      for (let k = 0; k < TREND_MONTHS; k++) {
        const e = b.byYm.get(ymAdd(ym, -k));
        if (e) { sum += e[0]; cnt += e[1]; }
      }
      if (!cnt) continue;
      rSum += Math.log(sum / cnt / b.usual);
      n += 1;
    }
    if (n < TREND_MIN_MERCHANTS) continue;
    const r = Math.exp(rSum / n);
    if (base == null) base = r;
    out.push({ ym, index: round((100 * r) / base, 1), merchants: n });
  }
  return out;
}

/**
 * Every qualifying merchant, ranked by spend, plus the headline: the
 * spend-weighted average rate across the STEADY ones.
 * `groups` is an iterable of { key, name, category, visits: [{date, amount}] }.
 */
function buildInflation(groups) {
  const merchants = [];
  for (const g of groups) {
    const t = merchantTrend(g.visits);
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
    trend: buildTrend(steady),
    rules: { min_visits: MIN_VISITS, min_span_days: MIN_SPAN_DAYS, varied_cv: VARIED_CV },
  };
}

/**
 * The same ticket trend per CATEGORY, for the table's Categories view: every
 * expense in the category is a "visit", so the change reads as "has my average
 * Restaurants bill gone up". A category mixes places, so its ticket drifts with
 * where you went as well as with what they charged; categories are listed for
 * browsing only and never feed the headline rate or the index.
 * `groups` is an iterable of { key, name, visits: [{date, amount}] }.
 */
function buildCategoryTrends(groups) {
  const out = [];
  for (const g of groups) {
    const t = merchantTrend(g.visits);
    if (t) out.push({ key: g.key, name: g.name, ...t });
  }
  return out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

module.exports = { buildInflation, buildCategoryTrends, merchantTrend, MIN_VISITS, MIN_SPAN_DAYS, VARIED_CV };
