'use strict';

// Plan routes: the plans of the Plan section and the goals they share.
//
// The plans live in this database (the `plans` table, one JSON document per
// plan) so they go wherever the user's data goes: encrypted with it, locked
// with it, and replaced when another file is opened. Their order in the plan
// tabs and the open plan are the app_settings row `plan_tabs`
// ({ order, active }); the goals every plan is measured against are
// `plan_goals` (a list).
//
// The plan model (static/js/plan/sim/plan.js, via services/planSim.js) judges
// every document: each write is validated before it is stored, and each read
// is validated before it is answered. A stored plan the model cannot read (one
// saved by a newer build, say) is left untouched and only counted as
// `quarantined`; stored goals it cannot read are left alone too, and no write
// replaces them. The same rules applied when these plans lived in the
// browser, and a test pins each of them.
//
//   GET    /api/plans                 { plans: [plan], order, active, goals, quarantined }
//   POST   /api/plans                 { plan }            -> { plan }   (added, opened)
//   PUT    /api/plans/order           { order, active }   -> { order, active }
//   PUT    /api/plans/goals           { goals }           -> { goals }
//   POST   /api/plans/import          { text }            -> { plans, goals }
//   POST   /api/plans/export-all      { path }            -> { ok }     (the "Download All" zip)
//   PUT    /api/plans/<id>            { plan }            -> { updatedAt }
//   DELETE /api/plans/<id>                                -> { order, active }
//   POST   /api/plans/<id>/export     { format, path }    -> { ok }     (json | csv)
//
// The Plan section is a Pro feature (CLAUDE.md rule 16). Every route that
// changes plans or goals asks ctx.requireSubscription('pro') first and answers
// 402 `subscription_required` on Basic. Reading and exporting do not: the plans
// are the user's data, and dropping to Basic never locks them in.
//
// Exports write to a path from a native save dialog (main.js
// `export-choose-path`), which approves it; any other path goes through
// ctx.authorizeWrite's confirmation. Imports take the file's text, which the
// page reads from a file the user picked, so this module never opens a path
// the renderer names.

const fs = require('fs');
const { bad } = require('../validate');
const { PlanModel: Plan } = require('../services/planSim');
const PlanFiles = require('../services/planFiles');
const PlanExports = require('../services/planExports');

const ORDER_KEY = 'plan_tabs';
const GOALS_KEY = 'plan_goals';
const MAX_PLANS = 15;

const now = () => new Date().toISOString();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Validation ───────────────────────────────────────────────────────────

/** `fn()` with the model's PlanError answered as 422 (`prefix` leads the message). */
function judged(fn, prefix = '') {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Plan.PlanError) bad(`${prefix}${e.message}`, 422);
    throw e;
  }
}

const validPlan = (raw) => judged(() => Plan.validatePlan(raw));

function planFromBody(body) {
  if (!isPlainObject(body) || !body.plan) bad('plan required');
  return validPlan(body.plan);
}

/** A plan's own goals, from before goals were shared. A malformed list is
 *  skipped: it is not worth refusing the plan over. */
function legacyGoalsOf(raw) {
  try {
    return Plan.legacyGoals(raw);
  } catch (e) {
    console.warn('[plans] a plan\'s old goals were left unread:', e.message);
    return [];
  }
}

// ── Storage ──────────────────────────────────────────────────────────────

/** A stored JSON setting, or undefined when it was never stored, or null when
 *  it cannot be parsed. */
function readSetting(db, key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE "key" = ?').get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function writeSetting(db, key, value) {
  db.prepare(
    `INSERT INTO app_settings ("key", value) VALUES (?, ?)
     ON CONFLICT("key") DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value));
}

/**
 * Every stored plan the model can read, in the user's order: { plans (id →
 * plan), order, active, quarantined }. Plans the saved order does not mention
 * follow it, oldest first; an unknown or missing active plan becomes the first.
 */
function readPlans(db) {
  const readable = [];
  let quarantined = 0;
  for (const { body } of db.prepare('SELECT body FROM plans').all()) {
    try {
      readable.push(Plan.validatePlan(JSON.parse(body)));
    } catch (e) {
      quarantined += 1;
      console.warn('[plans] a stored plan was left unread:', e.message);
    }
  }
  readable.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const plans = new Map(readable.map((p) => [p.id, p]));

  const saved = readSetting(db, ORDER_KEY);
  const order = [];
  for (const id of new Set(Array.isArray(saved?.order) ? saved.order : [])) {
    if (plans.has(id)) order.push(id);
  }
  for (const p of readable) if (!order.includes(p.id)) order.push(p.id);
  const active = order.includes(saved?.active) ? saved.active : (order[0] ?? null);
  return { plans, order, active, quarantined };
}

/** The shared goals: { goals, readable }. Never stored reads as none. */
function readGoals(db) {
  const stored = readSetting(db, GOALS_KEY);
  if (stored === undefined) return { goals: [], readable: true };
  try {
    return { goals: Plan.validateGoals(stored), readable: true };
  } catch (e) {
    console.warn('[plans] the stored goals were left unread:', e.message);
    return { goals: [], readable: false };
  }
}

function insertPlan(db, plan) {
  db.prepare('INSERT INTO plans (id, body) VALUES (?, ?)').run(plan.id, JSON.stringify(plan));
}

/** Add `added` (validated) at the end of the order; the first becomes the
 *  open plan. Refused whole (409) when they would not fit. */
function addPlans(db, ws, added) {
  const room = MAX_PLANS - ws.plans.size;
  if (added.length > room) {
    if (added.length === 1) bad(`at most ${MAX_PLANS} plans`, 409);
    bad(`the file holds ${added.length} plans and there is room for ${room}`, 409);
  }
  const stamp = now();
  for (const plan of added) {
    if (db.prepare('SELECT 1 FROM plans WHERE id = ?').get(plan.id)) bad('plan already exists', 409);
    plan.updatedAt = stamp;
    insertPlan(db, plan);
    ws.order.push(plan.id);
  }
  writeSetting(db, ORDER_KEY, { order: ws.order, active: added[0].id });
}

function storedPlan(db, id) {
  const row = db.prepare('SELECT body FROM plans WHERE id = ?').get(id);
  if (!row) bad('plan not found', 404);
  return JSON.parse(row.body);
}

// ── Handlers ─────────────────────────────────────────────────────────────

function load(ctx) {
  const db = ctx.db();
  const { plans, order, active, quarantined } = readPlans(db);
  return { plans: order.map((id) => plans.get(id)), order, active, goals: readGoals(db).goals, quarantined };
}

function add(ctx, { body }) {
  const plan = planFromBody(body);
  const db = ctx.db();
  db.transaction(() => addPlans(db, readPlans(db), [plan]))();
  return { plan };
}

function put(ctx, { params, body }) {
  const plan = planFromBody(body);
  if (plan.id !== params.id) bad('plan id mismatch');
  const db = ctx.db();
  const prev = storedPlan(db, params.id);
  if (typeof prev.createdAt === 'string') plan.createdAt = prev.createdAt;
  plan.updatedAt = now();
  db.prepare('UPDATE plans SET body = ? WHERE id = ?').run(JSON.stringify(plan), plan.id);
  return { updatedAt: plan.updatedAt };
}

function remove(ctx, { params }) {
  const db = ctx.db();
  return db.transaction(() => {
    const ws = readPlans(db);
    storedPlan(db, params.id);
    const at = ws.order.indexOf(params.id);
    const order = ws.order.filter((id) => id !== params.id);
    const active = ws.active === params.id ? (order[Math.min(at, order.length - 1)] ?? null) : ws.active;
    db.prepare('DELETE FROM plans WHERE id = ?').run(params.id);
    writeSetting(db, ORDER_KEY, { order, active });
    return { order, active };
  })();
}

function setOrder(ctx, { body }) {
  const next = isPlainObject(body) ? body.order : null;
  const db = ctx.db();
  return db.transaction(() => {
    const ws = readPlans(db);
    if (!Array.isArray(next) || next.length !== ws.order.length
      || new Set(next).size !== next.length || !next.every((id) => ws.plans.has(id))) {
      bad('order must list every plan once');
    }
    const active = body.active ?? ws.active;
    if (active != null && !next.includes(active)) bad('unknown active plan');
    writeSetting(db, ORDER_KEY, { order: next, active });
    return { order: next.slice(), active };
  })();
}

function putGoals(ctx, { body }) {
  const raw = isPlainObject(body) ? body.goals : undefined;
  if (!Array.isArray(raw)) bad('goals required');
  const goals = judged(() => Plan.validateGoals(raw));
  const db = ctx.db();
  db.transaction(() => {
    if (!readGoals(db).readable) bad('the goals were saved by a newer version', 409);
    writeSetting(db, GOALS_KEY, goals);
  })();
  return { goals };
}

/**
 * Add every plan in a plan file (one plan, or Download All's every-plan
 * file) and the goals it brings that the list does not hold yet: all of it or
 * none. Ids are regenerated, so importing a file twice gives independent
 * plans. Goals an older file kept inside a plan join the shared list too.
 */
function importFile(ctx, { body }) {
  const text = isPlainObject(body) ? body.text : null;
  const contents = PlanFiles.read(text);
  if (!contents.plans.length) bad('the file holds no plans', 422);
  const added = contents.plans.map((raw) => Plan.cloneWithNewIds(validPlan(raw)));
  let incoming = contents.plans.flatMap(legacyGoalsOf);
  if (contents.goals) incoming = [...judged(() => Plan.validateGoals(contents.goals), 'the file\'s goals: '), ...incoming];

  const db = ctx.db();
  return db.transaction(() => {
    addPlans(db, readPlans(db), added);
    const stored = readGoals(db);
    let { goals } = stored;
    if (stored.readable) {
      const merged = Plan.mergeGoals(goals, incoming);
      if (merged.length !== goals.length) {
        goals = merged;
        writeSetting(db, GOALS_KEY, goals);
      }
    }
    return { plans: added, goals };
  })();
}

/** Write `data` to the path a save dialog gave (see the header). */
function writeExport(ctx, path, data) {
  if (typeof path !== 'string' || !path.trim()) bad('choose where to save the file');
  ctx.authorizeWrite(path);
  try {
    fs.writeFileSync(path, data);
  } catch (e) {
    console.error('[plans] the export could not be written:', e);
    bad('the file could not be written', 500);
  }
  return { ok: true };
}

const EXPORTS = {
  json: (plan) => PlanFiles.serialize(plan),
  csv: (plan) => PlanExports.planCsv(plan),
};

function exportPlan(ctx, { params, body }) {
  const { format = 'json', path = null } = isPlainObject(body) ? body : {};
  if (!Object.hasOwn(EXPORTS, format)) bad('unknown export format');
  const plan = validPlan(storedPlan(ctx.db(), params.id));
  return writeExport(ctx, path, EXPORTS[format](plan));
}

function exportAll(ctx, { body }) {
  const db = ctx.db();
  const { plans, order } = readPlans(db);
  const archive = PlanExports.archive({ plans: order.map((id) => plans.get(id)), goals: readGoals(db).goals });
  return writeExport(ctx, isPlainObject(body) ? body.path : null, archive);
}

// Literal segments ('order', 'goals', 'import', 'export-all') come before the
// <id> patterns beside them. Plan ids are always '<letter>_<chars>'
// (Plan.newId), so no plan can be named like one of them.
/** `fn` behind Pro (see the header). */
const subscriber = (fn) => (ctx, req) => {
  ctx.requireSubscription('pro');
  return fn(ctx, req);
};

const routes = [
  ['GET',    '/api/plans',                 load],
  ['POST',   '/api/plans',                 subscriber(add)],
  ['PUT',    '/api/plans/order',           subscriber(setOrder)],
  ['PUT',    '/api/plans/goals',           subscriber(putGoals)],
  ['POST',   '/api/plans/import',          subscriber(importFile)],
  ['POST',   '/api/plans/export-all',      exportAll],
  ['PUT',    '/api/plans/<id>',            subscriber(put)],
  ['DELETE', '/api/plans/<id>',            subscriber(remove)],
  ['POST',   '/api/plans/<id>/export',     exportPlan],
];

module.exports = { routes, MAX_PLANS };
