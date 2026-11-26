'use strict';

// Reports → Inflation and Reports → Lifestyle Beta. Read-only.
//
// Both read the WHOLE ledger: a trend in what a merchant charges, or in how
// spending follows income, gets more trustworthy with every month behind it,
// and a window picker would mostly be a way to make the number worse.
//
// WHAT COUNTS AS SPENDING / INCOME is the direction rule every report here
// uses (handlers/trends.js, handlers/topMerchants.js): a categorized row takes
// its direction from its category, an uncategorized row from its own tx_type.
// Transfers are neither.
//
// MERCHANT GROUPING is services/merchantKey.js, the same rule Top Merchants
// ranks by, so "Chipotle" here is the same set of rows as the Chipotle bar on
// the Spending tab. The maths lives in services/inflation.js and
// services/lifestyleBeta.js.

const { merchantKey, resolvedName } = require('../services/merchantKey');
const { commonSearchTerm } = require('../services/merchantSearch');
const { addMonthKey } = require('../services/forecast');
const { buildInflation, buildCategoryTrends } = require('../services/inflation');
const { buildBeta } = require('../services/lifestyleBeta');

const UNCAT_KEY = '__uncategorized__';
const DIRECTION = `(CASE WHEN t.category_id IS NULL THEN t.tx_type ELSE c.cat_type END)`;

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function inflationGet(ctx) {
  const db = ctx.db();
  const rows = db
    .prepare(
      `SELECT t.description AS description, t.display_name AS display_name,
              t.amount AS amount, t.date AS date, c."key" AS cat_key, c.name AS cat_name
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${DIRECTION} = 'expense'
        ORDER BY t.date`
    )
    .all();

  const groups = new Map();
  // The Categories view: every expense row, merchant or not, under its
  // category ('c:' + key, so its keys never collide with a merchant's n:/d:).
  const catGroups = new Map();
  for (const r of rows) {
    const ck0 = r.cat_key || UNCAT_KEY;
    let cg = catGroups.get(ck0);
    if (!cg) {
      cg = { key: `c:${ck0}`, cat: r.cat_key ? ck0 : 'none', name: r.cat_key ? r.cat_name : 'Uncategorized', visits: [] };
      catGroups.set(ck0, cg);
    }
    cg.visits.push({ date: r.date, amount: Number(r.amount) || 0 });

    const key = merchantKey(r);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, named: key.startsWith('n:'), name: '', visits: [], cats: new Map(), descs: [] };
      groups.set(key, g);
    }
    const amount = Number(r.amount) || 0;
    g.visits.push({ date: r.date, amount });
    const ck = r.cat_key || UNCAT_KEY;
    g.cats.set(ck, (g.cats.get(ck) || 0) + amount);
    g.descs.push(r.description);
    // Date-ordered rows: the newest label wins, as on Top Merchants.
    g.name = resolvedName(r) || String(r.description || '').trim();
  }
  for (const g of groups.values()) {
    g.category = [...g.cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  }

  const result = buildInflation(groups.values());
  // Ledger search terms for the listed merchants only (the walk is quadratic).
  for (const m of result.merchants) {
    const g = groups.get(m.key);
    m.search = g.named ? g.name : commonSearchTerm(g.descs);
    // An unnamed merchant's newest raw description carries card masks and
    // dates ("VISA NINJA RAMEN … ON 01-16 4159"); the term common to all its
    // rows is the merchant itself, so it doubles as the label.
    if (!g.named && m.search) m.name = m.search;
  }
  // Ledger filter for each category: its key, or 'none' for Uncategorized
  // (the value Transactions' ?cat= takes).
  const cats = buildCategoryTrends(catGroups.values());
  for (const c of cats) c.cat = catGroups.get(c.key.slice(2)).cat;
  return { ok: true, ...result, categories: cats };
}

function lifestyleBetaGet(ctx) {
  const db = ctx.db();
  const thisMonth = currentMonthKey();
  const rows = db
    .prepare(
      `SELECT substr(t.date, 1, 7) AS ym, ${DIRECTION} AS dir,
              COALESCE(c."key", '${UNCAT_KEY}') AS cat_key, SUM(t.amount) AS total
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE substr(t.date, 1, 7) < ?
          AND ${DIRECTION} IN ('income', 'expense')
        GROUP BY 1, 2, 3
        ORDER BY 1`
    )
    .all(thisMonth);

  const names = new Map(db.prepare(`SELECT "key", name FROM categories`).all().map((c) => [c.key, c.name]));
  names.set(UNCAT_KEY, 'Uncategorized');

  const months = [];
  if (rows.length) {
    // Every month from the first in the ledger to the last complete one, gaps
    // filled with zero: a month with no income is data, not a missing row.
    const byYm = new Map();
    for (let ym = rows[0].ym; ym < thisMonth; ym = addMonthKey(ym, 1)) {
      const m = { ym, income: 0, spend: 0, cats: {} };
      byYm.set(ym, m);
      months.push(m);
    }
    for (const r of rows) {
      const m = byYm.get(r.ym);
      if (!m) continue;
      const v = Number(r.total) || 0;
      if (r.dir === 'income') m.income += v;
      else {
        m.spend += v;
        m.cats[r.cat_key] = (m.cats[r.cat_key] || 0) + v;
      }
    }
  }
  return { ok: true, ...buildBeta(months, names) };
}

const routes = [
  ['GET', '/api/insights/inflation', inflationGet],
  ['GET', '/api/insights/lifestyle-beta', lifestyleBetaGet],
];

module.exports = { routes };
