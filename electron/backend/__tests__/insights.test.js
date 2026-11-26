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

test('inflation: early vs recent average, annualised over the gap', () => {
  // 24 visits a month apart: the first 12 at $10, the last 12 at $12.
  const t = merchantTrend(visits(24, 30, (i) => (i < 12 ? 10 : 12)));
  assert.equal(t.early_avg, 10);
  assert.equal(t.recent_avg, 12);
  assert.equal(t.change, 0.2);
  // The halves' average dates sit ~360 days apart, so the annual rate is a
  // touch over the 20% total change.
  assert.ok(t.rate > 0.19 && t.rate < 0.22, String(t.rate));
  assert.equal(t.steady, true);
  assert.equal(t.points.length, 24);
});

test('inflation: too few visits or too short a span does not qualify', () => {
  assert.equal(merchantTrend(visits(5, 90, () => 10)), null);
  assert.equal(merchantTrend(visits(20, 10, () => 10)), null); // ~190 days
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

test('inflation: the index starts at 100 and follows like-for-like bills', () => {
  // Three steady merchants, every bill 10% higher in the second year.
  const mk = (key, base) => ({ key, name: key, visits: visits(24, 30.4, (i) => base * (i < 12 ? 1 : 1.1)) });
  const r = buildInflation([mk('a', 10), mk('b', 40), mk('c', 100)]);
  assert.ok(r.trend.length > 12);
  assert.equal(r.trend[0].index, 100);
  assert.equal(r.trend[0].merchants, 3);
  const last = r.trend[r.trend.length - 1].index;
  assert.ok(Math.abs(last - 110) < 0.5, String(last));
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
  const un = r.categories.find((x) => x.key === 'c:__uncategorized__');
  assert.equal(un.name, 'Uncategorized');
  assert.equal(un.cat, 'none');
  assert.equal(un.visits, 8);
});
