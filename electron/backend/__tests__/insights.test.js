'use strict';

// Reports → Inflation and Reports → Lifestyle Beta: the pure maths
// (services/inflation.js, services/lifestyleBeta.js) and the two routes.

const test = require('node:test');
const assert = require('node:assert');

const { merchantTrend, buildInflation } = require('../services/inflation');
const { buildBeta, ols } = require('../services/lifestyleBeta');
const { makeClient } = require('./helpers');

/** `n` visits, one every `everyDays` days from 2024-01-01, priced by fn(i). */
function visits(n, everyDays, fn) {
  const t0 = Date.UTC(2024, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(t0 + i * everyDays * 86400000).toISOString().slice(0, 10),
    amount: fn(i),
  }));
}

test('inflation: the latest 3 months against the same 3 months a year earlier', () => {
  // 24 visits a month apart from Jan 2024 (last ~Nov 2025): $10 for the first
  // 12, $12 after. As of 2025-11 the windows are Sep–Nov 2025 vs Sep–Nov 2024.
  const t = merchantTrend(visits(24, 30, (i) => (i < 12 ? 10 : 12)));
  assert.deepEqual(t.recent_window, ['2025-09', '2025-11']);
  assert.deepEqual(t.prior_window, ['2024-09', '2024-11']);
  assert.equal(t.early_avg, 10);
  assert.equal(t.recent_avg, 12);
  assert.equal(t.change, 0.2);
  assert.equal(t.rate, 0.2);
  assert.equal(t.steady, true);
  assert.equal(t.points.length, 24);
});

test('inflation: an explicit as-of month moves both windows', () => {
  // As of 2025-06: Apr–Jun 2025 (all $12) vs Apr–Jun 2024 (all $10).
  const t = merchantTrend(visits(24, 30, (i) => (i < 12 ? 10 : 12)), '2025-06');
  assert.deepEqual(t.recent_window, ['2025-04', '2025-06']);
  assert.equal(t.change, 0.2);
});

test('inflation: too few visits, or none in a window, does not qualify', () => {
  assert.equal(merchantTrend(visits(5, 90, () => 10)), null);
  // ~190 days of history: nothing a year before the latest months.
  assert.equal(merchantTrend(visits(20, 10, () => 10)), null);
  // Plenty of history, but nothing in the last 3 months as of 2026-11.
  assert.equal(merchantTrend(visits(24, 30, () => 10), '2026-11'), null);
});

test('inflation: a widely varying basket is flagged and left out of the rate', () => {
  const steady = { key: 'a', name: 'Cafe', visits: visits(20, 30, (i) => (i < 10 ? 10 : 11)) };
  const varied = { key: 'b', name: 'Store', visits: visits(20, 30, (i) => [5, 80, 20, 150, 9][i % 5] * (i < 10 ? 1 : 3)) };
  const r = buildInflation([steady, varied]);
  assert.equal(r.qualifying, 2);
  assert.equal(r.steady_count, 1);
  assert.equal(r.merchants.find((m) => m.key === 'b').steady, false);
  // The headline is the steady merchant's rate alone.
  assert.equal(r.rate, r.merchants.find((m) => m.key === 'a').rate);
});

test('inflation: the trend is the 12-month change, month by month', () => {
  // Three steady merchants, every bill 10% higher from the second year on.
  const mk = (key, base) => ({ key, name: key, visits: visits(30, 30.4, (i) => base * (i < 12 ? 1 : 1.1)) });
  const r = buildInflation([mk('a', 10), mk('b', 40), mk('c', 100)]);
  assert.ok(r.trend.length > 6, String(r.trend.length));
  assert.equal(r.trend[0].merchants, 3);
  // Once both windows sit wholly in their own year, the change is +10%;
  // by the end both windows are in the higher-priced stretch, so 0%.
  assert.ok(r.trend.some((p) => Math.abs(p.change - 0.1) < 0.005), JSON.stringify(r.trend));
  assert.ok(Math.abs(r.trend[r.trend.length - 1].change) < 0.005, JSON.stringify(r.trend));
});

test('beta: OLS slope and the category slopes sum to the total', () => {
  assert.equal(ols([1, 2, 3], [2, 4, 6]).slope, 2);
  // Spending = 1000 + 0.5·income, split 0.3 food / 0.2 fun.
  const incomes = [4000, 5000, 4500, 6000, 5500, 4800, 5200, 6100, 4300, 5900, 5000, 4700];
  const months = incomes.map((inc, i) => ({
    ym: `2025-${String(i + 1).padStart(2, '0')}`,
    income: inc,
    spend: 1000 + 0.5 * inc,
    cats: { food: 1000 + 0.3 * inc, fun: 0.2 * inc },
  }));
  const r = buildBeta(months, new Map([['food', 'Food'], ['fun', 'Fun']]));
  assert.equal(r.beta, 0.5);
  assert.equal(r.r2, 1);
  assert.equal(r.confidence, 'clear');
  const sum = r.categories.reduce((s, c) => s + c.beta, 0);
  assert.ok(Math.abs(sum - r.beta) < 1e-6);
  assert.deepEqual(r.categories.map((c) => c.name), ['Food', 'Fun']);
  assert.equal(r.years[0].income, 5083.33);
});

test('beta: too few months returns no slope', () => {
  const months = [1, 2, 3, 4, 5].map((m) => ({ ym: `2025-0${m}`, income: 1000 * m, spend: 500 * m, cats: {} }));
  const r = buildBeta(months);
  assert.equal(r.beta, null);
  assert.equal(r.confidence, 'insufficient');
});

test('routes: both endpoints answer on an empty ledger', (t) => {
  const c = makeClient(t);
  const inf = c.get('/api/insights/inflation');
  assert.equal(inf.status, 200);
  assert.deepEqual(inf.body.merchants, []);
  assert.deepEqual(inf.body.categories, []);
  assert.equal(inf.body.rate, null);
  const beta = c.get('/api/insights/lifestyle-beta');
  assert.equal(beta.status, 200);
  assert.equal(beta.body.beta, null);
});

test('routes: inflation lists categories too, keyed apart from merchants', (t) => {
  const c = makeClient(t);
  const db = c.conn.db();
  const cat = db.prepare("SELECT id, \"key\", name FROM categories WHERE cat_type = 'expense' AND \"key\" NOT LIKE 'uncat%' LIMIT 1").get();
  const ins = db.prepare(
    "INSERT INTO transactions (date, description, category_id, amount, notes, tx_type) VALUES (?, ?, ?, ?, '', 'expense')"
  );
  // Two merchants in one category, plus uncategorized rows with no merchant.
  for (const v of visits(20, 30, (i) => (i < 10 ? 10 : 12))) ins.run(v.date, 'CAFE ONE', cat.id, v.amount);
  for (const v of visits(20, 30, (i) => (i < 10 ? 20 : 22))) ins.run(v.date, 'CAFE TWO', cat.id, v.amount);
  for (const v of visits(8, 60, () => 5)) ins.run(v.date, '', null, v.amount);
  const r = c.get('/api/insights/inflation').body;
  assert.equal(r.merchants.length, 2);
  const row = r.categories.find((x) => x.key === `c:${cat.key}`);
  assert.ok(row, JSON.stringify(r.categories.map((x) => x.key)));
  assert.equal(row.name, cat.name);
  assert.equal(row.cat, cat.key);
  assert.equal(row.visits, 40);
  assert.equal(row.early_avg, 15);
  assert.equal(row.recent_avg, 17);
  // The uncategorized rows stop in Feb 2025, before the latest window
  // (May–Jul 2025), so they have no 12-month change to list.
  assert.equal(r.categories.find((x) => x.key === 'c:__uncategorized__'), undefined);
});
