'use strict';

// ─── example.js ─────────────────────────────────────────────────────────────
// The example plan: a salary that pays rent, groceries and a car loan, with
// the rest going into savings, for someone who is 30. It is what "Load
// example" draws on an empty plan's card.
//
// Laid out left to right in two columns: the salary, and the four places it
// goes.

(function () {
    const P = window.PlanModel;

    const COL = 280;
    const ROW = 170;

    /** Add the example's modules and links to `plan` (which may be empty). */
    function fill(plan, origin = { x: 0, y: 0 }) {
        const at = (col, y, type, name, params = {}, icon = null) => {
            const n = P.createNode(plan, type, origin.x + col * COL, origin.y + y);
            n.name = name;
            Object.assign(n.params, params);
            if (icon) n.icon = icon;
            plan.nodes.push(n);
            return n;
        };
        const link = (from, to, rule) => {
            const l = P.createLink(plan, from.id, to.id);
            Object.assign(l, rule);
            plan.links.push(l);
            return l;
        };

        // A plan that already has an age keeps it.
        if (plan.settings.age == null) plan.settings.age = 30;
        const salary = at(0, ROW * 1.5, 'salary', 'Salary', { amount: 65000, per: 'year', growth: 3, tax: 22 });
        const rent = at(1, 0, 'expense', 'Rent', {}, 'house');
        const groceries = at(1, ROW, 'expense', 'Groceries', {}, 'basket');
        const carLoan = at(1, ROW * 2, 'loan', 'Car loan', { balance: 18000, rate: 6.5 }, 'car-profile');
        const savings = at(1, ROW * 3, 'bank-account', 'Savings', { balance: 5000, rate: 4 });

        link(salary, rent, { mode: 'fixed', value: 1750 });
        link(salary, groceries, { mode: 'fixed', value: 600 });
        link(salary, carLoan, { mode: 'fixed', value: 352 });
        link(salary, savings, { mode: 'rest', value: 0 });

        return plan;
    }

    window.PlanExample = { fill };
}());
