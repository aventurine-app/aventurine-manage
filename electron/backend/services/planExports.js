'use strict';

// Plan exports: one plan month by month as CSV, every goal against every plan
// as CSV, and "Download All" as a zip (every plan as a re-importable file, the
// goals CSV and one CSV per plan). Pure apart from running the engine: the
// handler (handlers/plans.js) writes what these return to the path the user
// chose in a save dialog.
//
// The zip is written here rather than with a library: stored (uncompressed)
// entries need only a CRC-32 and two headers per file, and the files are a
// few kilobytes of text.

const { PlanModel: Plan, PlanEngine: Engine, PlanGoals: Goals, PlanSummary: Summary } = require('./planSim');
const PlanFiles = require('./planFiles');

// ── CSV ─────────────────────────────────────────────────────────────────

// A text cell a spreadsheet would run as a formula (a module named
// "=HYPERLINK(...)") is written with a leading apostrophe instead.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 text for { columns, rows }, with a byte-order mark so Excel reads it as UTF-8. */
function toCsv({ columns, rows }) {
  return `\uFEFF${[columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** The engine's run of a plan, or null if it fails (the file then says so rather than missing). */
function run(plan, logger) {
  try {
    return Engine.simulate(plan);
  } catch (e) {
    logger.error('[exports] simulation failed', plan.id, e);
    return null;
  }
}

function planCsv(plan, { logger = console } = {}) {
  const res = run(plan, logger);
  if (!res) return toCsv({ columns: ['Error'], rows: [['This plan could not be simulated.']] });
  return toCsv(Summary.months(plan, res));
}

const GOAL_STATUS = {
  met: 'Met on time',
  late: 'Met late',
  unmet: 'Never met',
  blocked: 'Cannot be measured in this plan',
};

/** Every goal against every plan, one row each, judged over the goal
 *  horizon as the Goals page judges them. */
function goalsCsv(plans, goals, { logger = console } = {}) {
  const rows = [];
  for (const plan of plans) {
    const res = goals.length ? run(Goals.horizon(plan), logger) : null;
    const evs = res ? Goals.evaluate(plan, res, goals) : [];
    goals.forEach((goal, i) => {
      const ev = evs[i];
      const month = (k) => (k == null || k < 0 ? null : Plan.ymAdd(plan.settings.start, k));
      rows.push([
        goal.name, plan.name,
        !ev ? 'Could not be measured' : GOAL_STATUS[ev.status],
        ev && !ev.blocked ? month(ev.month) : null,
        ev ? month(ev.byIdx) : null,
      ]);
    });
  }
  return toCsv({ columns: ['Goal', 'Plan', 'Status', 'Met in', 'Deadline'], rows });
}

// ── Zip ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A date as MS-DOS { time, date }, the only kind a zip entry holds. */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A zip (stored, no compression) of `files`: [{ name, text }]. Names are
 * UTF-8 (flag bit 11). Returns a Uint8Array.
 */
function zip(files, when = new Date()) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 names
    local.setUint16(8, 0, true);           // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);        // made by
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Everything ──────────────────────────────────────────────────────────

/** File names from plan names, with "(2)", "(3)" for repeats, ignoring case. */
function uniqueNames(names, ext) {
  const seen = new Map();
  return names.map((name) => {
    const base = PlanFiles.fileName(name, ext).slice(0, -(ext.length + 1));
    const key = base.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return `${n === 1 ? base : `${base} (${n})`}.${ext}`;
  });
}

const DATE = (d) => d.toISOString().slice(0, 10);

/** The name of the "Download All" file: 'Aventurine Planner 2026-11-05.zip'. */
const archiveName = (when = new Date()) => `Aventurine Planner ${DATE(when)}.zip`;

/**
 * "Download All": every plan, in the order given, and the shared goals.
 *   All plans.json      imports again (PlanFiles.ALL_PLANS_FORMAT)
 *   Goals.csv
 *   CSV/<plan>.csv      one per plan
 */
function archive({ plans, goals }, { when = new Date(), logger = console } = {}) {
  const csvNames = uniqueNames(plans.map((p) => p.name), 'csv');
  const files = [
    { name: 'All plans.json', text: PlanFiles.serializeAll({ plans, goals }, when) },
    { name: 'Goals.csv', text: goalsCsv(plans, goals, { logger }) },
    ...plans.map((plan, i) => ({ name: `CSV/${csvNames[i]}`, text: planCsv(plan, { logger }) })),
  ];
  return zip(files, when);
}

module.exports = { toCsv, planCsv, goalsCsv, zip, crc32, archive, archiveName };
