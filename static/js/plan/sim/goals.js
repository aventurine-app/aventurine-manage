'use strict';

// ─── goals.js ───────────────────────────────────────────────────────────────
// When a plan meets the user's goals. A goal is one rule (plan.js has its
// shape): a measure, compared with a target, maybe by a deadline:
//
//   "Net worth is at least 25 times yearly expenses by age 65"
//
// Goals are shared by all plans, so each function takes the plan to measure
// and the goals to measure it by. Pure, like the engine: no DOM, no clock, no
// randomness.
//
//   horizon(plan)                              the plan as goals are judged on
//                                              it: run over the longest length a
//                                              plan can have, whatever length is
//                                              being viewed
//   evaluate(plan, results, goals, { real })   one status per goal, read off a
//                                              run, with how close the plan
//                                              comes to it
//
// A goal asks whether a plan EVER meets it, so its status must not change
// with the length on show (the length chips). Simulate horizon(plan) and
// evaluate that run for any status the user reads; a shorter run serves only
// views that mark months inside it (Analyze's goal flags).
//
// The measures, at each balance point k (0..months, the moment month k-1 ends,
// where the net worth series is recorded):
//
//   net-worth   net worth
//   savings     every account's balance plus Unassigned ("account balance")
//   debt        everything owed
//   expenses    a year of spending and loan payments: the twelve months before
//               the point, or the plan's first twelve for points inside them
//               (a shorter plan's months scaled up to a year). Card payments
//               are left out: what a card buys is spending already.
//   income      a year of take-home pay (earned less withholding), the same way
//
// A goal is met at the first point its rule holds: on time (or early) when
// that point is at or before its deadline's, late when after it, and unmet
// when the rule never holds in the run. A rule that reads a year of income or
// expenses in a plan that has none is `blocked`, a goal the plan cannot
// measure (there is nothing to compare), as is an age deadline in a plan
// whose age is not set.
//
// With `real`, money is measured in the plan's first month's money (deflated
// at the plan's inflation); an amount in a rule is then taken in today's
// money too. The page measures as of each month (real off).
//
// Dual-environment: window.PlanGoals in the page, CommonJS for the tests.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const Plan = isNode ? require('./plan.js') : root.PlanModel;
    const api = factory(Plan);
    if (isNode) module.exports = api;
    else root.PlanGoals = api;
}(typeof self !== 'undefined' ? self : this, function (Plan) {

    // Within half a cent counts as met.
    const EPS = 0.005;

    // The measures that are a year's flow rather than a balance.
    const YEARLY = new Set(['expenses', 'income']);

    /** Deflators at the plan's inflation by balance point k (all 1 unless
     *  `real`). A month's flow lands at the end of the month: point m + 1. */
    function deflator(plan, count, real) {
        const d = new Float64Array(count + 1);
        const i = real ? (plan.settings.inflation || 0) / 100 : 0;
        for (let k = 0; k <= count; k++) d[k] = i ? Math.pow(1 + i, -k / 12) : 1;
        return d;
    }

    // The page re-simulates a frame after each edit, so for that frame the plan
    // may hold a module the results do not. Such a module is left out of the
    // measures until the next run, rather than read as missing data.
    const ofRole = (plan, role, res) => plan.nodes.filter((n) => Plan.roleOf(n) === role && res.nodes[n.id]);

    /** Sum of the balance series of `nodes`, plus `base` if given. */
    function sumBalances(res, nodes, base = null) {
        const out = base ? Float64Array.from(base) : new Float64Array(res.months + 1);
        for (const n of nodes) {
            const b = res.nodes[n.id].balance;
            for (let k = 0; k < out.length; k++) out[k] += b[k];
        }
        return out;
    }

    /** A monthly flow as a year's worth at each point (see the header). */
    function yearly(n, monthly, def) {
        const year = Math.min(12, n);
        const sums = new Float64Array(n + 1);   // running total of the months
        for (let m = 0; m < n; m++) sums[m + 1] = sums[m] + monthly(m) * def[m + 1];
        const out = new Float64Array(n + 1);
        for (let k = 0; k <= n; k++) {
            const end = Math.max(k, year);
            out[k] = (sums[end] - sums[end - year]) * 12 / year;
        }
        return out;
    }

    /** One measure's series over the run, in the run's money (or today's, by `def`). */
    function measure(plan, res, def, metric) {
        const n = res.months;
        const at = (values) => Float64Array.from(values, (v, k) => v * def[k]);
        switch (metric) {
            case 'net-worth': return at(res.netWorth);
            case 'savings': return at(sumBalances(res, ofRole(plan, 'account', res), res.unassigned));
            case 'debt': return at(sumBalances(res, ofRole(plan, 'debt', res)));
            case 'expenses': {
                const loans = ofRole(plan, 'debt', res).filter((d) => res.nodes[d.id].kind !== 'card');
                return yearly(n, (m) => {
                    let cost = res.flows.spent[m];
                    for (const d of loans) cost += res.nodes[d.id].paid[m];
                    return cost;
                }, def);
            }
            case 'income': return yearly(n, (m) => res.flows.earned[m] - res.flows.withheld[m], def);
            default: throw new Error(`unknown measure ${metric}`);
        }
    }

    /** What a goal's rule compares, at each point: the measure, and its target. */
    function sides(plan, res, def, goal) {
        const value = measure(plan, res, def, goal.metric);
        if (goal.unit === 'amount') return { value, target: new Float64Array(value.length).fill(goal.value), of: null };
        const of = measure(plan, res, def, goal.of);
        const scale = goal.unit === 'percent' ? goal.value / 100 : goal.value;
        return { value, target: Float64Array.from(of, (v) => v * scale), of };
    }

    /** Why a goal cannot be measured in this plan, or null. */
    function blockedBy(plan, goal, s) {
        if (goal.due === 'age' && !Plan.goalDate(plan, goal)) return 'no-age';
        for (const [metric, series] of [[goal.metric, s.value], [goal.unit === 'amount' ? null : goal.of, s.of]]) {
            if (YEARLY.has(metric) && !series.some((v) => Math.abs(v) > EPS)) return `no-${metric}`;
        }
        return null;
    }

    const clamp01 = (v) => Math.min(1, Math.max(0, v));

    /** How close a rule's measure comes to its target at point k, 0..1. One
     *  that must reach at least its target: the share of the target reached.
     *  One that must fall to at most it: the share of the way down to it from
     *  the highest the measure stood up to k. */
    function towards(goal, s, k) {
        const v = s.value[k];
        const t = s.target[k];
        if (goal.op === 'lte') {
            if (v <= t + EPS) return 1;
            let peak = v;
            for (let i = 0; i < k; i++) peak = Math.max(peak, s.value[i]);
            return peak - t > EPS ? clamp01((peak - v) / (peak - t)) : 0;
        }
        if (v >= t - EPS) return 1;
        return t > EPS ? clamp01(v / t) : 0;
    }

    /** One goal's status from a run.
     *    status    'met' (on time, early, or with no deadline), 'late' (met
     *              after its deadline), 'unmet' (its rule never holds in the
     *              run) or 'blocked' (the plan cannot measure it)
     *    month     the point its rule first holds, or null
     *    byIdx     the point its deadline falls on, or null without one
     *    months    the run's length, the span "never" covers
     *    at        the point the figures are read at: when met, else the end
     *    value, target  the two sides of the rule at `at`
     *    progress  how close the plan comes to the target, 0..1: 1 once met
     *              (late or not); the closest it ever comes when unmet; null
     *              when blocked
     *    progressAt  the point that progress is read at
     *    blocked   'no-age' | 'no-income' | 'no-expenses', or null */
    function evaluateOne(plan, res, def, goal) {
        const s = sides(plan, res, def, goal);
        const n = res.months;
        const holds = goal.op === 'lte'
            ? (k) => s.value[k] <= s.target[k] + EPS
            : (k) => s.value[k] >= s.target[k] - EPS;
        const blocked = blockedBy(plan, goal, s);
        let month = null;
        if (!blocked) for (let k = 0; k <= n; k++) if (holds(k)) { month = k; break; }
        const due = Plan.goalDate(plan, goal);
        const byIdx = due ? Plan.ymDiff(plan.settings.start, due) : null;
        let status;
        if (blocked) status = 'blocked';
        else if (month == null) status = 'unmet';
        else status = byIdx == null || month <= Math.max(0, byIdx) ? 'met' : 'late';
        const at = month != null ? month : n;
        let progress = null;
        let progressAt = at;
        if (month != null) progress = 1;
        else if (!blocked) {
            progress = -1;
            for (let k = 0; k <= n; k++) {
                const p = towards(goal, s, k);
                if (p > progress + 1e-9) { progress = p; progressAt = k; }
            }
        }
        return { id: goal.id, status, month, byIdx, months: n, at, value: s.value[at], target: s.target[at], progress, progressAt, blocked };
    }

    /** `plan` as goals judge it: over the longest length a plan may have.
     *  The plan itself is not changed. */
    function horizon(plan) {
        const years = Plan.LIMITS.years;
        return plan.settings.years === years ? plan : { ...plan, settings: { ...plan.settings, years } };
    }

    function evaluate(plan, res, goals, { real = false } = {}) {
        const def = deflator(plan, res.months, real);
        return goals.map((goal) => evaluateOne(plan, res, def, goal));
    }

    return { deflator, evaluate, horizon, HORIZON_YEARS: Plan.LIMITS.years };
}));
