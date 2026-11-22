'use strict';

// ─── summary.js ─────────────────────────────────────────────────────────────
// A run of the engine, summed up the way people read it. Analyze shows these
// figures and the exports (CSV, the PDF report) write them, so both say the
// same thing.
//
//   headline(res, def)        net worth at the end, its change, take-home pay,
//                             spent, growth and interest over the whole run
//   years(plan, res, def)     the same per plan year, with the age it starts
//                             at and the net worth it ends on
//   months(plan, res)         one row per month: its flows and the balances
//                             it ends on
//
// `def` scales the money at each balance point (PlanGoals.deflator); it is
// optional and all 1s by default, the money of each month. A month's flow
// lands at the end of the month, balance point m + 1.
//
// Pure, like the engine. Dual-environment: window.PlanSummary in the page,
// CommonJS for the tests and the browser backend's exports.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const Plan = isNode ? require('./plan.js') : root.PlanModel;
    const api = factory(Plan);
    if (isNode) module.exports = api;
    else root.PlanSummary = api;
}(typeof self !== 'undefined' ? self : this, function (Plan) {

    const ones = (res) => new Float64Array(res.months + 1).fill(1);

    // The flows each summary adds up, by month m.
    const takeHome = (F, m) => F.earned[m] - F.withheld[m];
    const spent = (F, m) => F.spent[m] + F.skimmed[m];

    /** Sum `fn(m)` over months [from, to), each at the money of the month it lands in. */
    function sumMonths(from, to, def, fn) {
        let s = 0;
        for (let m = from; m < to; m++) s += fn(m) * def[m + 1];
        return s;
    }

    /** The run's headline figures. */
    function headline(res, def = ones(res)) {
        const n = res.months;
        const F = res.flows;
        const start = res.netWorth[0] * def[0];
        const end = res.netWorth[n] * def[n];
        return {
            start, end, change: end - start,
            takeHome: sumMonths(0, n, def, (m) => takeHome(F, m)),
            spent: sumMonths(0, n, def, (m) => spent(F, m)),
            growth: sumMonths(0, n, def, (m) => F.growth[m]),
            interest: sumMonths(0, n, def, (m) => F.interest[m]),
        };
    }

    /** A row per plan year (the last may be short), in plan order. */
    function years(plan, res, def = ones(res)) {
        const n = res.months;
        const F = res.flows;
        const rows = [];
        for (let from = 0, y = 0; from < n; from += 12, y++) {
            const to = Math.min(n, from + 12);
            const start = res.netWorth[from] * def[from];
            const end = res.netWorth[to] * def[to];
            rows.push({
                year: y + 1, from, to,
                age: Plan.ageAt(plan, Plan.ymAdd(plan.settings.start, from)),
                takeHome: sumMonths(from, to, def, (m) => takeHome(F, m)),
                spent: sumMonths(from, to, def, (m) => spent(F, m)),
                growth: sumMonths(from, to, def, (m) => F.growth[m]),
                interest: sumMonths(from, to, def, (m) => F.interest[m]),
                change: end - start,
                worth: end,
            });
        }
        return rows;
    }

    /**
     * Every month as { columns, rows }: the month ('YYYY-MM'), its flows, the
     * net worth and each account's and debt's balance it ends on (debts as
     * what is owed), with the value of each asset a loan is secured by. Values are numbers rounded to the cent; a column a plan
     * cannot fill (age without a person) holds null.
     */
    function months(plan, res) {
        const F = res.flows;
        const holders = plan.nodes.filter((nd) => {
            const role = Plan.roleOf(nd);
            return (role === 'account' || role === 'debt') && res.nodes[nd.id];
        });
        const assets = holders.filter((nd) => res.nodes[nd.id].assetValue);
        const hasUnassigned = res.unassigned.some((v) => Math.abs(v) > 0.005);
        const hasAge = plan.settings.age != null;
        const columns = [
            'Month', ...(hasAge ? ['Age'] : []),
            'Take-home pay', 'Withheld', 'Employer match', 'Cash back', 'Spent', 'Taxes and fees', 'Growth', 'Interest',
            'Net worth',
            ...holders.map((nd) => `${nd.name} (${Plan.roleOf(nd) === 'debt' ? 'owed' : 'balance'})`),
            ...assets.map((nd) => `${nd.name} (asset value)`),
            ...(hasUnassigned ? ['Unassigned'] : []),
        ];
        const cents = (v) => Math.round(v * 100) / 100 || 0;
        const rows = [];
        for (let m = 0; m < res.months; m++) {
            const ym = Plan.ymAdd(plan.settings.start, m);
            rows.push([
                ym, ...(hasAge ? [Plan.ageAt(plan, ym)] : []),
                cents(takeHome(F, m)), cents(F.withheld[m]), cents(F.match[m]), cents(F.cashback[m]),
                cents(F.spent[m]), cents(F.skimmed[m]), cents(F.growth[m]), cents(F.interest[m]),
                cents(res.netWorth[m + 1]),
                ...holders.map((nd) => cents(res.nodes[nd.id].balance[m + 1])),
                ...assets.map((nd) => cents(res.nodes[nd.id].assetValue[m + 1])),
                ...(hasUnassigned ? [cents(res.unassigned[m + 1])] : []),
            ]);
        }
        return { columns, rows };
    }

    return { headline, years, months };
}));
