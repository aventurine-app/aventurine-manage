'use strict';

// ─── runs.js ────────────────────────────────────────────────────────────────
// Every plan's run of the engine, for the views that look at more than the
// open plan (Compare, the goal board, the goal inspector). A plan is
// simulated once per version of it (its updatedAt) and length; the open
// plan's run over the app's length is the store's own.
//
//   Runs.all()           [{ plan, results }] for every plan, in navigation
//                        order, each run over the app's length (PlanStore.state.years);
//                        results is null for a plan the engine failed on
//   Runs.all({ years })  the same, every plan run over `years` instead
//                        (Compare); the plans are not changed
//   Runs.forGoals(plan)  one plan's run over the goal horizon (PlanGoals.
//                        horizon), whatever length is on show: what every goal
//                        status is read from
//   Runs.allForGoals()   Runs.all() over the goal horizon

(function () {
    const goalYears = () => window.PlanGoals.HORIZON_YEARS;

    const cache = new Map();   // `${plan id}|${years}` → { updatedAt, results }

    /** One plan's results over `years`, or null if the engine failed on it. */
    function of(plan, years) {
        if (years === PlanStore.state.years && plan === PlanStore.state.plan && PlanStore.state.results) return PlanStore.state.results;
        const key = `${plan.id}|${years}`;
        const hit = cache.get(key);
        if (hit && hit.updatedAt === plan.updatedAt) return hit.results;
        let results = null;
        try {
            results = window.PlanEngine.simulate(PlanStore.atLength(plan, years));
        } catch (e) {
            console.error('[runs] simulation failed', plan.id, e);
        }
        cache.set(key, { updatedAt: plan.updatedAt, results });
        return results;
    }

    function all({ years = null } = {}) {
        return PlanStore.state.tabs.map((id) => PlanStore.getPlan(id)).filter(Boolean)
            .map((plan) => ({ plan, results: of(plan, years ?? PlanStore.state.years ?? plan.settings.years) }));
    }

    // A deleted plan's runs go with it.
    PlanStore.on((c) => {
        if (c.type !== 'tabs') return;
        for (const key of cache.keys()) {
            if (!PlanStore.state.tabs.includes(key.slice(0, key.lastIndexOf('|')))) cache.delete(key);
        }
    });

    const forGoals = (plan) => of(plan, goalYears());
    const allForGoals = () => all({ years: goalYears() });

    window.Runs = { all, forGoals, allForGoals };
}());
