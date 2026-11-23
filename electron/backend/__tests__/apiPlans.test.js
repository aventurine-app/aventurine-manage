'use strict';

// Plans (handlers/plans.js): the Plan section's plans, their order and the
// goals they share, in the database file. Pinned here: every write is checked
// by the plan model before it is stored, the order survives and repairs
// itself, the plan cap holds for imports too, a stored plan or goal list this
// build cannot read is counted and never rewritten, and exports write files
// that import again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeClient } = require('./helpers');
const { PlanModel: Plan } = require('../services/planSim');
const PlanFiles = require('../services/planFiles');
const { MAX_PLANS } = require('../handlers/plans');

function samplePlan(name = 'Sample') {
  const plan = Plan.createPlan({ name, start: '2026-01', years: 2 });
  const salary = Plan.createNode(plan, 'salary', 0, 0);
  const savings = Plan.createNode(plan, 'bank-account', 300, 0);
  plan.nodes.push(salary, savings);
  plan.links.push(Plan.createLink(plan, salary.id, savings.id));
  return plan;
}

function load(c) {
  const r = c.get('/api/plans');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

function add(c, plan = samplePlan()) {
  const r = c.post('/api/plans', { plan });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.plan;
}

/** A row put straight into the table, as another build might have saved it. */
function storeRaw(c, id, body) {
  c.conn.db().prepare('INSERT INTO plans (id, body) VALUES (?, ?)').run(id, JSON.stringify(body));
}

test('plans: a fresh database has none and no goals', (t) => {
  const c = makeClient(t);
  assert.deepEqual(load(c), { plans: [], order: [], active: null, goals: [], quarantined: 0 });
});

test('plans: an added plan is stored, put at the end of the order and opened', (t) => {
  const c = makeClient(t);
  const a = add(c, samplePlan('A'));
  const b = add(c, samplePlan('B'));
  const stored = load(c);
  assert.deepEqual(stored.order, [a.id, b.id]);
  assert.equal(stored.active, b.id);
  assert.deepEqual(stored.plans.map((p) => p.name), ['A', 'B']);
  assert.equal(stored.plans[1].nodes.length, 2);
});

test('plans: the saved order comes back, and plans it misses follow it, oldest first', (t) => {
  const c = makeClient(t);
  const a = add(c, samplePlan('A'));
  const b = add(c, samplePlan('B'));
  assert.equal(c.put('/api/plans/order', { order: [b.id, a.id], active: a.id }).status, 200);
  assert.deepEqual(load(c).order, [b.id, a.id]);

  // A plan the saved order never mentions (stored by an older build).
  const old = { ...samplePlan('Old'), createdAt: '2000-01-01T00:00:00.000Z' };
  storeRaw(c, old.id, old);
  const stored = load(c);
  assert.deepEqual(stored.order, [b.id, a.id, old.id]);
  assert.equal(stored.active, a.id);
});

test('plans: reordering must list every plan once', (t) => {
  const c = makeClient(t);
  const a = add(c);
  const b = add(c);
  for (const order of [[a.id], [a.id, a.id], [a.id, 'p_missing'], 'nope']) {
    assert.equal(c.put('/api/plans/order', { order }).status, 400, JSON.stringify(order));
  }
  assert.equal(c.put('/api/plans/order', { order: [b.id, a.id], active: 'p_other' }).status, 400);
  assert.deepEqual(load(c).order, [a.id, b.id]);
});

test('plans: saving a plan checks it, keeps its creation date and stamps it', (t) => {
  const c = makeClient(t);
  const a = add(c);
  const edited = { ...a, name: 'Renamed', createdAt: '1999-01-01T00:00:00.000Z' };
  const r = c.put(`/api/plans/${a.id}`, { plan: edited });
  assert.equal(r.status, 200);
  const stored = load(c).plans[0];
  assert.equal(stored.name, 'Renamed');
  assert.equal(stored.createdAt, a.createdAt);
  assert.equal(stored.updatedAt, r.body.updatedAt);

  assert.equal(c.put(`/api/plans/${a.id}`, { plan: { ...a, nodes: 'x' } }).status, 422);
  assert.equal(c.put(`/api/plans/${a.id}`, {}).status, 400);
  assert.equal(c.put('/api/plans/p_other', { plan: a }).status, 400, 'id mismatch');
  const ghost = samplePlan();
  assert.equal(c.put(`/api/plans/${ghost.id}`, { plan: ghost }).status, 404);
  assert.equal(load(c).plans[0].name, 'Renamed');
});

test('plans: deleting the open plan opens its neighbour', (t) => {
  const c = makeClient(t);
  const a = add(c);
  const b = add(c);
  const d = add(c);
  c.put('/api/plans/order', { order: [a.id, b.id, d.id], active: b.id });
  assert.deepEqual(c.del(`/api/plans/${b.id}`).body, { order: [a.id, d.id], active: d.id });
  assert.deepEqual(c.del(`/api/plans/${d.id}`).body, { order: [a.id], active: a.id });
  assert.equal(c.del(`/api/plans/${d.id}`).status, 404);
  assert.deepEqual(load(c).plans.map((p) => p.id), [a.id]);
});

test('plans: a plan is refused past the cap and when its id is taken', (t) => {
  const c = makeClient(t);
  const first = add(c);
  assert.equal(c.post('/api/plans', { plan: first }).status, 409);
  for (let i = 1; i < MAX_PLANS; i++) add(c);
  const r = c.post('/api/plans', { plan: samplePlan() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, `at most ${MAX_PLANS} plans`);
  assert.equal(load(c).plans.length, MAX_PLANS);
});

test('plans: a stored plan this build cannot read is counted and never rewritten', (t) => {
  const c = makeClient(t);
  const good = add(c);
  const future = { id: 'p_future', nodes: 'from a newer build' };
  storeRaw(c, future.id, future);
  const stored = load(c);
  assert.equal(stored.quarantined, 1);
  assert.deepEqual(stored.order, [good.id]);
  // Reordering and deleting the readable plans leave it alone.
  c.put('/api/plans/order', { order: [good.id], active: good.id });
  c.del(`/api/plans/${good.id}`);
  const row = c.conn.db().prepare('SELECT body FROM plans WHERE id = ?').get(future.id);
  assert.deepEqual(JSON.parse(row.body), future);
});

test('plans: goals are checked, stored, and a newer build\'s goals are never saved over', (t) => {
  const c = makeClient(t);
  const goal = Plan.createGoal({ name: 'A million' });
  assert.equal(c.put('/api/plans/goals', { goals: [goal] }).status, 200);
  assert.deepEqual(load(c).goals.map((g) => g.name), ['A million']);
  assert.equal(c.put('/api/plans/goals', {}).status, 400);
  assert.equal(c.put('/api/plans/goals', { goals: [{ id: 'g_x', metric: 'nonsense' }] }).status, 422);

  c.conn.db().prepare('UPDATE app_settings SET value = ? WHERE "key" = ?')
    .run(JSON.stringify([{ id: 'g_new', metric: 'from-the-future' }]), 'plan_goals');
  assert.deepEqual(load(c).goals, []);
  assert.equal(c.put('/api/plans/goals', { goals: [goal] }).status, 409);
});

test('plans: an exported plan imports again as a new plan with new ids', (t) => {
  const c = makeClient(t);
  const a = add(c, samplePlan('Exported'));
  const file = path.join(c.dir, 'plan.json');
  assert.equal(c.post(`/api/plans/${a.id}/export`, { format: 'json', path: file }).status, 200);

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(text).format, PlanFiles.PLAN_FILE_FORMAT);
  const once = c.post('/api/plans/import', { text }).body.plans[0];
  const twice = c.post('/api/plans/import', { text }).body.plans[0];
  assert.notEqual(once.id, a.id);
  assert.notEqual(once.id, twice.id);
  assert.equal(once.name, 'Exported');
  assert.notEqual(once.nodes[0].id, a.nodes[0].id);
  const stored = load(c);
  assert.equal(stored.plans.length, 3);
  assert.equal(stored.active, twice.id);
});

test('plans: a bare plan object imports, and a file that is no plan is refused', (t) => {
  const c = makeClient(t);
  assert.equal(c.post('/api/plans/import', { text: JSON.stringify(samplePlan('Bare')) }).status, 200);
  for (const text of ['not json', '{"nodes":"x"}', null]) {
    const r = c.post('/api/plans/import', { text });
    assert.equal(r.status, 422, String(text));
    assert.ok(r.body.error);
  }
  assert.equal(load(c).plans.length, 1);
});

test('plans: an older plan file\'s own goals join the shared list once', (t) => {
  const c = makeClient(t);
  const old = { ...samplePlan('Old'), goals: [Plan.createGoal({ name: 'Kept in the plan' })] };
  const text = JSON.stringify(old);
  const r = c.post('/api/plans/import', { text });
  assert.deepEqual(r.body.goals.map((g) => g.name), ['Kept in the plan']);
  c.post('/api/plans/import', { text });
  assert.equal(load(c).goals.length, 1);
});

test('plans: Download All writes a zip, and its every-plan file imports whole or not at all', (t) => {
  const c = makeClient(t);
  add(c, samplePlan('One'));
  add(c, samplePlan('Two'));
  c.put('/api/plans/goals', { goals: [Plan.createGoal({ name: 'Goal' })] });
  const file = path.join(c.dir, 'all.zip');
  assert.equal(c.post('/api/plans/export-all', { path: file }).status, 200);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'a zip local file header');

  const stored = load(c);
  const every = PlanFiles.serializeAll({ plans: stored.plans, goals: stored.goals });
  const r = c.post('/api/plans/import', { text: every });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.plans.map((p) => p.name), ['One', 'Two']);
  assert.equal(load(c).goals.length, 1, 'the goal it already held is not added twice');

  // With room for fewer plans than the file holds, nothing is imported.
  for (let i = load(c).plans.length; i < MAX_PLANS - 1; i++) add(c);
  const refused = c.post('/api/plans/import', { text: every });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /holds 2 plans and there is room for 1/);
  assert.equal(load(c).plans.length, MAX_PLANS - 1);
});

test('plans: exports refuse an unknown format, a missing plan and a missing path', (t) => {
  const c = makeClient(t);
  const a = add(c);
  const file = path.join(c.dir, 'x.csv');
  assert.equal(c.post(`/api/plans/${a.id}/export`, { format: 'pdf', path: file }).status, 400);
  assert.equal(c.post('/api/plans/p_missing/export', { format: 'csv', path: file }).status, 404);
  assert.equal(c.post(`/api/plans/${a.id}/export`, { format: 'csv' }).status, 400);
  assert.equal(c.post(`/api/plans/${a.id}/export`, { format: 'csv', path: file }).status, 200);
  assert.match(fs.readFileSync(file, 'utf8'), /^\uFEFF/, 'a byte-order mark, so Excel reads UTF-8');
});

test('plans: on Basic every edit answers 402, and reading and exporting still work', (t) => {
  const c = makeClient(t);
  const a = add(c, samplePlan('Kept'));
  const text = PlanFiles.serialize(samplePlan('Imported'));

  let tier = 'basic';
  c.conn.setSubscriptionCheck(() => tier);
  const refused = [
    c.post('/api/plans', { plan: samplePlan('New') }),
    c.put(`/api/plans/${a.id}`, { plan: { ...a, name: 'Renamed' } }),
    c.put('/api/plans/order', { order: [a.id], active: a.id }),
    c.put('/api/plans/goals', { goals: [] }),
    c.post('/api/plans/import', { text }),
    c.del(`/api/plans/${a.id}`),
  ];
  for (const r of refused) assert.deepEqual([r.status, r.body.error], [402, 'subscription_required']);

  // Nothing changed, and the plans can still be read and taken out.
  const stored = load(c);
  assert.deepEqual(stored.plans.map((p) => p.name), ['Kept']);
  const one = path.join(c.dir, 'kept.json');
  const all = path.join(c.dir, 'all.zip');
  assert.equal(c.post(`/api/plans/${a.id}/export`, { format: 'json', path: one }).status, 200);
  assert.equal(c.post('/api/plans/export-all', { path: all }).status, 200);
  assert.ok(fs.existsSync(one) && fs.existsSync(all));

  // On Pro (an upgrade, or signed in later), edits go through.
  tier = 'pro';
  add(c, samplePlan('After'));
  assert.equal(load(c).plans.length, 2);
});

test('app: with no subscription every /api/ request answers 402, plans and data alike', (t) => {
  const c = makeClient(t);
  add(c, samplePlan('Kept'));
  let tier = 'none';
  c.conn.setSubscriptionCheck(() => tier);
  for (const r of [c.get('/api/plans'), c.get('/api/db/status'), c.get('/api/transactions')]) {
    assert.deepEqual([r.status, r.body.error], [402, 'subscription_required']);
  }
  // An answer the shell doesn't recognise is no subscription, not a free pass.
  tier = 'gold';
  assert.equal(c.get('/api/plans').status, 402);

  // Basic opens the app (and reads plans); Pro is needed only to change them.
  tier = 'basic';
  assert.equal(c.get('/api/plans').status, 200);
  assert.equal(c.get('/api/db/status').status, 200);
  assert.equal(c.post('/api/plans', { plan: samplePlan('New') }).status, 402);
});
