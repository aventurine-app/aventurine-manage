'use strict';

// Lifestyle Beta (Reports → Lifestyle Beta) — pure maths, no DB handle.
//
// In investing, a stock's beta is how far it moves when the market moves: the
// slope of its returns regressed on the market's. Here the "market" is your
// income and the "stock" is your spending: β is the slope of monthly spending
// regressed on monthly income. β = 0.6 reads "of each extra $100 a month that
// comes in, about $60 goes out". It is the number that puts a figure on
// lifestyle creep — the economist's marginal propensity to consume, measured on
// one household.
//
// SMOOTHED, NOT RAW. A month with three paychecks and a month with an annual
// insurance bill are timing, not behaviour, and on raw months they dominate the
// slope. Both series are first turned into trailing SMOOTH_MONTHS-month
// averages, so a point is "what the last quarter looked like".
//
// CATEGORY BETAS SUM TO THE TOTAL. Each category is regressed on the same
// smoothed income; OLS is linear in y, so the category slopes add up exactly to
// the overall one. That is what lets the card itemise β — "dining carries 0.21
// of your 0.48" — rather than show twelve unrelated numbers.
//
// CONFIDENCE IS STATED, NOT IMPLIED. Overlapping rolling averages make
// neighbouring points near-copies of each other, so the textbook standard
// error is too small by about √SMOOTH_MONTHS. The SE reported here is inflated
// by that factor before the confidence word is chosen, and the card shows the
// word, the R² and how many months it stands on.
//
// Transfers are neither income nor spending (the direction rule), so they are
// not in either series; the current, partial month is the caller's to drop.

const SMOOTH_MONTHS = 3;
const MIN_POINTS = 6;          // smoothed points needed before a slope means anything
const MAX_CATEGORIES = 12;

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/** Ordinary least squares of ys on xs. */
function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const sse = Math.max(0, syy - slope * sxy);
  const r2 = syy > 0 ? 1 - sse / syy : 0;
  const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, intercept, r2, se };
}

function trailing(values, w) {
  const out = [];
  for (let i = w - 1; i < values.length; i++) {
    let s = 0;
    for (let k = i - w + 1; k <= i; k++) s += values[k];
    out.push(s / w);
  }
  return out;
}

/**
 * `months` is [{ ym: 'YYYY-MM', income, spend, cats: { [key]: amount } }],
 * consecutive and complete (no partial month). `categories` maps key → name.
 */
function buildBeta(months, categories = new Map()) {
  const out = {
    smooth_months: SMOOTH_MONTHS,
    months: months.length,
    points: [],
    beta: null,
    alpha: null,
    r2: null,
    se: null,
    confidence: 'insufficient',
    categories: [],
    years: [],
  };

  // Per calendar year: average month in, average month out — the plain-language
  // companion to the slope. Only years with at least 3 complete months.
  const byYear = new Map();
  for (const m of months) {
    const y = m.ym.slice(0, 4);
    const e = byYear.get(y) || { year: y, n: 0, income: 0, spend: 0 };
    e.n += 1;
    e.income += m.income;
    e.spend += m.spend;
    byYear.set(y, e);
  }
  out.years = [...byYear.values()]
    .filter((e) => e.n >= 3)
    .map((e) => ({ year: e.year, months: e.n, income: round(e.income / e.n), spend: round(e.spend / e.n) }));

  const inc = trailing(months.map((m) => m.income), SMOOTH_MONTHS);
  const spd = trailing(months.map((m) => m.spend), SMOOTH_MONTHS);
  const yms = months.slice(SMOOTH_MONTHS - 1).map((m) => m.ym);
  out.points = yms.map((ym, i) => ({ ym, income: round(inc[i]), spend: round(spd[i]) }));
  if (inc.length < MIN_POINTS) return out;

  const fit = ols(inc, spd);
  if (!fit) {
    out.confidence = 'flat-income';
    return out;
  }
  const seAdj = fit.se * Math.sqrt(SMOOTH_MONTHS);
  const t = seAdj > 0 ? Math.abs(fit.slope) / seAdj : Infinity;
  out.beta = round(fit.slope, 3);
  out.alpha = round(fit.intercept);
  out.r2 = round(fit.r2, 3);
  out.se = round(seAdj, 3);
  out.confidence = t >= 2 ? 'clear' : t >= 1 ? 'tentative' : 'unclear';

  const keys = new Set();
  for (const m of months) for (const k of Object.keys(m.cats || {})) keys.add(k);
  const cats = [];
  for (const key of keys) {
    const ys = trailing(months.map((m) => (m.cats && m.cats[key]) || 0), SMOOTH_MONTHS);
    const f = ols(inc, ys);
    if (!f) continue;
    const avg = ys.reduce((s, v) => s + v, 0) / ys.length;
    cats.push({ key, name: categories.get(key) || key, beta: f.slope, avg });
  }
  // Ranked by how much of β they carry, either direction.
  cats.sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta) || a.name.localeCompare(b.name));
  out.categories = cats.slice(0, MAX_CATEGORIES).map((c) => ({
    key: c.key, name: c.name, beta: round(c.beta, 3), avg: round(c.avg),
  }));
  out.categories_total = cats.length;
  return out;
}

module.exports = { buildBeta, ols, trailing, SMOOTH_MONTHS, MIN_POINTS };
