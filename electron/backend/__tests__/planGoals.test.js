'use strict';

// Goals: each is a rule ("net worth is at least 25 times yearly expenses by
// age 65"). When a plan meets one, how its deadline reads, what each measure
// counts, and how the goal list is read and kept, older goal kinds included.
// Goals are shared by all plans, so a test plan carries its goals beside it
// (plan.goals here) and hands them to the evaluator.

const test = require('node:test');
const assert = require('node:assert/strict');

const Catalog = require('../../../static/js/plan/sim/catalog.js');
const Plan = require('../../../static/js/plan/sim/plan.js');
const { simulate } = require('../../../static/js/plan/sim/engine.js');
const Goals = require('../../../static/js/plan/sim/goals.js');

// ── Builders ─────────────────────────────────────────────────────────────────

function mkPlan(start = '2026-01', years = 2, inflation = 0) {
    return {
        id: 'p_test', name: 'Test', version: 1,
        settings: { start, years, inflation },
        view: { x: 0, y: 0, zoom: 1 },
        nodes: [], links: [], goals: [],
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

/** A goal on `plan`, from a rule's fields. */
function goal(plan, fields) {
    const g = { ...Plan.createGoal(fields), id: `g_${plan.goals.length}` };
    plan.goals.push(g);
    return g;
}

/** Validate (as the backend would), simulate and evaluate every goal. */
function evaluate(plan, opts) {
    const v = Plan.validatePlan(plan);
    return Goals.evaluate(v, simulate(v), plan.goals, opts);
}

const only = (plan, opts) => evaluate(plan, opts)[0];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `expected ${b}, got ${a}`);

/** 1,000 a month of pay into savings (from `balance`), nothing spent. */
function savingPlan(balance = 0) {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    link(plan, pay, node(plan, 'bank-account', { balance, rate: 0 }));
    return plan;
}

/** Pay of 3,000 a month: 1,000 spent on rent, 2,000 saved on top of `balance`. */
function spendingPlan(balance = 0) {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 3000, per: 'month' });
    const rent = node(plan, 'expense');
    const savings = node(plan, 'bank-account', { balance, rate: 0 });
    link(plan, pay, rent, { mode: 'fixed', value: 1000 });
    link(plan, pay, savings);
    return plan;
}

// ── A rule against an amount ─────────────────────────────────────────────────

test('a goal is met at the first point its rule holds', () => {
    const plan = savingPlan();
    goal(plan, { metric: 'net-worth', op: 'gte', unit: 'amount', value: 5000 });
    const ev = only(plan);
    assert.equal(ev.month, 5);
    assert.equal(ev.status, 'met');
    close(ev.value, 5000);
    close(ev.target, 5000);
});

test('a deadline makes a goal met (on time or early), late, or never met', () => {
    const due = (by, value = 5000) => {
        const plan = savingPlan();
        goal(plan, { metric: 'net-worth', value, due: 'date', by });
        return only(plan);
    };
    assert.equal(due('2026-06').status, 'met');
    assert.equal(due('2026-04').status, 'late');
    const never = due('2027-06', 1e6);
    assert.equal(never.status, 'unmet');
    assert.equal(never.month, null);
    assert.equal(never.months, 24);
    close(never.value, 24000);          // read at the run's end
    // A deadline past the run's end changes nothing: never met is never met.
    assert.equal(due('2040-01', 1e6).status, 'unmet');
});

test('progress is 1 once met, late or not; unmet, the closest the plan ever comes', () => {
    const due = (by, value = 5000) => {
        const plan = savingPlan();
        goal(plan, { metric: 'net-worth', value, due: 'date', by });
        return only(plan);
    };
    close(due('2026-06').progress, 1);
    const late = due('2026-04');
    close(late.progress, 1);
    assert.equal(late.progressAt, 5);
    // Never met: 24,000 of 100,000 at the run's end, its closest.
    const never = due('2027-06', 100000);
    assert.equal(never.progressAt, 24);
    close(never.progress, 0.24);
});

test('"is at most" progress is the share of the way down from the highest point', () => {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 500, per: 'month' });
    const loan = node(plan, 'loan', { balance: 1200, rate: 0 });
    link(plan, pay, loan, { mode: 'fixed', value: 100 });
    goal(plan, { metric: 'debt', op: 'lte', value: 0, due: 'date', by: '2026-04' });
    goal(plan, { metric: 'debt', op: 'lte', value: -1, due: 'date', by: '2026-04' });
    const [late, never] = evaluate(plan);
    assert.equal(late.status, 'late');
    assert.equal(never.status, 'unmet');
    close(never.progress, 1200 / 1201);   // paid off by month 12, 1 short of -1
    assert.equal(never.progressAt, 12);
});

test('a goal the plan cannot measure is blocked, with no progress', () => {
    const plan = savingPlan();
    goal(plan, { metric: 'net-worth', value: 5000, due: 'age', age: 65 });
    const ev = only(plan);
    assert.equal(ev.status, 'blocked');
    assert.equal(ev.blocked, 'no-age');
    assert.equal(ev.progress, null);
});

test('a goal met at the plan start is on time even when its deadline has passed', () => {
    const plan = savingPlan(50000);
    goal(plan, { value: 10000, due: 'date', by: '2020-01' });
    const ev = only(plan);
    assert.equal(ev.month, 0);
    assert.equal(ev.status, 'met');
});

// ── The goal horizon ─────────────────────────────────────────────────────────

test('goals are judged over the longest plan length, whatever length is viewed', () => {
    const plan = savingPlan();                       // a 2-year plan
    goal(plan, { metric: 'net-worth', value: 100000, due: 'date', by: '2040-01' });
    assert.equal(only(plan).status, 'unmet', 'not met inside two years');
    const v = Plan.validatePlan(plan);
    const long = Goals.horizon(v);
    assert.equal(long.settings.years, Plan.LIMITS.years);
    assert.equal(v.settings.years, 2, 'the plan itself is not changed');
    const ev = Goals.evaluate(v, simulate(long), plan.goals)[0];
    assert.equal(ev.status, 'met');                  // 1,000 a month: 100 months in
    assert.equal(ev.month, 100);
    assert.equal(ev.months, Plan.LIMITS.years * 12);
    assert.equal(Goals.horizon(long), long, 'already at the horizon');
});

test('account balance is every account plus Unassigned', () => {
    const plan = mkPlan('2026-01', 1);
    const pay = node(plan, 'paycheck', { amount: 1000, per: 'month' });
    const a = node(plan, 'bank-account', { balance: 0 });
    node(plan, 'bank-account', { balance: 3000 });
    link(plan, pay, a, { mode: 'percent', value: 50 });   // the other half lands in Unassigned
    goal(plan, { metric: 'savings', value: 6000 });
    assert.equal(only(plan).month, 3);   // 3,000 already, plus 1,000 a month in all
});

test('"is at most" holds once a measure falls to the target: debt-free when the last debt is paid', () => {
    const plan = mkPlan('2026-01', 2);
    const pay = node(plan, 'paycheck', { amount: 500, per: 'month' });
    const loan = node(plan, 'loan', { balance: 1200, rate: 0 });
    link(plan, pay, loan, { mode: 'fixed', value: 100 });
    goal(plan, { metric: 'debt', op: 'lte', value: 0 });
    goal(plan, { metric: 'debt', op: 'lte', value: 600 });
    const [free, half] = evaluate(plan);
    assert.equal(free.month, 12);
    assert.equal(half.month, 6);
});

// ── A rule against another measure ───────────────────────────────────────────

test('a year of expenses is spending and loan payments, not card payments', () => {
    const plan = spendingPlan();
    const pay = plan.nodes[0];
    const card = node(plan, 'credit-card', { balance: 0, rate: 0, cashBack: 0 });
    const dining = node(plan, 'expense');
    link(plan, card, dining, { basis: 'charges', mode: 'fixed', value: 500 });
    link(plan, pay, card, { mode: 'fixed', value: 500 });
    const loan = node(plan, 'loan', { balance: 100000, rate: 0 });
    link(plan, pay, loan, { mode: 'fixed', value: 250 });
    goal(plan, { metric: 'net-worth', unit: 'times', value: 25, of: 'expenses' });
    // Rent 1,000 + 500 bought on the card, plus 250 to the loan: 1,750 a month.
    close(only(plan).target, 1750 * 12 * 25);
});

test('"25 times yearly expenses" is met when the measure reaches that many years of spending', () => {
    const plan = spendingPlan(290000);
    goal(plan, { metric: 'savings', unit: 'times', value: 25, of: 'expenses' });
    const ev = only(plan);
    assert.equal(ev.month, 5);        // 290,000 + 5 × 2,000 = 25 × 12,000
    close(ev.target, 300000);
});

test('"40% of yearly income" compares a year of one flow with a share of another', () => {
    // Take-home 3,000 a month (36,000 a year), 1,000 a month spent (12,000 a year: a third).
    const plan = spendingPlan();
    goal(plan, { metric: 'expenses', op: 'lte', unit: 'percent', value: 40, of: 'income' });
    goal(plan, { metric: 'expenses', op: 'lte', unit: 'percent', value: 30, of: 'income' });
    const [forty, thirty] = evaluate(plan);
    assert.equal(forty.month, 0);
    close(forty.target, 36000 * 0.4);
    assert.equal(thirty.month, null);
});

test('income is take-home pay: earned less withholding', () => {
    const plan = mkPlan('2026-01', 1);
    const salary = node(plan, 'salary', { amount: 60000, per: 'year', tax: 25 });
    link(plan, salary, node(plan, 'bank-account'));
    goal(plan, { metric: 'income', value: 45000 });
    const ev = only(plan);
    assert.equal(ev.month, 0);
    close(ev.value, 45000);
});

test('a rule that reads a year of income or expenses a plan does not have is blocked', () => {
    const plan = mkPlan('2026-01', 1);
    node(plan, 'bank-account', { balance: 1000 });
    goal(plan, { metric: 'net-worth', unit: 'times', value: 25, of: 'expenses' });
    goal(plan, { metric: 'income', value: 1 });
    const [noSpending, noIncome] = evaluate(plan);
    assert.equal(noSpending.blocked, 'no-expenses');
    assert.equal(noSpending.month, null);
    assert.equal(noIncome.blocked, 'no-income');
});

// ── Deadlines by age ─────────────────────────────────────────────────────────

test('an age deadline is the month the plan\'s age reaches it', () => {
    const plan = spendingPlan(200000);
    plan.settings.age = 64;
    const g = goal(plan, { metric: 'savings', unit: 'times', value: 25, of: 'expenses', due: 'age', age: 65 });
    assert.equal(Plan.goalDate(Plan.validatePlan(plan), g), '2027-01');
    const ev = only(plan);
    assert.equal(ev.byIdx, 12);
    assert.equal(ev.status, 'unmet');    // 200,000 + 24 × 2,000 never reaches 300,000
    plan.settings.age = 64.5;
    assert.equal(only(plan).byIdx, 6, 'half a year older, the same age comes sooner');
});

test('an age deadline waits for the plan\'s age', () => {
    const plan = spendingPlan();
    goal(plan, { due: 'age', age: 65 });
    assert.equal(only(plan).blocked, 'no-age');
    plan.settings.age = 40;
    assert.equal(only(plan).blocked, null);
});

// ── Inflation ────────────────────────────────────────────────────────────────

test('measured in real money, growth that only keeps up with inflation reaches nothing', () => {
    const plan = mkPlan('2026-01', 3, 5);
    node(plan, 'bank-account', { balance: 10000, rate: 5 });
    goal(plan, { value: 10400 });
    assert.equal(only(plan).status, 'met');
    assert.equal(only(plan, { real: true }).status, 'unmet');
});

// ── The goal list ────────────────────────────────────────────────────────────

test('a new goal starts as "net worth is at least $100,000" in ten years, with any fields given', () => {
    const g = Plan.createGoal({ name: 'Mine', value: 5, nodeId: 'n_x' });
    assert.deepEqual({ ...g, id: null }, {
        id: null, name: 'Mine', metric: 'net-worth', op: 'gte', unit: 'amount', value: 5, of: 'expenses',
        due: 'date', by: Plan.ymAdd(Plan.ymNow(), 120), age: null, color: 'lapis',
    });
});

test('validateGoals normalizes a rule', () => {
    const [g] = Plan.validateGoals([{
        id: 'g_a', name: '  Plenty ', metric: 'savings', op: 'lte', unit: 'percent', value: 5000, of: 'income',
        due: 'date', by: null, age: 400, color: 'tanzanite', extra: true,
    }]);
    assert.deepEqual(g, {
        id: 'g_a', name: 'Plenty', metric: 'savings', op: 'lte', unit: 'percent', value: Plan.GOAL_VALUE.percent, of: 'income',
        due: 'date', by: Plan.ymAdd(Plan.ymNow(), 120), age: Plan.GOAL_AGE.max, color: 'tanzanite',
    });
    // A goal saved with no deadline is due in ten years.
    const [none] = Plan.validateGoals([{ id: 'g_n', metric: 'debt', due: 'none', by: null }]);
    assert.deepEqual([none.due, none.by], ['date', Plan.ymAdd(Plan.ymNow(), 120)]);
    // A colour this build does not know is only for show: the goal keeps, in the first colour.
    assert.equal(Plan.validateGoals([{ id: 'g_b', metric: 'debt', color: 'chartreuse' }])[0].color, 'lapis');
    // The colours offered before the Gemstone palette (gold among them, taken
    // out before that) read as the stone nearest them.
    const old = { teal: 'tourmaline', blue: 'lapis', violet: 'tanzanite', rose: 'garnet',
        orange: 'amber', green: 'emerald', slate: 'lapis', gold: 'tigers-eye' };
    for (const [was, now] of Object.entries(old)) {
        assert.ok(!Plan.GOAL_COLORS.includes(was), was);
        assert.equal(Plan.validateGoals([{ id: 'g_c', metric: 'debt', color: was }])[0].color, now, was);
    }
    assert.deepEqual(Plan.validateGoals(null), []);
});

test('goals of the kinds from before rules are read as the rules they meant', () => {
    const rules = Plan.validateGoals([
        { id: 'g_a', kind: 'net-worth', name: 'Million', target: 1e6, by: '2040-01' },
        { id: 'g_b', kind: 'savings', name: 'Fund', target: 500, nodeId: 'n_x' },
        { id: 'g_c', kind: 'debt-free', name: 'Free' },
        { id: 'g_d', kind: 'fi', name: 'FI', rate: 5 },
        { id: 'g_e', kind: 'retire', name: 'Retire', age: 60, rate: 4 },
    ]).map(({ id: _id, name: _name, color: _color, ...rule }) => rule);
    assert.deepEqual(rules, [
        { metric: 'net-worth', op: 'gte', unit: 'amount', value: 1e6, of: 'expenses', due: 'date', by: '2040-01', age: null },
        { metric: 'savings', op: 'gte', unit: 'amount', value: 500, of: 'expenses', due: 'date', by: Plan.ymAdd(Plan.ymNow(), 120), age: null },
        { metric: 'debt', op: 'lte', unit: 'amount', value: 0, of: 'expenses', due: 'date', by: Plan.ymAdd(Plan.ymNow(), 120), age: null },
        { metric: 'savings', op: 'gte', unit: 'times', value: 20, of: 'expenses', due: 'date', by: Plan.ymAdd(Plan.ymNow(), 120), age: null },
        { metric: 'savings', op: 'gte', unit: 'times', value: 25, of: 'expenses', due: 'age', by: null, age: 60 },
    ]);
});

test('validateGoals rejects a goal it cannot trust rather than dropping it', () => {
    const bad = (goals) => () => Plan.validateGoals(goals);
    assert.throws(bad([{ id: 'g_a', kind: 'retire-early', name: 'x' }]), /unknown kind/);
    assert.throws(bad([{ id: 'g_a', metric: 'happiness', name: 'x' }]), /measure has an unknown value/);
    assert.throws(bad([{ id: 'g_a', metric: 'debt', op: 'equals' }]), /comparison has an unknown value/);
    assert.throws(bad([{ id: 'g_a', metric: 'debt' }, { id: 'g_a', metric: 'debt' }]), /used twice/);
    assert.throws(bad([{ id: 'g_a', metric: 'debt', due: 'date', by: '2026-13' }]), /month/);
    assert.throws(bad({}), /goals are malformed/);
    assert.throws(bad(Array.from({ length: Plan.LIMITS.goals + 1 }, (_, i) => ({ id: `g_${i}`, metric: 'debt' }))), /at most/);
});

test('a plan keeps no goals; the ones an older plan held are read out of it', () => {
    const plan = mkPlan('2026-01', 1);
    plan.goals.push({ id: 'g_a', kind: 'net-worth', name: 'Million', target: 1e6, nodeId: 'n_x' });
    assert.equal('goals' in Plan.validatePlan(plan), false);
    const [g] = Plan.legacyGoals(plan);
    assert.deepEqual([g.metric, g.value], ['net-worth', 1e6]);
    const old = mkPlan('2026-01', 1);
    delete old.goals;
    assert.deepEqual(Plan.legacyGoals(old), []);
    assert.equal('goals' in Plan.cloneWithNewIds(plan), false);
});

test('merging adds only the goals the list does not hold yet', () => {
    const held = [Plan.createGoal({ name: 'Million', value: 1e6 })];
    const merged = Plan.mergeGoals(held, [
        { ...held[0], id: 'g_other' },                                                     // the same goal again
        { ...Plan.createGoal({ name: 'FI', unit: 'times', value: 25 }), id: held[0].id },   // new, its id taken
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged[1].name, 'FI');
    assert.notEqual(merged[1].id, held[0].id);
    assert.equal(held.length, 1, 'the list given is left as it was');
});
