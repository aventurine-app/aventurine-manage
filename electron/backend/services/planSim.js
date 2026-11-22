'use strict';

// The Plan section's model, for the backend: the module catalog, the plan
// rules (create, validate, the goal rules), the engine, goal evaluation and a
// run's summary figures.
//
// They live in static/js/plan/sim/ because the page runs them too, on every
// edit. Each file is dual-environment (a window global in the page,
// module.exports here), so this is the one place the backend reaches into
// static/. The relative path holds in development and when packaged: static/
// ships as an extraResource beside app.asar, three levels above this file in
// both layouts (see electron-builder.yml).

const path = require('path');

const SIM_DIR = path.join(__dirname, '..', '..', '..', 'static', 'js', 'plan', 'sim');
const load = (name) => require(path.join(SIM_DIR, name));

module.exports = {
  PlanCatalog: load('catalog.js'),
  PlanModel: load('plan.js'),
  PlanEngine: load('engine.js'),
  PlanGoals: load('goals.js'),
  PlanSummary: load('summary.js'),
};
