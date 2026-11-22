'use strict';

// The simulator's rules, one scenario each. Every scenario also passes the
// conservation check: the change in net worth must equal the money that
// entered minus the money that left, so no rule can create or lose money.

const test = require('node:test');
const assert = require('node:assert/strict');

const Catalog = require('../../../static/js/plan/sim/catalog.js');
const Plan = require('../../../static/js/plan/sim/plan.js');
const { simulate } = require('../../../static/js/plan/sim/engine.js');

// ── Builders ─────────────────────────────────────────────────────────────────

function mkPlan(start = '2026-01', years = 1) {
    return {
        id: 'p_test', name: 'Test', version: 1,
        settings: { start, years, inflation: 0 },
        view: { x: 0, y: 0, zoom: 1 },
        nodes: [], links: [],
    };
}

function node(plan, type, params = {}) {
    const p = Catalog.preset(type);
    const n = {
        id: `n_${plan.nodes.length}`, type, name: p.name, x: 0, y: 0,
        params: { ...Catalog.defaultParams(p), ...params },
    };
    plan.nodes.push(n);
    return n;
}

function link(plan, from, to, rule = {}) {
    const l = {
        id: `l_${plan.links.length}`, from: from.id, to: to.id,
        mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1,
        date: null, start: null, end: null, growth: 0, ...rule,
    };
    plan.links.push(l);
    return l;
}

/** Validate (as the backend would), simulate, and check conservation. */
function run(plan) {
    const r = simulate(Plan.validatePlan(plan));
    const T = r.totals;
    const delta = T.endNetWorth - T.startNetWorth;
    const expected = T.earned - T.withheld + T.match + T.cashback + T.growth + T.acquired
        - T.interest - T.spent - T.skimmed;
    assert.ok(Math.abs(delta - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
        `money not conserved: net worth moved ${delta}, flows explain ${expected}`);
    return r;
}

const close = (actual, expected, tol = 1e-6) =>
    assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
        `expected ${expected}, got ${actual}`);

const last = (arr) => arr[arr.length - 1];
const codes = (r) => r.warnings.map((w) => w.code);

// ── Growth ───────────────────────────────────────────────────────────────────

test('an account rate is an APY: 4% grows exactly 4% in twelve months', () => {
    const plan = mkPlan('2026-01', 1);
    const acct = node(plan, 'bank-account', { balance: 10000, rate: 4 });
    const r = run(plan);
    close(last(r.nodes[acct.id].balance), 10400);
    close(r.totals.growth, 400);
});

test('a debt APR is charged monthly at APR/12, and an unpaid debt is flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const debt = node(plan, 'credit-card', { balance: 1000, rate: 12, cashBack: 0 });
    const r = run(plan);
    close(r.nodes[debt.id].balance[1], 1010);
    close(last(r.nodes[debt.id].balance), 1000 * Math.pow(1.01, 12));
    assert.ok(codes(r).includes('debt-growing'));
});

// ── Income ───────────────────────────────────────────────────────────────────

test('income schedules: weekly, biweekly, yearly spread, yearly lump, once', () => {
    const plan = mkPlan('2026-01', 1);
    const sink = node(plan, 'expense');
    const cases = [
        [{ amount: 100, per: 'week' }, 100 * 52],
        [{ amount: 100, per: 'biweek' }, 100 * 26],
        [{ amount: 1200, per: 'year' }, 1200],
        [{ amount: 1200, per: 'year', payMonth: 6 }, 1200],
        [{ amount: 500, per: 'once', start: '2026-03' }, 500],
    ];
    const ids = cases.map(([params]) => {
        const s = node(plan, 'paycheck', params);
        link(plan, s, sink);
        return s.id;
    });
    const r = run(plan);
    cases.forEach(([, expected], i) => close(r.nodes[ids[i]].totals.produced, expected));
    // The lump lands in its month only.
    const lump = r.nodes[ids[3]].produced;
    assert.equal(lump[5], 1200);
    assert.equal(lump[4], 0);
});

test('withholding, raises and an income window', () => {
    const plan = mkPlan('2026-01', 3);
    const sink = node(plan, 'expense');
    const salary = node(plan, 'salary', {
        amount: 1000, per: 'month', growth: 10, tax: 20, start: '2026-04', stopBy: 'date', end: '2027-06',
    });
    link(plan, salary, sink);
    const r = run(plan);
    const net = r.nodes[salary.id].produced;
    assert.equal(net[2], 0);
    close(net[3], 800);       // first month of the window: 1000 less 20%
    close(net[14], 800);      // still the first year of this income
    close(net[15], 880);      // a year after it started: the 10% raise
    close(net[17], 880);      // the window's last month is paid
    assert.equal(net[18], 0); // window over
    close(r.totals.withheld, r.totals.earned * 0.2);
});

// ── Splitting ────────────────────────────────────────────────────────────────

test('fixed amounts are paid first, percentages are of the full amount, rest takes what is left', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 5000, per: 'month' });
    const rent = node(plan, 'expense');
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const fun = node(plan, 'expense');
    // Declared rest-first on purpose: evaluation order is by mode, not by list.
    const lRest = link(plan, pay, fun, { mode: 'rest' });
    const lPct = link(plan, pay, savings, { mode: 'percent', value: 20 });
    const lFix = link(plan, pay, rent, { mode: 'fixed', value: 1500 });
    const r = run(plan);
    close(r.links[lFix.id].flow[0], 1500);
    close(r.links[lPct.id].flow[0], 1000);
    close(r.links[lRest.id].flow[0], 2500);
    close(last(r.nodes[savings.id].balance), 12000);
});

test('over-allocation shortchanges the later links and says so', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const a = node(plan, 'expense');
    const b = node(plan, 'expense');
    link(plan, pay, a, { mode: 'fixed', value: 800 });
    const lb = link(plan, pay, b, { mode: 'percent', value: 50 });
    const r = run(plan);
    close(r.links[lb.id].flow[0], 200);
    const short = r.warnings.find((w) => w.code === 'short');
    assert.equal(short.linkId, lb.id);
    close(short.amount, 300 * 12);
});

test('percentages over 100% are flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    link(plan, pay, node(plan, 'expense'), { mode: 'percent', value: 70 });
    link(plan, pay, node(plan, 'expense'), { mode: 'percent', value: 50 });
    const r = run(plan);
    assert.ok(codes(r).includes('over-100'));
});

test('money with no link lands in Unassigned and still counts toward net worth', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    link(plan, pay, node(plan, 'expense'), { mode: 'percent', value: 30 });
    const r = run(plan);
    close(last(r.unassigned), 700 * 12);
    close(r.totals.endNetWorth, 700 * 12);
    assert.ok(codes(r).includes('unassigned'));
});

test('a fixed amount from income that ends is reported short, not silently dropped', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 3000, per: 'month', stopBy: 'date', end: '2026-06' });
    const rent = node(plan, 'expense');
    const l = link(plan, pay, rent, { mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(r.links[l.id].total, 6000);
    const short = r.warnings.find((w) => w.code === 'short' && w.linkId === l.id);
    close(short.amount, 6000);
    assert.equal(short.month, 6);
});

test('a fixed link fed by two arrivals in one month is topped up, not double paid', () => {
    const plan = mkPlan('2026-01', 1);
    const a = node(plan, 'paycheck', { amount: 300, per: 'month' });
    const b = node(plan, 'paycheck', { amount: 300, per: 'month', tax: 0 });
    const living = node(plan, 'living');
    const rent = node(plan, 'expense');
    link(plan, a, living);
    link(plan, b, living);
    const toCard = link(plan, living, rent, { mode: 'fixed', value: 500 });
    const r = run(plan);
    close(r.links[toCard.id].flow[0], 500);
    assert.ok(!r.warnings.some((w) => w.code === 'short'));
});

// ── Accounts ─────────────────────────────────────────────────────────────────

test('an account keeps what arrives: only its balance moves on', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 4000, per: 'month' });
    const checking = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const rent = node(plan, 'expense');
    link(plan, pay, checking);
    const l = link(plan, checking, rent, { basis: 'balance', mode: 'fixed', value: 1500 });
    const r = run(plan);
    close(r.links[l.id].total, 18000);
    close(last(r.nodes[checking.id].balance), 2500 * 12);
});

test('a fixed link out of a balance keeps paying past zero and says when the account is overdrawn', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'date', end: '2026-02' });
    const checking = node(plan, 'bank-account', { balance: 2000, rate: 0 });
    const rent = node(plan, 'expense');
    link(plan, pay, checking);
    const l = link(plan, checking, rent, { basis: 'balance', mode: 'fixed', value: 1500 });
    const r = run(plan);
    close(r.links[l.id].total, 12 * 1500);
    close(last(r.nodes[checking.id].balance), 2000 + 2000 - 12 * 1500);
    assert.ok(!r.warnings.some((w) => w.code === 'short' && w.linkId === l.id));
    // 2,000 + 1,000 - 1,500 a month for two months, then -1,500 a month: March ends at -500.
    const over = r.warnings.find((w) => w.code === 'overdrawn' && w.nodeId === checking.id);
    assert.equal(over.month, 2);
    close(over.amount, 14000);
});

test('an overdrawn account earns nothing, and shares of its balance take nothing from it', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'bank-account', { balance: 1000, rate: 12 });
    const rent = node(plan, 'expense');
    const other = node(plan, 'expense');
    const leftover = node(plan, 'expense');
    link(plan, savings, rent, { basis: 'balance', mode: 'fixed', value: 2000, when: 'once', date: '2026-01' });
    const share = link(plan, savings, other, { basis: 'balance', mode: 'percent', value: 10 });
    const rest = link(plan, savings, leftover, { basis: 'balance', mode: 'rest' });
    const r = run(plan);
    // January's growth lands before the draw (step 2, then step 4). Fixed
    // amounts go first, so the 2,000 overdraws it and the share and the rest
    // find nothing to take, that month or after; nor does it earn again.
    const jan = 1000 * (Math.pow(1.12, 1 / 12) - 1);
    close(r.nodes[savings.id].totals.earnings, jan);
    close(r.links[share.id].total, 0);
    close(r.links[rest.id].total, 0);
    close(last(r.nodes[savings.id].balance), 1000 + jan - 2000);
});

test('interest stays in the account and compounds', () => {
    const plan = mkPlan('2026-01', 1);
    const brokerage = node(plan, 'investment', { balance: 100000, rate: 12 });
    const r = run(plan);
    close(last(r.nodes[brokerage.id].balance), 112000);
    close(r.nodes[brokerage.id].totals.earnings, 12000);
    close(r.totals.unassigned, 0);
});

test('a percent of balance every year: the 4% rule', () => {
    const plan = mkPlan('2026-01', 2);
    const nest = node(plan, 'investment', { balance: 1000000, rate: 0 });
    const living = node(plan, 'expense');
    const l = link(plan, nest, living, { basis: 'balance', mode: 'percent', value: 4, when: 'yearly', month: 1 });
    const r = run(plan);
    close(r.links[l.id].flow[0], 40000);
    close(r.links[l.id].flow[12], 38400);
});

test('an account keeps its minimum: the rest sweeps only what is over it', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0, minBalance: 5000 });
    const brokerage = node(plan, 'investment', { balance: 0, rate: 0 });
    link(plan, pay, savings);
    const sweep = link(plan, savings, brokerage, { basis: 'balance', mode: 'rest' });
    const r = run(plan);
    // It fills up to $5,000 first (five months), then passes each paycheck on.
    assert.equal(r.links[sweep.id].flow.slice(0, 5).reduce((a, b) => a + b, 0), 0);
    close(last(r.nodes[savings.id].balance), 5000);
    close(last(r.nodes[brokerage.id].balance), 7000);
    // Filling up to the minimum is not going below it.
    assert.ok(!r.warnings.some((w) => w.code === 'below-minimum'));
});

test('shares out of an account are of what is over its minimum: 50/30/20 of each paycheck', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 5000, per: 'month' });
    const checking = node(plan, 'bank-account', { balance: 4000, rate: 0, minBalance: 4000 });
    const needs = node(plan, 'expense');
    const wants = node(plan, 'expense');
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    link(plan, pay, checking);
    const a = link(plan, checking, needs, { basis: 'balance', mode: 'percent', value: 50 });
    const b = link(plan, checking, wants, { basis: 'balance', mode: 'percent', value: 30 });
    const c = link(plan, checking, savings, { basis: 'balance', mode: 'percent', value: 20 });
    const r = run(plan);
    close(r.links[a.id].flow[0], 2500);
    close(r.links[b.id].flow[0], 1500);
    close(r.links[c.id].flow[0], 1000);
    for (const v of r.nodes[checking.id].balance) close(v, 4000);
});

test('a fixed bill is paid past an account\'s minimum, and the plan says when it goes below', () => {
    const plan = mkPlan('2026-01', 1);
    const checking = node(plan, 'bank-account', { balance: 6000, rate: 0, minBalance: 4000 });
    const rent = node(plan, 'expense');
    const fun = node(plan, 'expense');
    const bill = link(plan, checking, rent, { basis: 'balance', mode: 'fixed', value: 1500 });
    const share = link(plan, checking, fun, { basis: 'balance', mode: 'rest' });
    const r = run(plan);
    close(r.links[bill.id].total, 12 * 1500);
    // January: rent leaves 4,500, and the rest takes the 500 over the minimum.
    close(r.links[share.id].total, 500);
    const dip = r.warnings.find((w) => w.code === 'below-minimum' && w.nodeId === checking.id);
    assert.equal(dip.month, 1);
    close(dip.amount, 4000);
});

test('a link set to an expense\'s cost pays it, rising by its inflation each year', () => {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 5000, per: 'month' });
    const rent = node(plan, 'expense', { cost: 1000, per: 'month', growth: 10 });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const l = link(plan, pay, rent, { mode: 'cost' });
    link(plan, pay, savings);
    const r = run(plan);
    close(r.links[l.id].flow[0], 1000);
    close(r.links[l.id].flow[11], 1000);
    close(r.links[l.id].flow[12], 1100);
    close(r.totals.spent, 12 * 1000 + 12 * 1100);
    assert.ok(!r.warnings.some((w) => w.code === 'cost-uncovered'));
});

test('a cost follows the expense\'s schedule: a yearly lump in its month, a one-off on its date', () => {
    const plan = mkPlan('2026-01', 2);
    const checking = node(plan, 'bank-account', { balance: 50000, rate: 0 });
    const insurance = node(plan, 'expense', { cost: 1200, per: 'year', payMonth: 3 });
    const wedding = node(plan, 'expense', { cost: 20000, per: 'once', start: '2027-06' });
    const yearly = link(plan, checking, insurance, { basis: 'balance', mode: 'cost' });
    const once = link(plan, checking, wedding, { basis: 'balance', mode: 'cost' });
    const r = run(plan);
    const months = (l) => [...r.links[l.id].flow].map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(months(yearly), [2, 14]);
    assert.deepEqual(months(once), [17]);
    close(r.links[once.id].total, 20000);
});

test('a cost is a fixed amount: it overdraws an account, and falls short from income', () => {
    const plan = mkPlan('2026-01', 1);
    const checking = node(plan, 'bank-account', { balance: 500, rate: 0 });
    const rent = node(plan, 'expense', { cost: 1000, per: 'month' });
    const pay = node(plan, 'paycheck', { amount: 300, per: 'month' });
    const food = node(plan, 'expense', { cost: 400, per: 'month' });
    const fromBalance = link(plan, checking, rent, { basis: 'balance', mode: 'cost' });
    const fromPay = link(plan, pay, food, { mode: 'cost' });
    const r = run(plan);
    close(r.links[fromBalance.id].total, 12 * 1000);
    assert.ok(r.warnings.some((w) => w.code === 'overdrawn' && w.nodeId === checking.id));
    const short = r.warnings.find((w) => w.code === 'short' && w.linkId === fromPay.id);
    close(short.amount, 12 * 100);
});

test('a card can be charged an expense\'s cost', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 0 });
    const gas = node(plan, 'expense', { cost: 150, per: 'month' });
    const l = link(plan, card, gas, { basis: 'charges', mode: 'cost' });
    const r = run(plan);
    close(r.links[l.id].total, 12 * 150);
    close(last(r.nodes[card.id].balance), 12 * 150);
});

test('an expense whose inflow does not cover its cost is a notice, however the money is linked', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const short = node(plan, 'expense', { cost: 300, per: 'month' });
    const fixed = node(plan, 'expense', { cost: 300, per: 'month' });
    const share = node(plan, 'expense', { cost: 300, per: 'month' });
    const blank = node(plan, 'expense');
    link(plan, pay, short, { mode: 'percent', value: 20 });
    link(plan, pay, fixed, { mode: 'fixed', value: 300 });
    link(plan, pay, share, { mode: 'percent', value: 30 });
    const none = link(plan, pay, blank, { mode: 'cost' });
    const r = run(plan);
    const w = (n) => r.warnings.find((x) => x.code === 'cost-uncovered' && x.nodeId === n.id);
    close(w(short).amount, 12 * 100);
    assert.ok(!w(fixed));
    assert.ok(!w(share));
    assert.ok(!w(blank));
    assert.equal(r.links[none.id].total, 0);
    assert.ok(!r.warnings.some((x) => x.code === 'short' && x.linkId === none.id));
});

test('an expense with a cost and no inflow at all does not cover it', () => {
    const plan = mkPlan('2026-01', 1);
    const rent = node(plan, 'expense', { cost: 1000, per: 'month' });
    const r = run(plan);
    const w = r.warnings.find((x) => x.code === 'cost-uncovered' && x.nodeId === rent.id);
    close(w.amount, 12000);
});

test('a locked account moves nothing until it unlocks', () => {
    const plan = mkPlan('2026-01', 2);
    const cd = node(plan, 'term-deposit', { balance: 10000, rate: 0, lockUntil: '2027-01' });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const l = link(plan, cd, savings, { basis: 'balance', mode: 'rest' });
    const r = run(plan);
    assert.equal(r.links[l.id].flow.slice(0, 12).reduce((a, b) => a + b, 0), 0);
    close(r.links[l.id].flow[12], 10000);
    assert.ok(r.milestones.some((m) => m.code === 'unlocks' && m.month === 12));
});

test('a yearly deposit limit parks the excess in Unassigned', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const ira = node(plan, '401k', { balance: 0, rate: 0, capYearly: 7000 });
    link(plan, pay, ira, { mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(last(r.nodes[ira.id].balance), 7000);
    close(last(r.unassigned), 5000);
    assert.ok(codes(r).includes('cap'));
});

test('a yearly limit an account does not show is not applied', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const brokerage = node(plan, 'investment', { balance: 0, rate: 0, capYearly: 1000 });
    link(plan, pay, brokerage);
    const r = run(plan);
    close(last(r.nodes[brokerage.id].balance), 12000);
});

test('a locked Investment sends nothing from its balance until it unlocks', () => {
    const plan = mkPlan('2026-01', 1);
    const brokerage = node(plan, 'investment', { balance: 10000, rate: 0, lockUntil: '2026-07' });
    const checking = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const l = link(plan, brokerage, checking, { basis: 'balance', mode: 'fixed', value: 1000 });
    const r = run(plan);
    assert.equal(r.links[l.id].flow.slice(0, 6).reduce((a, b) => a + b, 0), 0);
    close(r.links[l.id].total, 6000);
});

// ── Debts ────────────────────────────────────────────────────────────────────

test('a paid-off debt passes later payments on: the snowball', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 500, per: 'month' });
    const small = node(plan, 'loan', { balance: 1000, rate: 0 });
    const big = node(plan, 'loan', { balance: 5000, rate: 0 });
    link(plan, pay, small, { mode: 'fixed', value: 500 });
    link(plan, small, big, { mode: 'rest' });
    const r = run(plan);
    assert.equal(r.nodes[small.id].balance[2], 0);
    close(r.nodes[big.id].balance[3], 4500);
    close(last(r.nodes[big.id].balance), 0);
    const paidOff = r.milestones.filter((m) => m.code === 'paid-off').map((m) => [m.nodeId, m.month]);
    assert.deepEqual(paidOff, [[small.id, 1], [big.id, 11]]);
});

test('a loan is paid what its link is set to, and nothing past what is owed', () => {
    const plan = mkPlan('2026-01', 3);
    const pay = node(plan, 'paycheck', { amount: 2000, per: 'month' });
    const loan = node(plan, 'loan', { balance: 20000, rate: 7 });
    const savings = node(plan, 'bank-account');
    link(plan, pay, loan, { mode: 'fixed', value: 1000 });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.links.l_0.flow[0], 1000);
    assert.ok(r.links.l_0.flow[35] === 0, 'the payment stops once the loan is cleared');
    assert.ok(Math.abs(last(r.nodes[loan.id].balance)) < 1e-4);
    assert.ok(!codes(r).includes('short'));
});

test('payments stop at payoff and the freed money falls to the payer\'s rest', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const loan = node(plan, 'loan', { balance: 1000, rate: 0 });
    const savings = node(plan, 'bank-account');
    link(plan, pay, loan, { mode: 'fixed', value: 400 });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.nodes[loan.id].totals.paid, 1000);           // 400 + 400 + 200
    close(last(r.nodes[savings.id].balance), 12000 - 1000);
    close(r.totals.unassigned, 0);
    assert.ok(!codes(r).includes('short'));
});

test('withdrawals from a balance stop at payoff too', () => {
    const plan = mkPlan('2026-01', 1);
    const checking = node(plan, 'bank-account', { balance: 5000 });
    const loan = node(plan, 'loan', { balance: 900, rate: 0 });
    link(plan, checking, loan, { basis: 'balance', mode: 'fixed', value: 500 });
    const r = run(plan);
    close(last(r.nodes[checking.id].balance), 4100);
    close(r.totals.unassigned, 0);
});

test('a card paid its purchases each month is never charged interest', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 3000, per: 'month' });
    const card = node(plan, 'credit-card', { balance: 0, rate: 24 });
    const dining = node(plan, 'expense');
    const savings = node(plan, 'bank-account');
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 800 });
    link(plan, pay, card, { mode: 'fixed', value: 800 });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.interest, 0);
    close(last(r.nodes[card.id].balance), 0);
    close(last(r.nodes[savings.id].balance), 12 * 2200);
});

test('a loan dated inside the plan pays out its proceeds: borrowing leaves net worth unchanged', () => {
    const plan = mkPlan('2026-01', 1);
    const checking = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const loan = node(plan, 'loan', { balance: 240000, rate: 0, start: '2026-03' });
    link(plan, loan, checking, { basis: 'proceeds', mode: 'rest', when: 'once' });
    const r = run(plan);
    close(r.nodes[checking.id].balance[3], 240000);
    close(r.nodes[loan.id].balance[3], 240000);
    assert.equal(r.nodes[loan.id].balance[2], 0);
    close(r.netWorth[3], 0);
});

// ── Income that stops ────────────────────────────────────────────────────────

test('a salary set to stop on a date pays through its Last paid month and no further', () => {
    const plan = mkPlan('2026-01', 2);
    const salary = node(plan, 'salary', { amount: 12000, per: 'year', stopBy: 'date', end: '2026-06' });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    link(plan, salary, savings);
    const r = run(plan);
    close(r.nodes[salary.id].gross[5], 1000);       // June
    close(r.nodes[salary.id].gross[6], 0);          // July
    close(r.totals.earned, 6000);
    assert.ok(r.milestones.some((m) => m.code === 'stops' && m.nodeId === salary.id && m.month === 5));
});

test('a paycheck set to stop at an age pays until the month the person turns it', () => {
    const plan = mkPlan('2026-01', 3);
    plan.settings.age = 63.5;                       // turns 65 eighteen months in
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'age', endAge: 65 });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    link(plan, pay, savings);
    const r = run(plan);
    close(r.nodes[pay.id].gross[17], 1000);
    close(r.nodes[pay.id].gross[18], 0);
    close(r.totals.earned, 18000);
    assert.ok(r.milestones.some((m) => m.code === 'stops' && m.month === 17));
});

test('an age stop in a plan with no age runs on and is flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'age', endAge: 65 });
    link(plan, pay, node(plan, 'bank-account', { balance: 0, rate: 0 }));
    const r = run(plan);
    close(r.totals.earned, 12000);
    assert.ok(r.warnings.some((w) => w.code === 'stop-no-age' && w.nodeId === pay.id));
});

test('an income that stops before the plan starts pays nothing and is flagged', () => {
    const plan = mkPlan('2026-01', 1);
    plan.settings.age = 70;
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'age', endAge: 65 });
    link(plan, pay, node(plan, 'bank-account', { balance: 0, rate: 0 }));
    const r = run(plan);
    close(r.totals.earned, 0);
    assert.ok(r.warnings.some((w) => w.code === 'stopped-before' && w.nodeId === pay.id));
});

test('a stop setting left on Never, or with no date or age filled in, runs for the whole plan', () => {
    const plan = mkPlan('2026-01', 1);
    plan.settings.age = 40;
    const a = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'never', end: '2026-03', endAge: 41 });
    const b = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'date', end: null });
    const c = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'age', endAge: null });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    for (const n of [a, b, c]) link(plan, n, savings);
    const r = run(plan);
    close(r.totals.earned, 36000);
    assert.ok(!r.milestones.some((m) => m.code === 'stops'));
    assert.ok(!r.warnings.some((w) => w.code.startsWith('stop')));
});

// ── Two-way links ────────────────────────────────────────────────────────────

/** Pay of 3,000 a month that stops after 2026; rent of 1,500 from Checking,
 *  which keeps 1,000; Checking and a fund joined by a two-way link that saves
 *  the rest and sends back `back`, which by default starts at 41 (January
 *  2027, the plan's person being 40). */
function twoWayPlan(back = {}, years = 3) {
    const plan = mkPlan('2026-01', years);
    plan.settings.age = 40;
    const pay = node(plan, 'paycheck', { amount: 3000, per: 'month', stopBy: 'date', end: '2026-12' });
    const chk = node(plan, 'bank-account', { balance: 0, rate: 0, minBalance: 1000 });
    const fund = node(plan, 'investment', { balance: 0, rate: 0 });
    link(plan, pay, chk);
    link(plan, chk, node(plan, 'expense'), { basis: 'balance', mode: 'fixed', value: 1500 });
    const l = link(plan, chk, fund, { basis: 'balance', mode: 'rest' });
    l.back = { mode: 'fixed', value: 1500, when: 'monthly', month: 1, date: null, growth: 0,
        startWhen: { kind: 'age', age: 41 }, ...back };
    return { plan, pay, chk, fund, l };
}

test('a way back that starts at an age sends nothing before it, then its amount', () => {
    const { plan, chk, fund, l } = twoWayPlan();
    const r = run(plan);
    const lr = r.links[l.id];
    assert.equal(lr.started, undefined);                // the way out starts now
    assert.equal(lr.back.started, 12);                  // January 2027, at 41
    close(lr.back.flow[11], 0);
    close(lr.back.flow[12], 1500);
    close(r.nodes[fund.id].balance[12], 500 + 11 * 1500);   // the first month fills Checking to its 1,000
    close(r.nodes[chk.id].balance[18], 1000);           // the way back pays the rent
    assert.ok(!r.warnings.some((w) => w.code === 'no-start'));
});

test('a side\'s fixed amount rises each year from its start', () => {
    const { plan, l } = twoWayPlan({ growth: 10 }, 3);
    const r = run(plan);
    close(r.links[l.id].back.flow[12], 1500);
    close(r.links[l.id].back.flow[24], 1650);
});

test('a two-way link can send back a share of the balance, yearly', () => {
    const { plan, l } = twoWayPlan({ mode: 'percent', value: 10, when: 'yearly', month: 1 });
    const r = run(plan);
    close(r.links[l.id].back.flow[12], 1700);           // 10% of 17,000 in January 2027
    close(r.links[l.id].back.flow[13], 0);
});

test('pay that stops at an age and a way back that starts at it leave no gap, monthly or yearly', () => {
    for (const when of ['monthly', 'yearly']) {
        const { plan, pay, chk, l } = twoWayPlan({ when, value: 12000 });
        plan.settings.age = 40 + 2 / 12;                // 41 in November 2026 (month 10)
        Object.assign(pay.params, { stopBy: 'age', endAge: 41, end: null });
        const r = run(plan);
        const payFlow = r.links[plan.links[0].id].flow;
        const back = r.links[l.id].back.flow;
        assert.ok(payFlow[9] > 0, `${when}: the last pay is in October`);
        close(payFlow[10], 0);
        close(back[9], 0);
        close(back[10], 12000);                         // sent back the month the pay stops
        close(back[11], when === 'monthly' ? 12000 : 0);
        close(back[22], 12000);                         // and a year on
        assert.ok(r.nodes[chk.id].balance[12] >= 1000, `${when}: Checking keeps its 1,000`);
    }
});

test('a way back starts when an account reaches a size, and keeps running', () => {
    // The fund gets 500, then 1,500 a month: 11,000 at the end of August 2026.
    const { plan, fund, l } = twoWayPlan({ value: 100, startWhen: { kind: 'balance', account: null, amount: 10000 } });
    l.back.startWhen.account = fund.id;
    const r = run(plan);
    const back = r.links[l.id].back;
    assert.equal(back.started, 8);
    close(back.flow[7], 0);
    close(back.flow[8], 100);
    close(back.flow[30], 100);                          // the fund drops below 10,000 later; it keeps going
});

test('a side sent once with a start is sent the month it starts, and only then', () => {
    const { plan, l } = twoWayPlan({ when: 'once', value: 5000 });
    const r = run(plan);
    close(r.links[l.id].back.flow[11], 0);
    close(r.links[l.id].back.flow[12], 5000);
    close(r.links[l.id].back.total, 5000);
});

test('a side sent once starting now goes on its own date', () => {
    const { plan, l } = twoWayPlan({ when: 'once', value: 5000, date: '2027-06', startWhen: null });
    const r = run(plan);
    close(r.links[l.id].back.flow[17], 5000);
    close(r.links[l.id].back.total, 5000);
});

test('a way back starting now runs side by side with the way out', () => {
    const { plan, fund, l } = twoWayPlan({ value: 100, startWhen: null });
    fund.params.balance = 10000;
    const r = run(plan);
    const lr = r.links[l.id];
    assert.equal(lr.back.started, undefined);
    close(lr.back.flow[0], 100);
    close(lr.back.flow[30], 100);
    assert.ok(lr.flow[5] > 0);
});

test('the way out can wait for a start of its own', () => {
    const { plan, l } = twoWayPlan({ startWhen: null, value: 0 });
    l.startWhen = { kind: 'age', age: 40.5 };           // July 2026
    const r = run(plan);
    assert.equal(r.links[l.id].started, 6);
    close(r.links[l.id].flow[5], 0);
    assert.ok(r.links[l.id].flow[6] > 0);
});

test('a side that never starts says why', () => {
    const why = (plan, l) => run(plan).warnings.filter((w) => w.code === 'no-start' && w.linkId === l.id).map((w) => [w.why, !!w.back]);
    const a = twoWayPlan();
    a.plan.settings.age = null;
    assert.deepEqual(why(a.plan, a.l), [['no-age', true]]);
    assert.equal(run(a.plan).links[a.l.id].back.started, null);
    const b = twoWayPlan({ startWhen: { kind: 'balance', account: null, amount: 1000 } });
    assert.deepEqual(why(b.plan, b.l), [['no-account', true]]);
    const c = twoWayPlan({ startWhen: { kind: 'balance', account: null, amount: 1e9 } });
    c.l.back.startWhen.account = c.fund.id;
    assert.deepEqual(why(c.plan, c.l), [['unreached', true]]);
    const d = twoWayPlan({ startWhen: { kind: 'retire' } });
    assert.deepEqual(why(d.plan, d.l), [['no-retire-age', true]]);
    d.plan.settings.retireAge = 41;
    d.plan.settings.age = null;
    assert.deepEqual(why(d.plan, d.l), [['no-age', true]]);
});

test('the retirement age goal stops a paycheck and starts the way back the same month', () => {
    const { plan, pay, l } = twoWayPlan({ startWhen: { kind: 'retire' } });
    Object.assign(pay.params, { stopBy: 'retire', end: null });
    plan.settings.retireAge = 41.5;                     // July 2027
    const r = run(plan);
    close(r.nodes[pay.id].gross[17], 3000);
    close(r.nodes[pay.id].gross[18], 0);
    assert.equal(r.links[l.id].back.started, 18);
    assert.ok(!r.warnings.some((w) => w.code === 'stop-no-retire-age' || w.code === 'no-start'));
});

test('the way out stops at retirement as the way back starts', () => {
    const { plan, pay, l } = twoWayPlan({ startWhen: { kind: 'retire' } });
    Object.assign(pay.params, { stopBy: 'date', end: null, amount: 3000 });
    pay.params.stopBy = 'never';
    l.stopWhen = { kind: 'retire' };
    plan.settings.retireAge = 41.5;                     // July 2027
    const r = run(plan);
    const lr = r.links[l.id];
    assert.equal(lr.stopped, 18);
    assert.equal(lr.back.started, 18);
    assert.ok(lr.flow.slice(0, 18).some((x) => x > 0));
    assert.ok(lr.flow.slice(18).every((x) => x === 0));
    assert.ok(lr.back.flow[18] > 0);
    assert.ok(!r.warnings.some((w) => w.code === 'no-stop'));
});

test('a side stops once an account reaches a size, and one that cannot stop says why', () => {
    const { plan, fund, l } = twoWayPlan();
    delete l.back;
    l.stopWhen = { kind: 'balance', account: fund.id, amount: 5000 };
    const r = run(plan);
    const lr = r.links[l.id];
    assert.ok(lr.stopped > 0);
    const reached = r.nodes[fund.id].balance.findIndex((b) => b >= 5000 - 1e-6);
    assert.equal(lr.stopped, reached);                  // checked at the top of the month after it got there
    assert.ok(lr.flow.slice(lr.stopped).every((x) => x === 0));
    const why = (p) => run(p).warnings.filter((w) => w.code === 'no-stop').map((w) => w.why);
    l.stopWhen = { kind: 'retire' };
    assert.deepEqual(why(plan), ['no-retire-age']);
    l.stopWhen = { kind: 'balance', account: null, amount: 5000 };
    assert.deepEqual(why(plan), ['no-account']);
    l.stopWhen = { kind: 'age', age: 90 };              // past the plan's end: runs on, nothing to flag
    assert.deepEqual(why(plan), []);
    assert.equal(run(plan).links[l.id].stopped, null);
});

test('a retirement stop in a plan with no retirement age runs on and is flagged', () => {
    const plan = mkPlan('2026-01', 1);
    plan.settings.age = 40;
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month', stopBy: 'retire' });
    link(plan, pay, node(plan, 'bank-account', { balance: 0, rate: 0 }));
    const r = run(plan);
    close(r.totals.earned, 12000);
    assert.ok(r.warnings.some((w) => w.code === 'stop-no-retire-age' && w.nodeId === pay.id));
    assert.ok(!r.warnings.some((w) => w.code === 'stop-no-age'));
});

test('the way back out of a locked account falls short until it unlocks', () => {
    const { plan, fund, l } = twoWayPlan();
    fund.params.lockUntil = '2027-04';
    const r = run(plan);
    close(r.links[l.id].back.flow[14], 0);
    close(r.links[l.id].back.flow[15], 1500);
    const short = r.warnings.find((w) => w.code === 'short' && w.back);
    assert.equal(short.linkId, l.id);
    assert.equal(short.nodeId, fund.id);
    assert.equal(short.month, 12);
});

// ── Assets a loan is secured by ──────────────────────────────────────────────

test('a mortgage\'s home counts toward net worth and appreciates, with nothing flowing through it', () => {
    const plan = mkPlan('2026-01', 2);
    const mortgage = node(plan, 'loan', { balance: 300000, rate: 0, asset: 400000, assetRate: 3 });
    const r = run(plan);
    const home = r.nodes[mortgage.id].assetValue;
    close(home[0], 400000);
    close(home[12], 412000);             // an effective annual rate, like an account's
    close(home[24], 400000 * 1.03 * 1.03);
    close(r.netWorth[0], 100000);        // the equity
    close(r.totals.growth, home[24] - 400000);
    close(r.nodes[mortgage.id].totals.assetGrowth, home[24] - 400000);
    close(r.totals.acquired, 0);         // owned before the plan began
    close(r.nodes[mortgage.id].totals.in, 0);
    close(r.nodes[mortgage.id].totals.out, 0);
});

test('a car loses value at a negative rate and stays after the loan is paid off', () => {
    const plan = mkPlan('2026-01', 3);
    const pay = node(plan, 'paycheck', { amount: 5000, per: 'month' });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const carLoan = node(plan, 'loan', { balance: 12000, rate: 0, asset: 30000, assetRate: -15 });
    link(plan, pay, carLoan, { mode: 'fixed', value: 1000 });
    link(plan, pay, savings);
    const r = run(plan);
    const car = r.nodes[carLoan.id].assetValue;
    close(r.nodes[carLoan.id].balance[12], 0);
    close(car[12], 25500);
    close(car[36], 30000 * Math.pow(0.85, 3));
    assert.ok(r.totals.growth < 0);
});

test('a loan dated inside the plan brings its asset in when it starts: buying a home', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'bank-account', { balance: 100000, rate: 0 });
    const mortgage = node(plan, 'loan', { balance: 320000, rate: 0, start: '2026-03', asset: 400000, assetRate: 0 });
    const purchase = node(plan, 'one-time-expense', { cost: 400000, start: '2026-03' });
    link(plan, mortgage, purchase, { basis: 'proceeds', mode: 'rest', when: 'once' });
    link(plan, savings, purchase, { basis: 'balance', mode: 'fixed', value: 80000, when: 'once', date: '2026-03' });
    const r = run(plan);
    const home = r.nodes[mortgage.id].assetValue;
    assert.equal(home[2], 0);            // not bought yet
    close(home[3], 400000);
    close(r.totals.acquired, 400000);
    // Paying 400,000 for a home worth 400,000 leaves net worth where it was.
    close(r.netWorth[2], 100000);
    close(r.netWorth[3], 100000);
});

test('a credit card is never secured by an asset', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, asset: 50000 });
    const r = run(plan);
    assert.equal(r.nodes[card.id].assetValue, undefined);
    close(r.netWorth[0], 0);
});

// ── Cards and retirement accounts ────────────────────────────────────────────

test('a credit card pays for spending: purchases raise the balance, cash back lowers it', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 2 });
    const groceries = node(plan, 'expense');
    link(plan, card, groceries, { basis: 'charges', mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(r.nodes[card.id].totals.charged, 12000);
    close(r.nodes[card.id].totals.cashback, 240);
    close(last(r.nodes[card.id].balance), 11760);
    close(r.totals.spent, 12000);
    close(r.totals.cashback, 240);
    assert.ok(!r.warnings.some((w) => w.code === 'short'));
});

test('cash back goes to the card\'s cash back account instead of crediting the balance', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 2, cashBackTo: savings.id });
    const groceries = node(plan, 'expense');
    link(plan, card, groceries, { basis: 'charges', mode: 'fixed', value: 1000 });
    const r = run(plan);
    close(last(r.nodes[card.id].balance), 12000);
    close(last(r.nodes[savings.id].balance), 240);
    close(r.nodes[card.id].totals.cashback, 240);
    close(r.totals.cashback, 240);
    close(r.totals.endNetWorth, 240 - 12000);
});

test('a cash back account that is not in the plan falls back to crediting the balance', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 2, cashBackTo: 'n_gone' });
    const groceries = node(plan, 'expense');
    link(plan, card, groceries, { basis: 'charges', mode: 'fixed', value: 1000 });
    close(last(run(plan).nodes[card.id].balance), 11760);
});

test('a payment from income pays a card off, and what it cannot take stays with the payer', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const card = node(plan, 'credit-card', { balance: 3000, rate: 0, cashBack: 0 });
    const savings = node(plan, 'bank-account', { balance: 0, rate: 0 });
    link(plan, pay, card, { mode: 'fixed', value: 1000 });
    link(plan, pay, savings, { mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.paid, 3000);
    close(last(r.nodes[card.id].balance), 0);
    close(last(r.nodes[savings.id].balance), 9000);
});

test('a 401(k) contribution comes out of gross pay, before withholding', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 22 });
    const k = node(plan, '401k');
    const savings = node(plan, 'bank-account');
    link(plan, salary, k, { mode: 'percent', value: 6 });
    link(plan, salary, savings, { mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 6000);
    close(r.totals.withheld, 94000 * 0.22);
    close(last(r.nodes[savings.id].balance), 94000 * 0.78);
    close(r.nodes[salary.id].totals.pretax, 6000);
});

test("a 401(k)'s share and take-home shares are of one paycheck, adding up to all of it", () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 20 });
    const k = node(plan, '401k');
    const spend = node(plan, 'expense');
    const savings = node(plan, 'bank-account');
    link(plan, salary, k, { mode: 'percent', value: 10 });
    link(plan, salary, spend, { mode: 'percent', value: 70 });
    link(plan, salary, savings, { mode: 'percent', value: 20 });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 10000);
    close(r.totals.withheld, 90000 * 0.2);
    close(r.nodes[spend.id].totals.in, 70000 * 0.8);             // 70% of gross, less withholding
    close(last(r.nodes[savings.id].balance), 20000 * 0.8);
    close(last(r.unassigned), 0);
    assert.ok(!codes(r).includes('over-100'));
});

test("a 401(k)'s share counts against the rest of the paycheck's shares", () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 20 });
    const k = node(plan, '401k');
    const savings = node(plan, 'bank-account');
    link(plan, salary, k, { mode: 'percent', value: 10 });
    const lb = link(plan, salary, savings, { mode: 'percent', value: 100 });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 10000);
    close(last(r.nodes[savings.id].balance), 90000 * 0.8);       // all the take-home there is
    assert.ok(codes(r).includes('over-100'));
    close(r.warnings.find((w) => w.code === 'short').amount, 10000 * 0.8);
    assert.equal(r.warnings.find((w) => w.code === 'short').linkId, lb.id);
});

test("a 401(k)'s employer match adds to the contribution without taking from pay", () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 20 });
    const k = node(plan, '401k', { match: 50 });
    link(plan, salary, k, { mode: 'percent', value: 6 });
    link(plan, salary, node(plan, 'expense'), { mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 9000);                    // 6,000 contributed + 3,000 matched
    close(r.totals.withheld, 94000 * 0.2);                        // only the contribution is pre-tax
    close(r.totals.match, 3000);
    close(r.nodes[k.id].totals.matched, 3000);
    close(r.nodes[k.id].totals.in, 6000);                         // deposits are the contribution alone
    close(r.nodes[salary.id].totals.pretax, 6000);
});

test('a 401(k) matches only pay, not transfers, and only on a 401(k)', () => {
    const plan = mkPlan('2026-01', 1);
    const savings = node(plan, 'bank-account', { balance: 12000 });
    const k = node(plan, '401k', { match: 100 });
    const ira = node(plan, 'investment', { match: 100 });    // hidden setting: ignored
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    link(plan, savings, k, { basis: 'balance', mode: 'fixed', value: 500 });
    link(plan, pay, ira, { mode: 'rest' });
    const r = run(plan);
    close(last(r.nodes[k.id].balance), 6000);
    close(last(r.nodes[ira.id].balance), 12000);
    close(r.totals.match, 0);
});

test('an Investment (a Roth IRA, say) is paid from take-home pay', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 100000, per: 'year', tax: 22 });
    const roth = node(plan, 'investment');
    link(plan, salary, roth, { mode: 'percent', value: 6 });
    link(plan, salary, node(plan, 'expense'), { mode: 'rest' });
    const r = run(plan);
    close(r.totals.withheld, 22000);
    close(last(r.nodes[roth.id].balance), 78000 * 0.06);
});

test('an employer match stops at its yearly limit and restarts in January', () => {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 10000, per: 'month' });
    const k401 = node(plan, '401k', { match: 50, matchLimit: 3000 });
    link(plan, pay, k401, { mode: 'fixed', value: 1000 });
    link(plan, pay, node(plan, 'expense'));
    const r = run(plan);
    const added = r.nodes[k401.id].matched;
    close(added[0], 500);
    close(added[5], 500);
    assert.equal(added[6], 0);
    close(added[12], 500);
    close(r.totals.match, 6000);
    close(r.nodes[k401.id].balance[12], 15000);
});

test('a match does not count toward the yearly contribution limit, and matches only what fits', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 2000, per: 'month' });
    const k401 = node(plan, '401k', { match: 100, capYearly: 6000 });
    link(plan, pay, k401, { mode: 'fixed', value: 1000 });
    link(plan, pay, node(plan, 'expense'));
    const r = run(plan);
    close(r.nodes[k401.id].totals.in, 6000);       // six months fill the limit
    close(r.totals.match, 6000);                   // each accepted deposit matched, none past it
    close(last(r.nodes[k401.id].balance), 12000);
    assert.ok(codes(r).includes('cap'));
});

// ── Links over time ──────────────────────────────────────────────────────────

test('link windows and growing fixed amounts', () => {
    const plan = mkPlan('2026-01', 3);
    const pay = node(plan, 'paycheck', { amount: 5000, per: 'month' });
    const rent = node(plan, 'expense');
    const l = link(plan, pay, rent, {
        mode: 'fixed', value: 1000, growth: 10, start: '2026-07', end: '2027-12',
    });
    link(plan, pay, node(plan, 'expense'));
    const r = run(plan);
    const f = r.links[l.id].flow;
    assert.equal(f[5], 0);
    close(f[6], 1000);
    close(f[18], 1100);
    assert.equal(f[24], 0);
});

test('a once link moves its amount on its date only', () => {
    const plan = mkPlan('2026-01', 2);
    const savings = node(plan, 'bank-account', { balance: 50000, rate: 0 });
    const wedding = node(plan, 'expense');
    const l = link(plan, savings, wedding, {
        basis: 'balance', mode: 'fixed', value: 30000, when: 'once', date: '2026-09',
    });
    const r = run(plan);
    close(r.links[l.id].total, 30000);
    close(r.links[l.id].flow[8], 30000);
});

// ── Safety ───────────────────────────────────────────────────────────────────

test('a loop that passes everything around settles, flags itself and conserves money', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const a = node(plan, 'living');
    const b = node(plan, 'living');
    link(plan, pay, a);
    link(plan, a, b, { basis: 'inflow', mode: 'rest' });
    link(plan, b, a, { basis: 'inflow', mode: 'rest' });
    const r = run(plan);
    assert.ok(codes(r).includes('loop'));
    assert.ok(codes(r).includes('runaway'));
});

test('a loop that passes on part of the money converges without hitting the guard', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const a = node(plan, 'living');
    const b = node(plan, 'living');
    link(plan, pay, a);
    link(plan, a, b, { basis: 'inflow', mode: 'percent', value: 50 });
    link(plan, b, a, { basis: 'inflow', mode: 'percent', value: 50 });
    const r = run(plan);
    assert.ok(codes(r).includes('loop'));
    assert.ok(!codes(r).includes('runaway'));
    close(r.totals.spent, 12000);   // what the groups cannot hand on is spent in them
});

test('the outlook example: salary, spending, savings, brokerage, card, five years', () => {
    const plan = mkPlan('2026-10', 5);
    const salary = node(plan, 'salary', { amount: 85000, per: 'year', growth: 3, tax: 22 });
    const living = node(plan, 'expense');
    const savings = node(plan, 'bank-account', { balance: 5000, rate: 4 });
    const brokerage = node(plan, 'investment', { balance: 0, rate: 7 });
    const card = node(plan, 'credit-card', { cashBack: 2, cashBackTo: savings.id });
    const dining = node(plan, 'expense');
    link(plan, salary, living, { mode: 'percent', value: 60 });
    link(plan, salary, savings, { mode: 'percent', value: 15 });
    link(plan, salary, brokerage, { mode: 'rest' });
    link(plan, salary, card, { mode: 'fixed', value: 450 });
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 450 });
    const r = run(plan);
    assert.equal(r.months, 60);
    assert.ok(r.totals.endNetWorth > 100000);
    assert.ok(last(r.nodes[savings.id].balance) > 0);
    assert.ok(r.totals.cashback > 0);
    assert.deepEqual(codes(r), []);
});

// ── Credit card ──────────────────────────────────────────────────────────────

test('the annual fee is added to the balance in month one and every twelfth after', () => {
    const plan = mkPlan('2026-01', 2);
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 0, annualFee: 95 });
    const r = run(plan);
    const n = r.nodes[card.id];
    close(n.fees[0], 95);
    close(n.fees[12], 95);
    close(n.totals.fees, 190);
    close(last(n.balance), 190);
    close(r.totals.skimmed, 190);
    close(r.totals.endNetWorth, -190);
});

test('an unpaid annual fee accrues interest like the rest of the balance', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { balance: 0, rate: 12, cashBack: 0, annualFee: 100 });
    const r = run(plan);
    close(last(r.nodes[card.id].balance), 100 * Math.pow(1.01, 12));
});

test('a card with no annual fee charges nothing', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { cashBack: 2 });
    const r = run(plan);
    close(r.nodes[card.id].totals.fees, 0);
});

test('a card never charges past its limit: purchases are held to the credit left', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { rate: 0, limit: 1000 });
    const dining = node(plan, 'expense');
    const l = link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 800 });
    const r = run(plan);
    close(r.nodes[card.id].totals.charged, 1000);        // 800, then the 200 that was left
    close(last(r.nodes[card.id].balance), 1000);
    close(r.links[l.id].total, 1000);
    assert.ok(codes(r).includes('short'));
});

test('a percent link on a card charges that share of its limit each time', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { rate: 0, limit: 5000 });
    const dining = node(plan, 'expense');
    const l = link(plan, card, dining, { basis: 'charges', mode: 'percent', value: 10 });
    const r = run(plan);
    close(r.links[l.id].flow[0], 500);
    close(r.links[l.id].total, 5000);                     // ten months of 500, then the limit is reached
    close(last(r.nodes[card.id].balance), 5000);
});

test('a rest link on a card charges the credit left after the others', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { rate: 0, limit: 1000 });
    const dining = node(plan, 'expense');
    const travel = node(plan, 'expense');
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 300 });
    const rest = link(plan, card, travel, { basis: 'charges', mode: 'rest' });
    const r = run(plan);
    close(r.links[rest.id].flow[0], 700);
    close(r.nodes[card.id].totals.charged, 1000);
});

test('payments free up credit for a rest link on a card', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 400, per: 'month' });
    const card = node(plan, 'credit-card', { rate: 0, limit: 1000 });
    const travel = node(plan, 'expense');
    link(plan, pay, card, { mode: 'fixed', value: 400 });
    link(plan, card, travel, { basis: 'charges', mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.charged, 1000 + 11 * 400);
    close(last(r.nodes[card.id].balance), 600);   // the month's payment lands after its purchases
});

test('percent and rest links on a card without a limit charge nothing and say so', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { rate: 0 });
    const dining = node(plan, 'expense');
    link(plan, card, dining, { basis: 'charges', mode: 'rest' });
    const r = run(plan);
    close(r.nodes[card.id].totals.charged, 0);
    assert.ok(codes(r).includes('no-limit'));
});

test('a card using more than 30% of its limit is flagged, at the month\'s peak', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 2000, per: 'month' });
    const card = node(plan, 'credit-card', { rate: 0, limit: 5000 });
    const shop = node(plan, 'expense');
    link(plan, card, shop, { basis: 'charges', mode: 'fixed', value: 1600 });
    link(plan, pay, card, { mode: 'fixed', value: 1600 });     // paid off every month
    const r = run(plan);
    close(last(r.nodes[card.id].balance), 0);                 // nothing owed at month end...
    const w = r.warnings.find((x) => x.code === 'utilization');
    assert.ok(w);                                              // ...but 32% at the peak
    assert.equal(w.month, 0);
    close(w.amount, 32);
});

test('a card at 30% or under, or with no limit, is not flagged', () => {
    const plan = mkPlan('2026-01', 1);
    const card = node(plan, 'credit-card', { rate: 0, limit: 5000 });
    link(plan, card, node(plan, 'expense'), { basis: 'charges', mode: 'fixed', value: 1500, when: 'once', date: '2026-01' });
    const noLimit = node(plan, 'credit-card', { rate: 0 });
    link(plan, noLimit, node(plan, 'expense'), { basis: 'charges', mode: 'fixed', value: 9000, when: 'once', date: '2026-01' });
    const r = run(plan);
    assert.ok(!codes(r).includes('utilization'));
    close(r.nodes[card.id].totals.charged, 1500);
});
