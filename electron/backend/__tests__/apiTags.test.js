'use strict';

// Transaction tags: the vocabulary routes (/api/tags), a transaction's one
// tag_id, the export filter, and the statement cells split by tag that the
// Cash Flow Sankey draws (/api/data/tags).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeClient } = require('./helpers');

// ── Shared helpers ───────────────────────────────────────────────────────────

function makeTag(c, name) {
  const r = c.post('/api/tags', { name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.tag;
}

function createTx(c, desc, { catId = null, amount = 10, txType = 'expense', d = '2026-06-01', tagId } = {}) {
  const payload = { date: d, description: desc, tx_type: txType, amount };
  if (catId !== null) payload.category_id = catId;
  if (tagId !== undefined) payload.tag_id = tagId;
  const r = c.post('/api/transactions', payload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.transaction;
}

const catByKey = (c, key) => c.get('/api/transactions').body.categories.find((x) => x.key === key);
const tagNames = (c) => c.get('/api/tags').body.tags.map((t) => t.name);

// ── The vocabulary ───────────────────────────────────────────────────────────

test('create: names are trimmed, collapsed and unique ignoring case', (t) => {
  const c = makeClient(t);
  const tag = makeTag(c, '  Japan   trip ');
  assert.equal(tag.name, 'Japan trip');

  assert.equal(c.post('/api/tags', { name: 'JAPAN TRIP' }).status, 409);
  assert.equal(c.post('/api/tags', { name: '   ' }).status, 400);
  assert.equal(c.post('/api/tags', { name: 'x'.repeat(31) }).status, 400);
  assert.equal(c.post('/api/tags', { name: 42 }).status, 400);
  assert.deepEqual(tagNames(c), ['Japan trip']);
});

test('list: alphabetical ignoring case, with each tag\'s transaction count', (t) => {
  const c = makeClient(t);
  const b = makeTag(c, 'beach');
  makeTag(c, 'Alps');
  createTx(c, 'Hotel', { tagId: b.id });
  createTx(c, 'Ice cream', { tagId: b.id });

  const { tags } = c.get('/api/tags').body;
  assert.deepEqual(tags.map((x) => [x.name, x.transactions]), [['Alps', 0], ['beach', 2]]);
  // The ledger's own payload carries the vocabulary too, so the page loads in one read.
  assert.deepEqual(c.get('/api/transactions').body.tags.map((x) => x.name), ['Alps', 'beach']);
});

test('rename: a change of case is allowed, another tag\'s name is a 409', (t) => {
  const c = makeClient(t);
  const trip = makeTag(c, 'trip');
  makeTag(c, 'Work');

  const r = c.put(`/api/tags/${trip.id}`, { name: 'Trip' });
  assert.equal(r.status, 200);
  assert.equal(r.body.tag.name, 'Trip');
  assert.equal(c.put(`/api/tags/${trip.id}`, { name: 'work' }).status, 409);
  assert.equal(c.put('/api/tags/999', { name: 'Nope' }).status, 404);
});

test('merge: moves every row to the other tag, then deletes the first', (t) => {
  const c = makeClient(t);
  const holiday = makeTag(c, 'Holiday');
  const vacation = makeTag(c, 'Vacation');
  const a = createTx(c, 'Flight', { tagId: holiday.id });
  const b = createTx(c, 'Hotel', { tagId: vacation.id });

  const r = c.post(`/api/tags/${holiday.id}/merge`, { into: vacation.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moved, 1);
  const rows = c.get('/api/transactions').body.transactions;
  assert.deepEqual(rows.filter((x) => [a.id, b.id].includes(x.id)).map((x) => x.tag_id), [vacation.id, vacation.id]);
  assert.deepEqual(tagNames(c), ['Vacation']);

  assert.equal(c.post(`/api/tags/${vacation.id}/merge`, { into: vacation.id }).status, 400);
  assert.equal(c.post(`/api/tags/${vacation.id}/merge`, { into: 999 }).status, 404);
  assert.equal(c.post(`/api/tags/${vacation.id}/merge`, { into: 'x' }).status, 400);
});

test('delete: untags its rows and leaves the rows in place', (t) => {
  const c = makeClient(t);
  const tag = makeTag(c, 'Reimbursable');
  const tx = createTx(c, 'Taxi', { tagId: tag.id });

  const r = c.del(`/api/tags/${tag.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, 1);
  const row = c.get('/api/transactions').body.transactions.find((x) => x.id === tx.id);
  assert.equal(row.tag_id, null);
  assert.deepEqual(tagNames(c), []);
  assert.equal(c.del(`/api/tags/${tag.id}`).status, 404);
});

// ── A transaction's tag ──────────────────────────────────────────────────────

test('a transaction takes one tag: set on create, changed, cleared, validated', (t) => {
  const c = makeClient(t);
  const trip = makeTag(c, 'Trip');
  const work = makeTag(c, 'Work');

  const tx = createTx(c, 'Dinner', { tagId: trip.id });
  assert.equal(tx.tag_id, trip.id);
  assert.equal(createTx(c, 'Lunch').tag_id, null);

  let r = c.put(`/api/transactions/${tx.id}`, { tag_id: work.id });
  assert.equal(r.body.transaction.tag_id, work.id);
  // A payload without tag_id leaves the tag alone.
  r = c.put(`/api/transactions/${tx.id}`, { notes: 'with the team' });
  assert.equal(r.body.transaction.tag_id, work.id);
  r = c.put(`/api/transactions/${tx.id}`, { tag_id: null });
  assert.equal(r.body.transaction.tag_id, null);

  assert.equal(c.put(`/api/transactions/${tx.id}`, { tag_id: 999 }).status, 400);
  assert.equal(c.put(`/api/transactions/${tx.id}`, { tag_id: '1' }).status, 400);
});

test('bulk-update tags several rows in one request', (t) => {
  const c = makeClient(t);
  const trip = makeTag(c, 'Trip');
  const a = createTx(c, 'Flight');
  const b = createTx(c, 'Hotel');

  const r = c.post('/api/transactions/bulk-update', {
    updates: [{ id: a.id, tag_id: trip.id }, { id: b.id, tag_id: trip.id }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.transactions.map((x) => x.tag_id), [trip.id, trip.id]);
});

// ── Export ───────────────────────────────────────────────────────────────────

test('export filters by tag (a null is "no tag") and writes a Tag column', (t) => {
  const c = makeClient(t);
  const trip = makeTag(c, 'Trip');
  createTx(c, 'Flight', { tagId: trip.id, d: '2026-01-02' });
  createTx(c, 'Groceries', { d: '2026-01-03' });

  const exportLines = (name, filters) => {
    const dest = path.join(c.dir, name);
    const r = c.post('/api/transactions/export', { path: dest, format: 'csv', offset: 0, filters });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return fs.readFileSync(dest, 'utf8').split('\r\n').filter(Boolean);
  };

  let lines = exportLines('trip.csv', { tag_id: trip.id });
  assert.equal(lines[0], 'Date,Description,Type,Category,Amount,Notes,Tag');
  assert.deepEqual(lines.slice(1), ['2026-01-02,Flight,expense,,-10.00,,Trip']);

  lines = exportLines('untagged.csv', { tag_id: null });
  assert.deepEqual(lines.slice(1), ['2026-01-03,Groceries,expense,,-10.00,,']);

  lines = exportLines('either.csv', { tag_id: [trip.id, null] });
  assert.equal(lines.length, 3);

  const r = c.post('/api/transactions/export', {
    path: path.join(c.dir, 'bad.csv'), format: 'csv', offset: 0, filters: { tag_id: 'Trip' },
  });
  assert.equal(r.status, 400);
});

// ── The statement split by tag (/api/data/tags) ──────────────────────────────

test('data/tags splits each computed cell by tag, skipping overridden cells', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/year', { year: 2026 }).status, 200);
  const food = catByKey(c, 'food');
  const income = c.get('/api/transactions').body.categories.find((x) => x.cat_type === 'income' && !x.locked);
  const trip = makeTag(c, 'Trip');
  const work = makeTag(c, 'Work');

  createTx(c, 'Ramen', { catId: food.id, amount: 20, d: '2026-03-04', tagId: trip.id });
  createTx(c, 'Sushi', { catId: food.id, amount: 30.5, d: '2026-03-09', tagId: trip.id });
  createTx(c, 'Groceries', { catId: food.id, amount: 100, d: '2026-03-10' });
  createTx(c, 'Team lunch', { catId: food.id, amount: 15, d: '2026-04-01', tagId: work.id });
  createTx(c, 'Bonus', { catId: income.id, txType: 'income', amount: 500, d: '2026-03-15', tagId: work.id });
  // Uncategorized rows split under the bucket the statement sums them into.
  createTx(c, 'Souvenir', { amount: 5, d: '2026-03-20', tagId: trip.id });
  // A year without a year-table is not on the statement, so not here either.
  createTx(c, 'Old trip', { catId: food.id, amount: 99, d: '2024-03-04', tagId: trip.id });

  let { tags, cells } = c.get('/api/data/tags').body;
  assert.deepEqual(tags.map((x) => x.name), ['Trip', 'Work']);
  assert.deepEqual(Object.keys(cells), ['2026']);
  assert.deepEqual(cells['2026'].March[food.key], { [trip.id]: 50.5 });
  assert.deepEqual(cells['2026'].March[income.key], { [work.id]: 500 });
  assert.deepEqual(cells['2026'].March.uncat_expense, { [trip.id]: 5 });
  assert.deepEqual(cells['2026'].April[food.key], { [work.id]: 15 });

  // A hand-typed figure no transaction backs carries no tags.
  assert.equal(c.post('/api/entry', { year: 2026, month: 'March', category: food.key, value: 40 }).status, 200);
  ({ cells } = c.get('/api/data/tags').body);
  assert.equal(cells['2026'].March[food.key], undefined);
  assert.deepEqual(cells['2026'].April[food.key], { [work.id]: 15 });
});
