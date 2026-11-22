'use strict';

// The exported plan file: plain JSON the user keeps, so it must stay readable
// without Aventurine. Pure functions only; handlers/plans.js reads and writes
// the files.
//
//   { format: 'citrine-plan', version: 1, exportedAt, plan }          one plan
//   { format: 'aventurine-planner-plans', version: 1, exportedAt,
//     plans: [plan, ...], goals: [goal, ...] }                       every plan
//
// Both format names are persisted in files users already hold (the single
// plan's predates the product name, and the every-plan one comes from the web
// Planner's "Download All"), so they never change. A bare plan object (no
// wrapper) imports too.

const { ApiError } = require('../validate');

const PLAN_FILE_FORMAT = 'citrine-plan';
const ALL_PLANS_FORMAT = 'aventurine-planner-plans';
const FILE_VERSION = 1;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** The text to save for one plan. */
function serialize(plan, exportedAt = new Date()) {
  return JSON.stringify({
    format: PLAN_FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    plan,
  }, null, 2);
}

/** The text to save for every plan and the shared goals. */
function serializeAll({ plans, goals }, exportedAt = new Date()) {
  return JSON.stringify({
    format: ALL_PLANS_FORMAT,
    version: FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    plans,
    goals,
  }, null, 2);
}

/**
 * What a file holds, still unvalidated (the workspace does that):
 * { plans: [raw plan, ...], goals: raw goal list or null }. A one-plan
 * file gives a list of one, and its goals (if an older plan had its own)
 * stay inside the plan.
 */
function read(text) {
  const parsed = parseJson(text);
  if (parsed && parsed.format === ALL_PLANS_FORMAT) {
    if (!Array.isArray(parsed.plans)) throw new ApiError('not an Aventurine Planner plan file', 422);
    return { plans: parsed.plans, goals: Array.isArray(parsed.goals) ? parsed.goals : null };
  }
  return { plans: [parsed && parsed.format === PLAN_FILE_FORMAT ? parsed.plan : parsed], goals: null };
}

/** The plan inside a one-plan file's text, still unvalidated. */
function parse(text) {
  const parsed = parseJson(text);
  return parsed && parsed.format === PLAN_FILE_FORMAT ? parsed.plan : parsed;
}

function parseJson(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) {
    throw new ApiError('file is too large to be a plan', 422);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('not an Aventurine Planner plan file', 422);
  }
  return parsed;
}

/** A file name for a plan: its name without characters file systems refuse, and `ext`. */
function fileName(planName, ext = 'json') {
  // eslint-disable-next-line no-control-regex
  const safe = String(planName || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 60);
  return `${safe || 'plan'}.${ext}`;
}

module.exports = { PLAN_FILE_FORMAT, ALL_PLANS_FORMAT, MAX_IMPORT_BYTES, serialize, serializeAll, read, parse, fileName };
