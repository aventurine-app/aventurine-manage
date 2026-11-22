'use strict';

// The plan document's rules: which links may be drawn, what a new link starts
// as, how a rule is kept inside what its source allows, and the validator that
// guards every save.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Catalog = require('../../../static/js/plan/sim/catalog.js');
const Plan = require('../../../static/js/plan/sim/plan.js');

// Choice fields have no empty value, so a module may pick how often it pays.
const FIELD_CADENCE = new Set(['per', 'payMonth', 'stopBy']);

const close = (actual, expected, tol = 1e-6) =>
    assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
        `expected ${expected}, got ${actual}`);

function planWith(...types) {
    const plan = Plan.createPlan({ name: 'T', start: '2026-01', years: 5 });
    const nodes = types.map((t, i) => {
        const n = Plan.createNode(plan, t, i * 300, 0);
        plan.nodes.push(n);
        return n;
    });
    return { plan, nodes };
}

test('the catalog: every preset has a known role, category and icon name', () => {
    const cats = new Set(Catalog.CATEGORIES.map((c) => c.id));
    for (const p of Catalog.PRESETS) {
        assert.ok(Catalog.ROLES[p.role], p.id);
        assert.ok(cats.has(p.cat), p.id);
        assert.match(p.icon, /^[a-z0-9-]+$/, p.id);
        for (const k of Catalog.fieldsFor(p)) assert.ok(Catalog.FIELDS[k], `${p.id}.${k}`);
    }
    assert.ok(Catalog.PRESETS.length >= 10);
});

test('the catalog: the generated icon data holds every icon a module can wear', () => {
    const file = path.join(__dirname, '..', '..', '..', 'static', 'js', 'plan', 'icon-data.js');
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
    const drawn = new Set(Object.keys(sandbox.window.PLAN_ICON_DATA.regular));
    const missing = Catalog.PRESETS.flatMap((p) => Catalog.iconChoices(p)).filter((icon) => !drawn.has(icon));
    assert.deepEqual([...new Set(missing)], [], 'run `npm run icons:ui` after adding a module icon');
});

test('a retired preset folds into one whose category offers its old icon', () => {
    for (const [old, { type, icon }] of Object.entries(Plan.RETIRED_TYPES)) {
        const survivor = Catalog.preset(type);
        assert.ok(survivor, `${old} folds into ${type}`);
        assert.ok(Catalog.iconChoices(survivor).includes(icon), `${old} keeps its ${icon} icon as a ${type}`);
    }
});

test('an income stops never by default, and an older plan\'s end date becomes its stop', () => {
    const { plan, nodes: [salary, pay] } = planWith('salary', 'paycheck');
    assert.equal(salary.params.stopBy, 'never');
    assert.ok(Catalog.fieldsFor(Catalog.preset('salary')).includes('stopBy'));
    assert.ok(!Catalog.fieldsFor(Catalog.preset('one-time-income')).includes('stopBy'));
    const raw = JSON.parse(JSON.stringify(plan));
    delete raw.nodes[1].params.stopBy;
    raw.nodes[1].params.end = '2030-06';
    const v = Plan.validatePlan(raw);
    assert.equal(v.nodes.find((n) => n.id === pay.id).params.stopBy, 'date');
    assert.equal(v.nodes.find((n) => n.id === salary.id).params.stopBy, 'never');
});

test('an income\'s last month: a date as given, an age as the month before it is reached', () => {
    const { plan, nodes: [pay] } = planWith('paycheck');
    plan.settings.start = '2026-01';
    plan.settings.age = 30;
    Object.assign(pay.params, { stopBy: 'date', end: '2040-06', endAge: 65 });
    assert.equal(Plan.incomeEnd(plan, pay), '2040-06');
    pay.params.stopBy = 'age';
    assert.equal(Plan.incomeEnd(plan, pay), '2060-12');
    plan.settings.age = null;
    assert.equal(Plan.incomeEnd(plan, pay), null);
    pay.params.stopBy = 'never';
    plan.settings.age = 30;
    assert.equal(Plan.incomeEnd(plan, pay), null);
});

test('the plan\'s retirement age goal stops incomes and starts links, and is saved', () => {
    const { plan, nodes: [pay, chk, fund] } = planWith('paycheck', 'bank-account', 'investment');
    plan.settings.start = '2026-01';
    plan.settings.age = 30;
    pay.params.stopBy = 'retire';
    const draw = { ...Plan.createLink(plan, fund.id, chk.id), startWhen: { kind: 'retire', age: 40 } };
    plan.links.push(draw);
    // Not set yet: neither has a month.
    assert.equal(Plan.incomeEnd(plan, pay), null);
    assert.equal(Plan.startAgeMonth(plan, draw.startWhen), null);
    plan.settings.retireAge = 62;
    assert.equal(Plan.incomeEnd(plan, pay), '2057-12');
    assert.equal(Plan.startAgeMonth(plan, draw.startWhen), '2058-01');
    // One edit moves both.
    plan.settings.retireAge = 67;
    assert.equal(Plan.incomeEnd(plan, pay), '2062-12');
    assert.equal(Plan.startAgeMonth(plan, draw.startWhen), '2063-01');
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.equal(v.settings.retireAge, 67);
    assert.equal(v.nodes.find((n) => n.id === pay.id).params.stopBy, 'retire');
    assert.deepEqual(v.links[0].startWhen, { kind: 'retire' });    // the age is the plan's, not its own
    assert.equal(Plan.validatePlan({ ...JSON.parse(JSON.stringify(plan)), settings: { ...plan.settings, retireAge: undefined } })
        .settings.retireAge, null);
});

test('each side of a link saves its own stop, and a copy keeps its account', () => {
    const { plan, nodes: [chk, fund, rent] } = planWith('bank-account', 'investment', 'expense');
    const save = { ...Plan.createLink(plan, chk.id, fund.id), stopWhen: { kind: 'retire' } };
    const spend = { ...Plan.createLink(plan, chk.id, rent.id), stopWhen: { kind: 'nonsense' } };
    plan.links.push(save, spend);
    Plan.makeTwoWay(plan, save);
    assert.equal(save.back.stopWhen, null);             // the way back runs on
    save.back.stopWhen = { kind: 'balance', account: fund.id, amount: 0 };
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(v.links[0].stopWhen, { kind: 'retire' });
    assert.deepEqual(v.links[0].back.stopWhen, { kind: 'balance', account: fund.id, amount: 0 });
    assert.equal('stopWhen' in v.links[1], false);      // an unknown condition never stops
    const copy = Plan.cloneWithNewIds(v, 'Copy');
    assert.equal(copy.links[0].back.stopWhen.account, copy.nodes[1].id);
});

test('only a link between two accounts is two-way, and it keeps its way back when saved', () => {
    const { plan, nodes: [chk, fund, rent] } = planWith('bank-account', 'investment', 'expense');
    const save = Plan.createLink(plan, chk.id, fund.id);
    const spend = Plan.createLink(plan, chk.id, rent.id);
    plan.links.push(save, spend);
    assert.equal(Plan.canTurn(plan, save), true);
    assert.equal(Plan.canTurn(plan, spend), false);
    assert.equal(Plan.makeTwoWay(plan, spend), false);
    assert.equal(Plan.makeTwoWay(plan, save), true);
    assert.equal(save.back.startWhen, null);            // the way back starts now
    save.back.startWhen = { kind: 'balance', account: fund.id, amount: 50000 };
    const raw = JSON.parse(JSON.stringify(plan));
    raw.links.find((l) => l.id === spend.id).back = { ...save.back };      // not between accounts: dropped
    const v = Plan.validatePlan(raw);
    assert.deepEqual(v.links.find((l) => l.id === save.id).back, save.back);
    assert.equal(v.links.find((l) => l.id === spend.id).back, undefined);
    // An account its start waits on that is gone (or is not an account) is cleared.
    raw.links.find((l) => l.id === save.id).back.startWhen.account = rent.id;
    assert.equal(Plan.validatePlan(raw).links.find((l) => l.id === save.id).back.startWhen.account, null);
});

test('each side of a link saves its own start, and one sent once with a start needs no date', () => {
    const { plan, nodes: [pay, chk, fund] } = planWith('paycheck', 'bank-account', 'investment');
    const save = { ...Plan.createLink(plan, chk.id, fund.id), mode: 'fixed', value: 100, when: 'once', date: null,
        startWhen: { kind: 'age', age: 60 } };
    const split = { ...Plan.createLink(plan, pay.id, chk.id), startWhen: { kind: 'nonsense' } };
    plan.links.push(save, split);
    const v = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(v.links[0].startWhen, { kind: 'age', age: 60 });
    assert.equal(v.links[0].date, null);
    assert.equal('startWhen' in v.links[1], false);     // an unknown condition starts now
    plan.settings.age = 30;
    assert.equal(Plan.startAgeMonth(plan, save.startWhen), Plan.ymAdd(plan.settings.start, 360));
    // Starting now, once still needs its date.
    delete save.startWhen;
    assert.throws(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))), /needs a date/);
});

test('making a link two-way takes in a link already running the other way', () => {
    const { plan, nodes: [chk, fund] } = planWith('bank-account', 'investment');
    const save = Plan.createLink(plan, chk.id, fund.id);
    const draw = { ...Plan.createLink(plan, fund.id, chk.id), mode: 'percent', value: 4, when: 'yearly',
        startWhen: { kind: 'age', age: 65 } };
    plan.links.push(save, draw);
    assert.equal(Plan.makeTwoWay(plan, save), true);
    assert.deepEqual(plan.links.map((l) => l.id), [save.id]);
    assert.deepEqual([save.back.mode, save.back.value, save.back.when], ['percent', 4, 'yearly']);
    assert.deepEqual(save.back.startWhen, { kind: 'age', age: 65 });
    // Nothing more may run back along the pair.
    assert.equal(Plan.canConnect(plan, fund.id, chk.id).ok, false);
});

test('the way back offers the same choices as the way out, and saves each', () => {
    assert.deepEqual(Plan.BACK_MODES, Plan.modesFor({ type: 'bank-account' }, 'balance'));
    assert.deepEqual(Plan.BACK_WHENS, Plan.timingsFor('balance', 'fixed'));
    const { plan, nodes: [chk, fund] } = planWith('bank-account', 'investment');
    const save = Plan.createLink(plan, chk.id, fund.id);
    plan.links.push(save);
    Plan.makeTwoWay(plan, save);
    Object.assign(save.back, { mode: 'rest', value: 500, when: 'once', date: '2030-03' });
    const back = Plan.validatePlan(JSON.parse(JSON.stringify(plan))).links[0].back;
    assert.deepEqual([back.mode, back.value, back.when, back.date, back.startWhen], ['rest', 0, 'once', '2030-03', null]);
});

test('a link sent back once becomes a way back sent on its own date', () => {
    const { plan, nodes: [chk, fund] } = planWith('bank-account', 'investment');
    const save = Plan.createLink(plan, chk.id, fund.id);
    const draw = { ...Plan.createLink(plan, fund.id, chk.id), mode: 'rest', when: 'once', date: '2045-06' };
    plan.links.push(save, draw);
    assert.equal(Plan.makeTwoWay(plan, save), true);
    assert.deepEqual([save.back.mode, save.back.when, save.back.date], ['rest', 'once', '2045-06']);
});

test('a way back saved when it turned around starts at its age, or now', () => {
    const { plan, nodes: [chk, fund] } = planWith('bank-account', 'investment');
    const save = Plan.createLink(plan, chk.id, fund.id);
    plan.links.push(save);
    const raw = JSON.parse(JSON.stringify(plan));
    const old = { mode: 'fixed', value: 2000, when: 'monthly', month: 1, growth: 0, income: null, age: 65 };
    raw.links[0].back = { ...old, turn: 'age', date: null };
    assert.deepEqual(Plan.validatePlan(raw).links[0].back.startWhen, { kind: 'age', age: 65 });
    // Sent once on a turn date, it keeps that date as its own.
    raw.links[0].back = { ...old, when: 'once', turn: 'date', date: '2050-01' };
    const back = Plan.validatePlan(raw).links[0].back;
    assert.deepEqual([back.startWhen, back.when, back.date, 'turn' in back], [null, 'once', '2050-01', false]);
});

test('a copied plan keeps the account a start waits on', () => {
    const { plan, nodes: [chk, fund] } = planWith('bank-account', 'investment');
    const save = { ...Plan.createLink(plan, chk.id, fund.id), startWhen: { kind: 'balance', account: chk.id, amount: 5000 } };
    plan.links.push(save);
    Plan.makeTwoWay(plan, save);
    save.back.startWhen = { kind: 'balance', account: fund.id, amount: 1e6 };
    const copy = Plan.cloneWithNewIds(plan, 'Copy');
    assert.equal(copy.links[0].startWhen.account, copy.nodes[0].id);
    assert.equal(copy.links[0].back.startWhen.account, copy.nodes[1].id);
});

test('year-month arithmetic', () => {
    assert.equal(Plan.ymAdd('2026-11', 3), '2027-02');
    assert.equal(Plan.ymAdd('2026-01', -1), '2025-12');
    assert.equal(Plan.ymDiff('2026-10', '2031-10'), 60);
    assert.equal(Plan.ymLabel('2028-03'), 'Mar 2028');
    assert.equal(Plan.ymParse('2026-13'), null);
    assert.equal(Plan.ymParse('26-01'), null);
});

test('a new module starts empty: no amounts, rates or dates are pre-filled', () => {
    for (const p of Catalog.PRESETS) {
        const params = Catalog.defaultParams(p);
        for (const [key, value] of Object.entries(params)) {
            if (FIELD_CADENCE.has(key) || (p.fixed && key in p.fixed)) continue;
            assert.ok(value === 0 || value === null, `${p.id}.${key} starts as ${value}`);
        }
        if (p.inLink) assert.equal(p.inLink.value, 0, `${p.id} inLink`);
    }
    const { nodes } = planWith('term-deposit');
    assert.equal(nodes[0].params.lockUntil, null);
});

test('a one-time expense is pinned to once and hides its cadence', () => {
    const p = Catalog.preset('one-time-expense');
    assert.equal(Catalog.defaultParams(p).per, 'once');
    assert.deepEqual(Catalog.fieldsFor(p), ['cost', 'start']);
    assert.equal(Plan.RETIRED_TYPES['one-time-expense'], undefined);
});

test('a link into a one-time expense starts on a date, and on its cost once it has one', () => {
    const { plan, nodes: [checking, trip] } = planWith('bank-account', 'one-time-expense');
    const first = Plan.createLink(plan, checking.id, trip.id);
    assert.equal(first.when, 'once');
    assert.ok(first.date, 'a once link needs a date');
    trip.params.cost = 8000;
    assert.equal(Plan.createLink(plan, checking.id, trip.id).mode, 'cost');
});

test('links: nothing into income, no self links, no duplicates, spending sends nothing, a budget group is a modifier', () => {
    const { plan, nodes: [salary, living, savings, card, rent] } = planWith('salary', 'living', 'bank-account', 'credit-card', 'expense');
    assert.equal(Plan.roleOf(living), 'modifier');
    assert.equal(Plan.canConnect(plan, salary.id, living.id).ok, true);
    assert.equal(Plan.canConnect(plan, living.id, salary.id).reason, 'role');
    assert.equal(Plan.canConnect(plan, salary.id, salary.id).reason, 'self');
    assert.equal(Plan.canConnect(plan, living.id, savings.id).ok, true);
    assert.equal(Plan.canConnect(plan, living.id, rent.id).ok, true);
    assert.equal(Plan.canConnect(plan, card.id, living.id, 'charges').reason, 'basis');
    assert.equal(Plan.canConnect(plan, rent.id, living.id).reason, 'role');
    assert.deepEqual(Plan.basesFor(rent), []);
    plan.links.push(Plan.createLink(plan, salary.id, living.id));
    assert.equal(Plan.canConnect(plan, salary.id, living.id).reason, 'duplicate');
});

test('default rules: links start on %, the first at 100, the next a slice, a priced target asks its price', () => {
    const { plan, nodes: [salary, living, savings, rent] } = planWith('salary', 'living', 'bank-account', 'expense');
    const first = Plan.createLink(plan, salary.id, living.id);
    plan.links.push(first);
    assert.deepEqual([first.mode, first.value], ['percent', 100]);
    const second = Plan.createLink(plan, salary.id, savings.id);
    plan.links.push(second);
    assert.deepEqual([second.mode, second.value], ['percent', 10]);
    const third = Plan.createLink(plan, salary.id, rent.id);
    assert.deepEqual([third.mode, third.value, third.when], ['fixed', 0, 'monthly']);
});

test('default rules: an account sends a fixed amount from its balance', () => {
    const { plan, nodes: [brokerage, savings, rent] } = planWith('investment', 'bank-account', 'expense');
    const toAccount = Plan.createLink(plan, brokerage.id, savings.id);
    assert.deepEqual([toAccount.basis, toAccount.mode, toAccount.value, toAccount.when], ['balance', 'fixed', 500, 'monthly']);
    const toBill = Plan.createLink(plan, savings.id, rent.id);
    assert.deepEqual([toBill.basis, toBill.mode], ['balance', 'fixed']);
});

test('a debt dated inside the plan offers its proceeds first', () => {
    const { plan, nodes: [mortgage, savings] } = planWith('loan', 'bank-account');
    mortgage.params.start = '2027-06';
    const l = Plan.createLink(plan, mortgage.id, savings.id);
    assert.deepEqual([l.basis, l.mode], ['proceeds', 'percent']);
    mortgage.params.start = null;
    Plan.fitRule(l, mortgage);
    assert.equal(l.basis, 'inflow');
});

test('no rule asks for "the payment due": a saved one becomes the fixed payment it was making', () => {
    const { plan, nodes: [salary, loan, card, shop] } = planWith('salary', 'loan', 'credit-card', 'expense');
    Object.assign(loan.params, { balance: 20000, rate: 7, term: 3 });
    Object.assign(card.params, { balance: 300 });
    for (const node of [salary, loan, card]) {
        for (const basis of Object.keys(Plan.RULES[Plan.roleOf(node)])) {
            assert.ok(!Plan.modesFor(node, basis).includes('due'), `${node.type} ${basis}`);
        }
    }
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        { id: 'l_loan', from: salary.id, to: loan.id, ...rule, basis: 'inflow', mode: 'due' },
        { id: 'l_card', from: salary.id, to: card.id, ...rule, basis: 'inflow', mode: 'due' },
        { id: 'l_buy', from: card.id, to: shop.id, ...rule, basis: 'charges', mode: 'fixed', value: 100 },
    );
    const v = roundTrip(plan);
    const get = (id) => v.links.find((l) => l.id === id);
    assert.deepEqual([get('l_loan').mode, get('l_loan').when], ['fixed', 'monthly']);
    // A saved loan carried its years left; the payment it asked is level over them.
    const r = 7 / 1200;
    close(get('l_loan').value, 20000 * r / (1 - Math.pow(1 + r, -36)));
    assert.deepEqual([get('l_card').mode, get('l_card').value], ['fixed', 400], 'the balance plus a month of purchases');
});

test('pre-tax links: income into a Retirement Account, and nothing else', () => {
    const { plan, nodes: [salary, k, roth, savings] } = planWith('salary', '401k', 'investment', 'bank-account');
    const into = (a, b) => { const l = Plan.createLink(plan, a.id, b.id); plan.links.push(l); return l; };
    assert.equal(Plan.isPretax(plan, into(salary, k)), true);
    assert.equal(Plan.isPretax(plan, into(salary, roth)), false);
    assert.equal(Plan.isPretax(plan, into(salary, savings)), false);
    assert.equal(Plan.isPretax(plan, into(savings, k)), false);   // only pay is pre-tax
});

test('a saved Match module folds into the 401(k) it fed', () => {
    const { plan, nodes: [salary, pay, k, roth] } = planWith('salary', 'paycheck', 'investment', 'investment');
    // Saved before the Tax-advantaged account was retired.
    Object.assign(k, { type: 'tax-advantaged-account' });
    Object.assign(roth, { type: 'tax-advantaged-account' });
    k.params.contributions = 'pre';
    roth.params.contributions = 'after';
    const rule = { value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.nodes.push(
        { id: 'n_match', type: 'employer-match', name: 'Match', x: 0, y: 0, params: { rate: 50, capYearly: 3000 } },
        { id: 'n_lost', type: 'employer-match', name: 'Roth match', x: 0, y: 0, params: { rate: 100, capYearly: null } });
    plan.links.push(
        { ...rule, id: 'l_k', from: salary.id, to: k.id, mode: 'percent', value: 6 },
        { ...rule, id: 'l_seen', from: salary.id, to: 'n_match', mode: 'percent', value: 6 },
        { ...rule, id: 'l_told', from: pay.id, to: 'n_match', mode: 'fixed', value: 200 },
        { ...rule, id: 'l_in', from: 'n_match', to: k.id, mode: 'rest' },
        { ...rule, id: 'l_roth', from: pay.id, to: 'n_lost', mode: 'fixed', value: 100 },
        { ...rule, id: 'l_out', from: 'n_lost', to: roth.id, mode: 'rest' });
    const before = JSON.stringify(plan);
    const v = Plan.validatePlan(plan);
    assert.equal(JSON.stringify(plan), before, 'the saved plan is not touched');
    const saved = v.nodes.find((n) => n.id === k.id);
    assert.equal(saved.type, '401k');
    assert.deepEqual([saved.params.match, saved.params.matchLimit], [50, 3000]);
    assert.equal(v.nodes.some((n) => n.type === 'employer-match'), false);
    // Pay already going to the 401(k) stays as it was; pay only told to the match now goes there.
    assert.deepEqual(v.links.map((l) => l.id).sort(), ['l_k', 'l_told']);
    assert.equal(v.links.find((l) => l.id === 'l_told').to, k.id);
    // A match that fed no pre-tax account is dropped, and the Roth opens as an Investment.
    assert.equal(v.nodes.find((n) => n.id === roth.id).type, 'investment');
});

test('a pre-tax account opens as a Retirement Account and an after-tax one as an Investment', () => {
    const { plan, nodes } = planWith('bank-account', 'bank-account', 'bank-account', 'bank-account', 'bank-account', 'bank-account');
    const saved = [
        ['pretax-account', {}], ['hsa', {}], ['tax-advantaged-account', { contributions: 'pre', match: 100 }],
        ['tax-free-account', {}], ['roth-ira', { capYearly: 7000 }], ['tax-advantaged-account', { contributions: 'after' }],
    ];
    nodes.forEach((n, i) => { n.type = saved[i][0]; n.params = { balance: 1000, rate: 5, ...saved[i][1] }; });
    const out = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    const got = nodes.map((n) => out.nodes.find((x) => x.id === n.id));
    assert.deepEqual(got.map((n) => n.type), ['401k', '401k', '401k', 'investment', 'investment', 'investment']);
    assert.ok(got.every((n) => n.params.balance === 1000), 'what was set is kept');
    assert.equal(got[2].params.match, 0, 'a match it never showed does not switch on');
    assert.equal(got[4].params.capYearly, null, 'an Investment has no yearly limit');
    assert.ok(got.every((n) => !('contributions' in n.params)));
    assert.equal(Catalog.preset('tax-advantaged-account'), null);
});

test('an Investment can be locked until a date', () => {
    assert.ok(Catalog.fieldsFor(Catalog.preset('investment')).includes('lockUntil'));
});

test('fitRule keeps a rule inside what its source allows', () => {
    const { nodes: [salary] } = planWith('salary');
    const l = { mode: 'above', basis: 'balance', when: 'once', value: 5 };
    Plan.fitRule(l, salary);
    assert.deepEqual([l.basis, l.mode, l.when], ['inflow', 'percent', 'monthly']);
});

test('validatePlan normalizes numbers and rejects structure it cannot trust', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'bank-account');
    plan.links.push({ ...Plan.createLink(plan, salary.id, savings.id), mode: 'percent', value: 250 });
    salary.params.tax = 400;
    salary.name = 'Pay\u0007 day';
    const v = Plan.validatePlan(plan);
    assert.equal(v.links[0].value, 100);
    assert.equal(v.nodes[0].params.tax, 95);
    assert.equal(v.nodes[0].name, 'Pay day');
    assert.notEqual(v, plan);

    const bad = (mutate, re) => {
        const copy = JSON.parse(JSON.stringify(plan));
        mutate(copy);
        assert.throws(() => Plan.validatePlan(copy), re);
    };
    bad((p) => { p.nodes[0].type = 'nope'; }, /unknown type/);
    bad((p) => { p.links[0].to = 'n_ghost'; }, /does not exist/);
    bad((p) => { p.links.push({ ...p.links[0], id: 'l_dup' }); }, /duplicates/);
    bad((p) => { Object.assign(p.links[0], { from: p.nodes[1].id, to: p.nodes[0].id, basis: 'balance' }); }, /cannot be linked/);
    bad((p) => { p.nodes[0].params.amount = 'lots'; }, /must be a number/);
    bad((p) => { p.settings.start = 'soon'; }, /month/);
    bad((p) => { p.nodes[0].id = '<script>'; }, /valid id/);
    bad((p) => { p.nodes = new Array(Plan.LIMITS.nodes + 1).fill(p.nodes[0]); }, /at most/);
});

test('two rest links on one basis cannot both stand', () => {
    const { plan, nodes: [salary, a, b] } = planWith('salary', 'living', 'bank-account');
    plan.links.push({ ...Plan.createLink(plan, salary.id, a.id), mode: 'rest' });
    plan.links.push({ ...Plan.createLink(plan, salary.id, b.id), mode: 'rest' });
    const v = Plan.validatePlan(plan);
    assert.deepEqual(v.links.map((l) => l.mode), ['rest', 'percent']);
});

test('cloneWithNewIds gives a plan that shares no id with the original', () => {
    const { plan, nodes: [salary, savings] } = planWith('salary', 'bank-account');
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    const copy = Plan.cloneWithNewIds(plan, 'Copy');
    const ids = (p) => [p.id, ...p.nodes.map((n) => n.id), ...p.links.map((l) => l.id)];
    assert.equal(ids(copy).filter((id) => ids(plan).includes(id)).length, 0);
    assert.equal(copy.links[0].from, copy.nodes[0].id);
    assert.doesNotThrow(() => Plan.validatePlan(copy));
});

test('a saved loan that still has years left loads without it', () => {
    const { plan, nodes: [loan] } = planWith('loan');
    Object.assign(loan.params, { balance: 5000, rate: 6, term: 4 });
    const v = roundTrip(plan);
    assert.ok(!('term' in v.nodes[0].params));
    assert.equal(v.nodes[0].params.balance, 5000);
});

test('default rules: a debt is paid a round monthly figure, a 401(k) a slice of pay', () => {
    const { plan, nodes: [salary, loan, k, savings] } = planWith('salary', 'loan', '401k', 'bank-account');
    Object.assign(loan.params, { balance: 12000, rate: 0 });
    const pay = Plan.createLink(plan, salary.id, loan.id);
    assert.deepEqual([pay.mode, pay.value, pay.when], ['fixed', 500, 'monthly']);
    const fromSavings = Plan.createLink(plan, savings.id, loan.id);
    assert.deepEqual([fromSavings.basis, fromSavings.mode, fromSavings.value], ['balance', 'fixed', 500]);
    const contribute = Plan.createLink(plan, salary.id, k.id);
    assert.deepEqual([contribute.mode, contribute.value], ['percent', 6]);
});

// ── Age ──────────────────────────────────────────────────────────────────────

test('a plan has no age until one is given, and the age counts from the plan\'s start', () => {
    const { plan } = planWith();
    assert.equal(plan.settings.age, null);
    assert.equal(Plan.ageAt(plan, '2030-01'), null);
    Object.assign(plan.settings, { age: 34, start: '2026-10' });
    assert.equal(Plan.ageAt(plan, '2026-10'), 34);
    assert.equal(Plan.ageAt(plan, '2027-09'), 34);
    assert.equal(Plan.ageAt(plan, '2027-10'), 35);
});

test('the age is checked on save, and a plan saved without one opens without one', () => {
    const { plan } = planWith('salary');
    plan.settings.age = 41.5;
    assert.equal(Plan.validatePlan(JSON.parse(JSON.stringify(plan))).settings.age, 41.5);
    delete plan.settings.age;
    assert.equal(Plan.validatePlan(JSON.parse(JSON.stringify(plan))).settings.age, null);
    plan.settings.age = 400;
    assert.equal(Plan.validatePlan(JSON.parse(JSON.stringify(plan))).settings.age, Plan.GOAL_AGE.max, 'an age is kept in range');
    plan.settings.age = 'old';
    assert.throws(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))), Plan.PlanError);
});

test('a saved Person module is dropped with its links, and the rest of the plan stays', () => {
    const { plan, nodes: [pay, savings] } = planWith('paycheck', 'bank-account');
    const me = { id: 'n_me', type: 'person', name: 'You', x: 0, y: 0, params: { age: 30, planStart: '2025-03' } };
    plan.nodes.push(me);
    plan.links.push(Plan.createLink(plan, pay.id, savings.id));
    // A person's link was { basis: 'person', mode: 'rest', when: 'monthly' }.
    plan.links.push({ ...Plan.createLink(plan, pay.id, savings.id), id: 'l_p', from: me.id, to: pay.id, basis: 'person', mode: 'rest' });
    const out = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(out.nodes.map((n) => n.type), ['paycheck', 'bank-account']);
    assert.equal(out.links.length, 1);
    assert.equal(out.settings.start, '2026-01', 'the plan keeps its start');
    assert.equal(out.settings.age, null);
    assert.ok(!Catalog.preset('person'), 'the library no longer has one');
});

// ── What a link carries ──────────────────────────────────────────────────────

test('each module can send one thing per basis', () => {
    const { nodes: [salary, checking, groceries, living, mortgage, card] } = planWith('salary', 'bank-account', 'expense', 'living', 'loan', 'credit-card');
    const bases = (n) => Plan.basesFor(n);
    assert.deepEqual(bases(salary), ['inflow']);
    assert.deepEqual(bases(checking), ['balance'], 'an account sends only from its balance');
    assert.deepEqual(bases(groceries), []);
    assert.deepEqual(bases(living), ['inflow']);
    assert.deepEqual(bases(mortgage), ['inflow']);
    assert.deepEqual(bases(card), ['charges'], 'a card is paid, and pays only for purchases');
    mortgage.params.start = '2026-06';
    assert.deepEqual(bases(mortgage), ['inflow', 'proceeds']);
});

test('a basis reaches only the roles it can send to', () => {
    const { plan, nodes: [checking, card, groceries, savings, mortgage] } = planWith('bank-account', 'credit-card', 'expense', 'bank-account', 'loan');
    assert.deepEqual(Plan.portTargets(card, 'charges'), ['expense']);
    assert.equal(Plan.canConnect(plan, card.id, groceries.id, 'charges').ok, true);
    assert.equal(Plan.canConnect(plan, card.id, savings.id, 'charges').reason, 'basis');
    assert.equal(Plan.canConnect(plan, card.id, savings.id).reason, 'basis', 'cash back is a setting, not a link');
    assert.equal(Plan.canConnect(plan, card.id, mortgage.id).reason, 'basis');
    assert.equal(Plan.canConnect(plan, mortgage.id, savings.id, 'inflow').ok, true, 'a loan still passes overpayment on');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'balance').ok, true);
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'inflow').reason, 'basis', 'no deposits port on an account');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'earnings').reason, 'basis');
    assert.equal(Plan.canConnect(plan, checking.id, mortgage.id, 'charges').reason, 'basis');
});

test('two modules link once per basis, not once in all', () => {
    const { plan, nodes: [loan, savings] } = planWith('loan', 'bank-account');
    loan.params.start = '2027-01';
    const a = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    assert.equal(a.basis, 'proceeds');
    plan.links.push(a);
    assert.equal(Plan.canConnect(plan, loan.id, savings.id, 'proceeds').reason, 'duplicate');
    assert.equal(Plan.canConnect(plan, loan.id, savings.id, 'inflow').ok, true);
});

test('a link asked to start on a basis starts there with a sensible rule', () => {
    const { plan, nodes: [loan, savings, checking, card] } = planWith('loan', 'bank-account', 'bank-account', 'credit-card');
    loan.params.start = '2027-01';
    const proceeds = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    assert.deepEqual([proceeds.basis, proceeds.mode, proceeds.when], ['proceeds', 'percent', 'once']);
    const bal = Plan.createLink(plan, checking.id, card.id, 'balance');
    assert.deepEqual([bal.basis, bal.mode], ['balance', 'fixed']);
});

test('a balance link into Rent can send a fixed amount, and starts as one', () => {
    const { plan, nodes: [checking, rent] } = planWith('bank-account', 'expense');
    assert.deepEqual(Plan.modesFor(checking, 'balance'), ['percent', 'fixed', 'rest']);
    const l = Plan.createLink(plan, checking.id, rent.id, 'balance');
    assert.deepEqual([l.basis, l.mode, l.when], ['balance', 'fixed', 'monthly']);
});

test('a saved "above" link becomes the account\'s minimum, and the link takes the rest', () => {
    const { plan, nodes: [savings, brokerage, spend, cash] } = planWith('bank-account', 'investment', 'expense', 'bank-account');
    const raw = (to, mode, value) => ({ ...Plan.createLink(plan, savings.id, to.id, 'balance'), mode, value, when: 'monthly' });
    const sweep = raw(brokerage, 'above', 5000);
    const later = raw(spend, 'above', 2000);
    const rest = raw(cash, 'rest', 0);
    plan.links.push(rest, sweep, later);
    const v = Plan.validatePlan(plan);
    const byId = (l) => v.links.find((x) => x.id === l.id);
    assert.equal(v.nodes[0].params.minBalance, 5000);
    assert.deepEqual([byId(sweep).mode, byId(sweep).value], ['rest', 0]);
    // The others only got what the minimum now keeps, so they send nothing.
    assert.deepEqual([byId(later).mode, byId(later).value], ['percent', 0]);
    assert.deepEqual([byId(rest).mode, byId(rest).value], ['percent', 0]);
    // A minimum already set stays.
    plan.nodes[0].params.minBalance = 1000;
    assert.equal(Plan.validatePlan(plan).nodes[0].params.minBalance, 1000);
});

test('a link into an expense with a cost starts by paying it; a second link cannot', () => {
    const { plan, nodes: [salary, checking, rent, loan] } = planWith('salary', 'bank-account', 'expense', 'loan');
    // No cost set: a new link starts as a fixed amount, as before.
    assert.equal(Plan.createLink(plan, salary.id, rent.id).mode, 'fixed');
    rent.params.cost = 1800;
    const first = Plan.createLink(plan, salary.id, rent.id);
    assert.deepEqual([first.mode, first.when], ['cost', 'monthly']);
    plan.links.push(first);
    assert.equal(Plan.createLink(plan, checking.id, rent.id).mode, 'fixed');
    // Cost is offered only into spending, and not from a loan's proceeds.
    assert.ok(Plan.modesFor(checking, 'balance', rent).includes('cost'));
    assert.ok(!Plan.modesFor(checking, 'balance', loan).includes('cost'));
    assert.ok(!Plan.modesFor(loan, 'proceeds', rent).includes('cost'));
    assert.deepEqual(Plan.timingsFor('balance', 'cost'), ['monthly']);
});

test('validatePlan keeps one link paying an expense\'s cost', () => {
    const { plan, nodes: [salary, checking, rent, savings] } = planWith('salary', 'bank-account', 'expense', 'bank-account');
    rent.params.cost = 1800;
    const a = { ...Plan.createLink(plan, salary.id, rent.id), mode: 'cost' };
    const b = { ...Plan.createLink(plan, checking.id, rent.id, 'balance'), mode: 'cost' };
    const c = { ...Plan.createLink(plan, salary.id, savings.id), mode: 'cost' };
    plan.links.push(a, b, c);
    const v = Plan.validatePlan(plan);
    const byId = (l) => v.links.find((x) => x.id === l.id);
    assert.equal(byId(a).mode, 'cost');
    assert.deepEqual([byId(b).mode, byId(b).value], ['fixed', 0]);
    // A cost link into anything but spending is refitted.
    assert.notEqual(byId(c).mode, 'cost');
    assert.equal(v.nodes[2].params.cost, 1800);
});

test('moving a cost link onto an expense already paid for makes it a fixed amount', () => {
    const { plan, nodes: [salary, checking, rent, food] } = planWith('salary', 'bank-account', 'expense', 'expense');
    rent.params.cost = 1800;
    food.params.cost = 600;
    const paysRent = Plan.createLink(plan, checking.id, rent.id);
    plan.links.push(paysRent, Plan.createLink(plan, salary.id, food.id));
    assert.equal(paysRent.mode, 'cost');
    assert.ok(Plan.reconnect(plan, paysRent, food.id).ok);
    assert.equal(paysRent.mode, 'fixed');
});

test('a link\'s sending end moves to another module and keeps a valid rule', () => {
    const { plan, nodes: [salary, checking, savings, rent] } = planWith('salary', 'bank-account', 'bank-account', 'expense');
    const l = Plan.createLink(plan, salary.id, savings.id);
    plan.links.push(l);
    assert.ok(Plan.reconnect(plan, l, checking.id, 't', 'from').ok);
    assert.equal(l.from, checking.id);
    assert.equal(l.to, savings.id);
    assert.equal(l.fromSide, 't');
    assert.ok(Plan.basesFor(checking).includes(l.basis));
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
    // Spending sends nothing on, so it cannot become the sending end.
    assert.equal(Plan.reconnect(plan, l, rent.id, null, 'from').reason, 'role');
    assert.equal(l.from, checking.id);
});

test('an expense saved before costs opens with none', () => {
    const { plan, nodes: [rent] } = planWith('expense');
    rent.params = {};
    assert.deepEqual(Plan.validatePlan(plan).nodes[0].params,
        { cost: null, per: 'month', payMonth: 0, growth: 0, start: null, end: null });
});

test('validatePlan rejects a link on a basis that cannot reach the target', () => {
    const { plan, nodes: [card, shop, savings] } = planWith('credit-card', 'expense', 'bank-account');
    const l = Plan.createLink(plan, card.id, shop.id, 'charges');
    plan.links.push(l);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
    l.to = savings.id;
    assert.throws(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))), /cannot take it/);
});

test('a plan with two links between the same modules on different bases saves', () => {
    const { plan, nodes: [loan, savings] } = planWith('loan', 'bank-account');
    loan.params.start = '2027-01';
    plan.links.push(Plan.createLink(plan, loan.id, savings.id, 'proceeds'));
    plan.links.push(Plan.createLink(plan, loan.id, savings.id, 'inflow'));
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

// ── Removed presets ──────────────────────────────────────────────────────────

test('a saved plan that holds a removed module opens without it and its links', () => {
    const { plan, nodes: [salary, savings, loan] } = planWith('salary', 'bank-account', 'loan');
    const raw = JSON.parse(JSON.stringify(plan));
    const gone = { id: 'n_home', type: 'real-estate', name: 'Home', x: 40, y: 40, dock: loan.id, params: { value: 300000, rate: 3 } };
    loan.dock = gone.id;
    raw.nodes = JSON.parse(JSON.stringify(plan.nodes));
    raw.nodes.push(gone);
    raw.links = [
        { id: 'l_keep', from: salary.id, to: savings.id, mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 },
        { id: 'l_gone', from: savings.id, to: gone.id, mode: 'fixed', value: 500, basis: 'balance', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 },
    ];
    const v = Plan.validatePlan(raw);
    assert.deepEqual(v.nodes.map((n) => n.id), [salary.id, savings.id, loan.id]);
    assert.deepEqual(v.links.map((l) => l.id), ['l_keep']);
    assert.equal(v.nodes.find((n) => n.id === loan.id).dock, undefined);
    for (const type of ['real-estate', 'rental-property', 'vehicle', 'home', 'land']) {
        assert.ok(Plan.REMOVED_TYPES.has(type), type);
        assert.equal(Catalog.preset(type), null, type);
    }
});

test('a saved plan with a Tax or fee module opens without it, and the Modifiers shelf is gone', () => {
    const { plan, nodes: [pay, savings] } = planWith('paycheck', 'bank-account');
    const raw = JSON.parse(JSON.stringify(plan));
    const rule = { mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    raw.nodes.push(
        { id: 'n_tax', type: 'tax-or-fee', name: 'Tax', x: 40, y: 40, params: { rate: 20 } },
        { id: 'n_fee', type: 'fee', name: 'Fee', x: 80, y: 80, params: { rate: 1 } });
    raw.links = [
        { id: 'l_in', from: pay.id, to: 'n_tax', ...rule },
        { id: 'l_out', from: 'n_tax', to: savings.id, ...rule },
        { id: 'l_keep', from: pay.id, to: savings.id, ...rule, mode: 'fixed', value: 100 },
    ];
    const v = Plan.validatePlan(raw);
    assert.deepEqual(v.nodes.map((n) => n.id), [pay.id, savings.id]);
    assert.deepEqual(v.links.map((l) => l.id), ['l_keep']);
    for (const type of ['tax-or-fee', 'tax', 'fee']) assert.equal(Catalog.preset(type), null, type);
    assert.ok(!Catalog.CATEGORIES.some((c) => c.id === 'modifiers'));
    // The budget group is still a modifier, and the only one.
    assert.deepEqual(Catalog.PRESETS.filter((p) => p.role === 'modifier').map((p) => p.id), ['living']);
});

test('older plans lose spending links that are no longer allowed', () => {
    const { plan, nodes: [living, rent, groceries] } = planWith('living', 'expense', 'expense');
    const keep = Plan.createLink(plan, living.id, rent.id);
    const drop = Plan.createLink(plan, rent.id, groceries.id);
    plan.links.push(keep, drop);
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.links.map((l) => l.id), [keep.id]);
});

test('older plans lose a card charge into a budget group', () => {
    const { plan, nodes: [card, living, rent] } = planWith('credit-card', 'living', 'expense');
    const charge = Plan.createLink(plan, card.id, rent.id, 'charges');
    const toGroup = { ...charge, id: 'l-old', to: living.id };
    plan.links.push(charge, toGroup);
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.links.map((l) => l.id), [charge.id]);
});

test('retired banking types open as a Bank account or Term deposit wearing their old icon', () => {
    const old = ['checking', 'savings', 'hysa', 'money-market', 'emergency-fund', 'cash', 'cd'];
    const { plan } = planWith(...old.map(() => 'bank-account'));
    plan.nodes.forEach((n, i) => { n.type = old[i]; });
    const loaded = Plan.validatePlan(JSON.parse(JSON.stringify(plan)));
    assert.deepEqual(loaded.nodes.map((n) => [n.type, Plan.iconOf(n)]), [
        ['bank-account', 'wallet'], ['bank-account', 'piggy-bank'], ['bank-account', 'vault'],
        ['bank-account', 'coin-vertical'], ['bank-account', 'lifebuoy'], ['bank-account', 'money-wavy'],
        ['term-deposit', 'certificate']]);
});

test('connecting a pair again takes the next free basis, until none is left', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const seen = [];
    for (let i = 0; i < 2; i++) {
        assert.equal(Plan.canConnect(plan, a.id, b.id).ok, true);
        const l = Plan.createLink(plan, a.id, b.id);
        seen.push(l.basis);
        plan.links.push(l);
    }
    assert.deepEqual(seen.sort(), ['inflow', 'proceeds']);
    assert.equal(Plan.canConnect(plan, a.id, b.id).reason, 'duplicate');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('a link may move to any basis the pair has free, and to no other', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const l = Plan.createLink(plan, a.id, b.id, 'proceeds');
    plan.links.push(l);
    assert.deepEqual(Plan.basesBetween(plan, a, b, l.id), ['inflow', 'proceeds']);
    assert.deepEqual(Plan.basesBetween(plan, a, b), ['inflow']);
    const other = Plan.createLink(plan, a.id, b.id, 'inflow');
    plan.links.push(other);
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), false, 'taken by another link');
    assert.equal(l.basis, 'proceeds');
    plan.links.pop();
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), true);
    assert.equal(l.basis, 'inflow');
});

test('moving a link to another basis restarts its amount, and keeps its window', () => {
    const { plan, nodes: [a, b] } = planWith('loan', 'bank-account');
    a.params.start = '2027-01';
    const l = Plan.createLink(plan, a.id, b.id, 'inflow');
    Object.assign(l, { mode: 'fixed', value: 500, start: '2027-01', end: '2028-01' });
    plan.links.push(l);
    assert.equal(Plan.changeBasis(plan, l, 'proceeds'), true);
    assert.deepEqual([l.basis, l.mode, l.value, l.start, l.end], ['proceeds', 'percent', 100, '2027-01', '2028-01']);
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('moving a link to a basis where another already takes the rest shares instead', () => {
    const { plan, nodes: [loan, savings, checking] } = planWith('loan', 'bank-account', 'bank-account');
    loan.params.start = '2028-01';
    const first = Plan.createLink(plan, loan.id, savings.id, 'proceeds');
    const second = Plan.createLink(plan, loan.id, checking.id, 'inflow');
    first.mode = 'rest';
    plan.links.push(first, second);
    assert.equal(Plan.changeBasis(plan, second, 'proceeds'), true);
    assert.equal(second.mode, 'percent');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

test('a card link is always a purchase, with a valid rule', () => {
    const { plan, nodes: [card, shop] } = planWith('credit-card', 'expense');
    const l = Plan.createLink(plan, card.id, shop.id);
    plan.links.push(l);
    assert.equal(l.basis, 'charges');
    assert.deepEqual([l.mode, l.when], ['fixed', 'monthly']);
    assert.equal(Plan.changeBasis(plan, l, 'inflow'), false, 'a card sends nothing on');
    assert.doesNotThrow(() => Plan.validatePlan(JSON.parse(JSON.stringify(plan))));
});

// ── A card's cash back setting ──────────────────────────────────────────────

const roundTrip = (plan) => Plan.validatePlan(JSON.parse(JSON.stringify(plan)));

test('a card keeps the account its cash back goes to, and loses one that is gone', () => {
    const { plan, nodes: [card, savings, shop] } = planWith('credit-card', 'bank-account', 'expense');
    assert.equal(card.params.cashBackTo, null);
    card.params.cashBackTo = savings.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, savings.id);
    card.params.cashBackTo = shop.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, null, 'only an account can take cash back');
    card.params.cashBackTo = 'n_gone';
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, null);
});

test('a copy of a plan sends cash back to the copy of the account', () => {
    const { plan, nodes: [card, savings] } = planWith('credit-card', 'bank-account');
    card.params.cashBackTo = savings.id;
    const copy = Plan.cloneWithNewIds(plan);
    assert.notEqual(copy.nodes[1].id, savings.id);
    assert.equal(copy.nodes[0].params.cashBackTo, copy.nodes[1].id);
});

test('an older plan\'s cash back links become the card\'s setting, and its overflow links go', () => {
    const { plan, nodes: [card, checking, savings, mortgage, shop] } = planWith('credit-card', 'bank-account', 'bank-account', 'loan', 'expense');
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        { id: 'l_charge', from: card.id, to: shop.id, ...rule, basis: 'charges', mode: 'fixed', value: 100 },
        { id: 'l_back1', from: card.id, to: checking.id, ...rule, basis: 'cashback', mode: 'percent', value: 30 },
        { id: 'l_back2', from: card.id, to: savings.id, ...rule, basis: 'cashback', mode: 'rest' },
        { id: 'l_over', from: card.id, to: mortgage.id, ...rule, basis: 'inflow', mode: 'rest' },
    );
    const out = roundTrip(plan);
    assert.equal(out.nodes[0].params.cashBackTo, savings.id, 'the account that got most of it');
    assert.deepEqual(out.links.map((l) => l.id), ['l_charge']);
    // A card that already has a setting keeps it.
    card.params.cashBackTo = checking.id;
    assert.equal(roundTrip(plan).nodes[0].params.cashBackTo, checking.id);
    // Cash back that went against a debt just credits the card again.
    card.params.cashBackTo = null;
    plan.links = plan.links.filter((l) => l.id === 'l_charge');
    plan.links.push({ id: 'l_debt', from: card.id, to: mortgage.id, ...rule, basis: 'cashback', mode: 'rest' });
    const debtOnly = roundTrip(plan);
    assert.equal(debtOnly.nodes[0].params.cashBackTo, null);
    assert.deepEqual(debtOnly.links.map((l) => l.id), ['l_charge']);
});

test('a loan can still pass overpayment on', () => {
    const { plan, nodes: [mortgage, savings] } = planWith('loan', 'bank-account');
    const l = Plan.createLink(plan, mortgage.id, savings.id, 'inflow');
    plan.links.push(l);
    assert.doesNotThrow(() => roundTrip(plan));
    assert.equal(roundTrip(plan).links.length, 1);
});

// ── Account outflows and card limits ─────────────────────────────────────────

test('saved deposit and earnings links out of an account follow the balance rule', () => {
    const { plan, nodes: [checking, savings, brokerage, rent] } = planWith('bank-account', 'bank-account', 'investment', 'expense');
    const rule = { value: 0, when: 'monthly', month: 1, date: null, start: null, end: null, growth: 0 };
    plan.links.push(
        // A fixed deposit link becomes the same amount from the balance.
        { id: 'l_fixed', from: checking.id, to: rent.id, ...rule, basis: 'inflow', mode: 'fixed', value: 1500 },
        // A share of deposits or earnings has no equivalent and is dropped.
        { id: 'l_share', from: checking.id, to: savings.id, ...rule, basis: 'inflow', mode: 'percent', value: 25 },
        { id: 'l_earn', from: brokerage.id, to: savings.id, ...rule, basis: 'earnings', mode: 'percent', value: 50 },
        // A fixed deposit link beside a balance link on the same pair cannot also stand.
        { id: 'l_twin_a', from: savings.id, to: rent.id, ...rule, basis: 'inflow', mode: 'fixed', value: 100 },
        { id: 'l_twin_b', from: savings.id, to: rent.id, ...rule, basis: 'balance', mode: 'fixed', value: 200 },
    );
    const v = roundTrip(plan);
    assert.deepEqual(v.links.map((l) => [l.id, l.basis, l.value]), [
        ['l_fixed', 'balance', 1500], ['l_twin_b', 'balance', 200]]);
});

test('a card has a credit limit setting, and its purchases can be a share of it or the credit left', () => {
    const { plan, nodes: [card, shop] } = planWith('credit-card', 'expense');
    assert.equal(card.params.limit, null);
    assert.ok(Catalog.fieldsFor(Catalog.preset('credit-card')).includes('limit'));
    assert.ok(!Catalog.fieldsFor(Catalog.preset('loan')).includes('limit'), 'only a card has a limit');
    assert.deepEqual(Plan.modesFor(card, 'charges'), ['fixed', 'percent', 'rest']);
    card.params.limit = 8000;
    for (const mode of ['percent', 'rest']) {
        const l = { ...Plan.createLink(plan, card.id, shop.id, 'charges'), mode, value: 10 };
        plan.links = [l];
        const v = roundTrip(plan);
        assert.equal(v.nodes[0].params.limit, 8000);
        assert.equal(v.links[0].mode, mode);
    }
    card.params.limit = -5;
    assert.equal(roundTrip(plan).nodes[0].params.limit, 0, 'a limit is clamped into range');
    card.params.limit = null;
    assert.equal(roundTrip(plan).nodes[0].params.limit, null);
});

