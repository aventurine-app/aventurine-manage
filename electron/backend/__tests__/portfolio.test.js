'use strict';

// Portfolio — accounts, each holding asset entries priced by hand. Covers the
// entry contract the page relies on: a create may carry the asset's details or
// none of them, and a create and an edit accept exactly the same values.

const test = require('node:test');
const assert = require('node:assert');

const { makeClient } = require('./helpers');

/** The seeded account ("My Portfolio") every fresh database starts with. */
function firstAccount(c) {
  return c.get('/api/portfolio/data').body.accounts[0];
}

const entryCount = (c) => c.conn.db().prepare('SELECT COUNT(*) AS n FROM portfolio_entries').get().n;

test('portfolio entry: a bare create is a blank row to fill in', (t) => {
  const c = makeClient(t);
  const res = c.post('/api/portfolio/entry', { account_id: firstAccount(c).id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { id, ...fields } = res.body.entry;
  assert.ok(Number.isInteger(id));
  assert.deepStrictEqual(fields, { ticker: '', asset_name: '', amount: 0, price: 0, market_price: 0 });
});

test("portfolio entry: a create can carry the asset's details", (t) => {
  const c = makeClient(t);
  const account = firstAccount(c);
  const res = c.post('/api/portfolio/entry', {
    account_id: account.id, asset_name: 'Total Market Index', ticker: 'vtsax',
    amount: 142.3184, price: 96.4, market_price: 128.72,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const expected = {
    ticker: 'VTSAX', asset_name: 'Total Market Index', amount: 142.3184, price: 96.4, market_price: 128.72,
  };
  const { id, ...created } = res.body.entry;
  assert.deepStrictEqual(created, expected, 'the ticker is stored upper-case, the amount unrounded');
  const stored = c.get('/api/portfolio/data').body.accounts.find((a) => a.id === account.id).entries;
  assert.deepStrictEqual(stored, [{ id, ...expected }]);
});

test('portfolio entry: invalid details are refused before anything is written', (t) => {
  const c = makeClient(t);
  const account_id = firstAccount(c).id;
  for (const bad of [{ amount: '12' }, { price: null }, { market_price: true }, { ticker: 5 }, { asset_name: {} }]) {
    const res = c.post('/api/portfolio/entry', { account_id, asset_name: 'Bond Fund', ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(entryCount(c), 0, 'no half-made row is left behind');
});

test('portfolio entry: a create needs an account that exists', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/portfolio/entry', { account_id: 9999 }).status, 404);
  assert.equal(c.post('/api/portfolio/entry', { account_id: '1' }).status, 400);
  assert.equal(entryCount(c), 0);
});

test('portfolio entry: an edit takes the same fields as a create', (t) => {
  const c = makeClient(t);
  const account = firstAccount(c);
  const { id } = c.post('/api/portfolio/entry', { account_id: account.id }).body.entry;
  assert.equal(c.put(`/api/portfolio/entry/${id}`, { ticker: 'bndx', amount: 310, market_price: 51.05 }).status, 200);
  assert.equal(c.put(`/api/portfolio/entry/${id}`, { amount: 'lots' }).status, 400);
  const entry = c.get('/api/portfolio/data').body.accounts[0].entries[0];
  assert.deepStrictEqual(entry, { id, ticker: 'BNDX', asset_name: '', amount: 310, price: 0, market_price: 51.05 },
    'the refused edit changed nothing');
});

test('portfolio account: deleting one removes its holdings with it', (t) => {
  const c = makeClient(t);
  const { account } = c.post('/api/portfolio/account', { name: 'Retirement' }).body;
  c.post('/api/portfolio/entry', { account_id: account.id, asset_name: 'Target 2050', amount: 10 });
  c.post('/api/portfolio/entry', { account_id: firstAccount(c).id, asset_name: 'Kept', amount: 1 });
  assert.equal(c.del(`/api/portfolio/account/${account.id}`).status, 200);
  const { accounts } = c.get('/api/portfolio/data').body;
  assert.deepStrictEqual(accounts.map((a) => a.name), ['My Portfolio']);
  assert.equal(entryCount(c), 1, "only the other account's holding is left");
});
