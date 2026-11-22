'use strict';

// ─── plan.js ────────────────────────────────────────────────────────────────
// The plan document: its shape, how modules and links are created, which
// links are allowed, and the validator that every save passes through.
//
// A plan is plain JSON:
//
//   { id, name, version, createdAt, updatedAt,
//     settings: { start: 'YYYY-MM', years, inflation, age, retireAge },
//     view:     { x, y, zoom },            canvas camera, restored on open
//     nodes:    [{ id, type, name, x, y, params, icon? }],
//     links:    [{ id, from, to, mode, value, basis, when, month, date,
//                  start, end, growth }] }
//
// `type` is a preset id from catalog.js, which fixes the node's role.
//
// `age` is the age of the person the plan is for, at its start (null when not
// given). It dates a goal's age deadline and labels the charts.
//
// `retireAge` is the age that person means to retire at (null when not
// given). An income may stop at it and a link may start at it, so changing
// it moves every one of them at once (incomeEnd, startAgeMonth).
//
// GOALS are shared by all of a user's plans, not part of any one: a list kept
// beside the plans (validateGoals). Each goal is one rule, a sentence of four
// parts (GOAL_METRICS and the rest below):
//
//   { id, name,
//     metric,          what is measured: 'net-worth' | 'savings' | 'debt' |
//                      'expenses' | 'income'
//     op,              'gte' (is at least) | 'lte' (is at most)
//     unit, value, of, the target: 'amount' (value dollars), 'times' (value
//                      times the `of` measure) or 'percent' (value percent of it)
//     due, by, age,    the deadline: 'date' (the month `by`) or 'age' (the
//                      month the plan's person turns `age`). Every goal has one;
//                      a goal saved with none ('none') is read as due ten years
//                      from now
//     color }          the card's colour (GOAL_COLORS), only for show
//
// e.g. "Net worth is at least 25 times yearly expenses by age 65". Every plan
// is measured against every goal (sim/goals.js works out when each is met).
// Goals move no money and are not drawn on the canvas. Goals of the kinds
// that came before rules (net worth, savings, debt-free, FI, retiring) are
// read as the rules they meant. Plans saved before goals were shared held
// their own; those are read out of the old plan (legacyGoals) and merged into
// the shared list, and a plan no longer keeps any.
//
// LINK RULES. Every link answers one question: how much of the money at its
// source moves to its target. The answer is a mode and a basis:
//
//   mode   percent  value% of the basis
//          fixed    value (a currency amount) each time the link fires
//          rest     whatever is left of the basis after the other links
//          cost     into spending only: the expense's own cost, when and as
//                   it falls due (its schedule and inflation, not the link's).
//                   One link per expense pays its cost.
//
// Out of an account, a percent or the rest is of the balance over the
// account's Keep at least (minBalance), when it has one.
//
//   basis  inflow    money arriving at the source. For income that is the
//                    paycheck; for spending, the spending; for a debt, what is
//                    paid beyond the payoff (loans only; a card sends nothing
//                    on).
//          balance   accounts only, and their only basis: everything an account
//                    sends comes out of its balance
//          proceeds  debts with a start date only: the amount borrowed
//          charges   credit cards only: a purchase the card pays for, charged
//                    to its balance and sent to spending. Percent is a share
//                    of the card's limit, rest is the credit left under it
//
// A card's cash back is not a link. It is the card's `cashBackTo` setting:
// empty credits the card's balance, an account's id deposits it there.
//
// A module has one output port. The basis is the link's own setting, chosen
// when it is edited ("From": a card's purchases or a loan's proceeds, say), and two modules
// may be linked once per basis.
//
// TWO-WAY LINKS. A link from one account to another may be two-way: `back`
// sends money the other way, with the same choices as the way out. Saving
// into a retirement fund and drawing from it from 65 is one link, not two.
// See makeTwoWay.
//
// STARTING. Each side of a link (the link, and its way back) starts now, or
// when a condition is first met (`startWhen`, see cleanStart): an age, or an
// account reaching a size. Once started it keeps running until it stops: never
// (`stopWhen` null or absent), or the first month a condition of the same
// kinds is met (`stopWhen`, see cleanStart). It does not run that month.
//
// Timing (`when`) is monthly, yearly (in the month it starts and every twelfth
// after) or once (on `date`, or the month it starts), with an
// optional window (`start` / `end`). Money that arrives is split as it
// arrives, so percent and rest links on an inflow are always monthly.
//
// Dual-environment: window.PlanModel in the renderer, CommonJS for the
// backend (which validates every save with validatePlan) and the tests.

(function (root, factory) {
    const Catalog = (typeof module === 'object' && module.exports)
        ? require('./catalog.js')
        : root.PlanCatalog;
    const api = factory(Catalog);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlanModel = api;
}(typeof self !== 'undefined' ? self : this, function (Catalog) {

    const PLAN_VERSION = 1;
    // Presets folded into another. A saved plan that holds one opens as its
    // survivor, wearing the icon the old preset had and keeping the name it
    // was given. A preset that was only a name and icon on another's behaviour
    // (Freelance on Paycheck, Checking on Bank account) is retired this way.
    // `params` are settings the old preset stood for, which the survivor now
    // holds as a setting, or clear one the survivor does not use.
    const retireInto = (type, icons, params = null) => Object.fromEntries(
        Object.entries(icons).map(([old, icon]) => [old, { type, icon, params }]));

    // Presets removed outright. A saved plan that holds one opens without it:
    // the module and its links are dropped, and a loan that was docked under it
    // stands on its own.
    // The Person module went too: its age is the plan's now (settings.age).
    // So did Tax or fee, the Modifiers category's only module (and the Tax and
    // Fee presets it had replaced).
    const REMOVED_TYPES = new Set(['real-estate', 'rental-property', 'vehicle', 'home', 'land', 'person',
        'tax-or-fee', 'tax', 'fee']);

    /** What a saved module of a retired type opens as, or null. The
     *  Tax-advantaged account folds by its Contributions setting: before tax
     *  it is a Retirement Account, after tax an Investment. */
    function retiredAs(n) {
        if (!n) return null;
        if (n.type === 'tax-advantaged-account' && isObj(n.params) && n.params.contributions === 'pre') {
            return { type: '401k', icon: 'tree-evergreen', params: { match: 0 } };
        }
        return RETIRED_TYPES[n.type] || null;
    }

    const RETIRED_TYPES = {
        ...retireInto('paycheck', { 'side-hustle': 'laptop', 'freelance': 'laptop', 'other-income': 'coins',
            'tax-refund': 'arrow-u-up-left' }),
        ...retireInto('bank-account', {
            'checking': 'wallet', 'savings': 'piggy-bank', 'hysa': 'vault', 'money-market': 'coin-vertical',
            'emergency-fund': 'lifebuoy', 'cash': 'money-wavy' }),
        ...retireInto('term-deposit', { 'cd': 'certificate', 'i-bonds': 'seal-check' }),
        ...retireInto('investment', {
            'brokerage': 'chart-line-up', 'index-fund': 'chart-pie-slice', 'stocks': 'trend-up',
            'bonds': 'seal-percent', 'treasuries': 'bank', 'crypto': 'currency-btc', 'reit': 'building-office',
            'gold': 'diamond' }),
        // Pre-tax accounts are Retirement Accounts (with no employer match);
        // after-tax ones are Investments (which have no yearly limit).
        ...retireInto('401k', { 'pretax-account': 'plant', 'trad-ira': 'tree', 'hsa': 'heartbeat' }, { match: 0 }),
        ...retireInto('investment', { 'tax-free-account': 'tree-evergreen', 'roth-ira': 'tree-evergreen', '529': 'graduation-cap',
            'tax-advantaged-account': 'tree-evergreen' }, { capYearly: null }),
        ...retireInto('expense', {
            'rent': 'house', 'groceries': 'basket', 'dining': 'fork-knife', 'utilities': 'lightning',
            'transport': 'bus', 'insurance': 'shield-check', 'healthcare': 'first-aid', 'subscriptions': 'repeat',
            'entertainment': 'popcorn', 'shopping': 'handbag', 'travel': 'airplane-tilt', 'childcare': 'baby',
            'education': 'book-open', 'pets': 'paw-print', 'gifts': 'gift', 'charity': 'hand-heart',
            'taxes': 'receipt', 'home-upkeep': 'hammer' }),
        ...retireInto('loan', {
            'student-loan': 'student', 'car-loan': 'car-profile', 'mortgage': 'house-simple', 'home-equity': 'key',
            'personal-loan': 'handshake', 'medical-debt': 'first-aid-kit', 'bnpl': 'shopping-cart-simple' }),
        ...retireInto('one-time-income', { 'windfall': 'sparkle', 'inheritance': 'scroll' }),
        ...retireInto('expense', {
            'big-purchase': 'package', 'new-car': 'package', 'wedding': 'heart',
            'dream-trip': 'island', 'emergency': 'siren' }),
    };

    // Card geometry shared with canvas.js and canvas.css (change all together).
    const GEOM = { NODE_W: 220, NODE_H: 140 };

    // Bounds. A plan larger than these is not a plan anyone draws by hand; the
    // limits exist so a corrupt or hostile document cannot make the backend
    // write, or the engine walk, something unbounded.
    const LIMITS = {
        nodes:    400,
        links:    1200,
        goals:    24,
        name:     60,
        years:    60,
        idLength: 40,
        money:    1e11,
    };

    // ── Year-months ────────────────────────────────────────────────────────
    // Dates in a plan are calendar months, written 'YYYY-MM'. They are kept as
    // strings (not month offsets) so moving the plan's start leaves a dated
    // event on its date.
    const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function ymParse(ym) {
        const m = typeof ym === 'string' ? YM_RE.exec(ym) : null;
        if (!m) return null;
        const y = Number(m[1]);
        if (y < 1900 || y > 2300) return null;
        return { y, m: Number(m[2]) };
    }

    function ymFormat(y, m) {
        return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    }

    function ymNow() {
        const d = new Date();
        return ymFormat(d.getFullYear(), d.getMonth() + 1);
    }

    /** ym shifted by `months` (may be negative). */
    function ymAdd(ym, months) {
        const p = ymParse(ym);
        if (!p) return null;
        const total = p.y * 12 + (p.m - 1) + months;
        return ymFormat(Math.floor(total / 12), (total % 12) + 1);
    }

    /** Whole months from `a` to `b` (b - a). */
    function ymDiff(a, b) {
        const pa = ymParse(a);
        const pb = ymParse(b);
        if (!pa || !pb) return null;
        return (pb.y - pa.y) * 12 + (pb.m - pa.m);
    }

    /** 'Oct 2026'. */
    function ymLabel(ym) {
        const p = ymParse(ym);
        return p ? `${MONTHS[p.m - 1]} ${p.y}` : '';
    }

    // ── Ids ────────────────────────────────────────────────────────────────
    const ID_RE = /^[a-z0-9_-]{1,40}$/;

    function newId(prefix) {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        let s = '';
        for (const b of bytes) s += (b % 36).toString(36);
        return `${prefix}_${s}`;
    }

    // ── Link rule space ────────────────────────────────────────────────────
    // Which modes each basis offers, per source role. Order is display order.
    const RULES = {
        source:   { inflow: ['percent', 'fixed', 'rest'] },
        expense:  { inflow: ['percent', 'fixed', 'rest'] },
        modifier: { inflow: ['percent', 'fixed', 'rest'] },
        debt:     {
            inflow:   ['percent', 'fixed', 'rest'],
            proceeds: ['percent', 'rest'],
            charges:  ['fixed', 'percent', 'rest'],
        },
        account:  { balance: ['percent', 'fixed', 'rest'] },
    };

    // The bases that can pay an expense's cost: income or a budget group's
    // money, an account's balance, a card's purchases. (Proceeds are once.)
    const COST_BASES = new Set(['inflow', 'balance', 'charges']);

    /** Whether a link from `basis` into `to` may pay `to`'s own cost. */
    function paysCost(to, basis) {
        return !!to && roleOf(to) === 'expense' && COST_BASES.has(basis);
    }

    /** The link (other than `exceptId`) already paying expense `toId`'s cost, if any. */
    function costPayer(plan, toId, exceptId = null) {
        return plan.links.find((l) => l.to === toId && l.mode === 'cost' && l.id !== exceptId) || null;
    }

    /** The `when` values a rule offers. The first is the default. */
    function timingsFor(basis, mode) {
        // A cost falls due on the expense's schedule, not the link's.
        if (mode === 'cost') return ['monthly'];
        if (basis === 'proceeds') return ['once'];
        if (basis === 'charges') return ['monthly', 'yearly', 'once'];
        if (basis === 'inflow') return mode === 'fixed' ? ['monthly', 'yearly', 'once'] : ['monthly'];
        return ['monthly', 'yearly', 'once'];
    }

    /** Bases a node offers to its outgoing links. A debt only borrows (and so
     *  only has proceeds to send) when it starts inside the plan. A credit card
     *  only has purchases: it is paid, never paid onward. */
    function basesFor(node) {
        const p = Catalog.preset(node.type);
        if (!p) return [];
        const bases = Object.keys(RULES[p.role]);
        // Spending consumes what it receives; it sends nothing on.
        if (p.role === 'expense') return [];
        if (p.role !== 'debt') return bases;
        if (p.kind === 'card') return ['charges'];
        return bases.filter((b) => b !== 'charges' && (b !== 'proceeds' || node.params.start));
    }

    /** The modes a link on `basis` offers. Into spending (`to`), it may also
     *  pay the expense's own cost. */
    function modesFor(node, basis, to = null) {
        const p = Catalog.preset(node.type);
        const modes = (p && RULES[p.role][basis]) || [];
        return paysCost(to, basis) ? [...modes, 'cost'] : modes;
    }

    /** Whether an account of preset `p` is paid from gross pay: a Retirement
     *  Account (401(k), Traditional IRA, HSA). */
    function takesPretax(p) {
        return !!p && !!p.pretax;
    }

    /** Whether income sent along `link` is a pre-tax contribution: it leaves
     *  an income module for a Retirement Account. */
    function isPretax(plan, link) {
        const from = nodeById(plan, link.from);
        const to = nodeById(plan, link.to);
        return roleOf(from) === 'source' && !!to && takesPretax(Catalog.preset(to.type));
    }

    function roleOf(node) {
        const p = node && Catalog.preset(node.type);
        return p ? p.role : null;
    }

    /** The roles a link on `basis` may run into. A card's purchases pay for
     *  spending; every other basis goes wherever the source's role may link. */
    function portTargets(node, basis) {
        if (basis === 'charges') return ['expense'];
        return Catalog.LINK_TARGETS[roleOf(node)] || [];
    }

    const nodeById = (plan, id) => plan.nodes.find((n) => n.id === id);

    /** The roles a module may send to on any of its bases. */
    function targetRoles(node) {
        const roles = new Set();
        for (const basis of basesFor(node)) for (const r of portTargets(node, basis)) roles.add(r);
        return [...roles];
    }

    /** The bases a link from `from` to `to` could be on: the ones that reach
     *  the target's role and that no other link between the pair already uses.
     *  `exceptLinkId` is a link being edited, which does not block itself. */
    function basesBetween(plan, from, to, exceptLinkId = null) {
        const role = roleOf(to);
        return basesFor(from).filter((basis) => portTargets(from, basis).includes(role)
            && !plan.links.some((l) => l.id !== exceptLinkId && l.from === from.id && l.to === to.id && l.basis === basis)
            // A two-way link already carries money back along this pair.
            && !plan.links.some((l) => l.id !== exceptLinkId && l.back && l.from === to.id && l.to === from.id && basis === 'balance'));
    }

    // ── Goals ──────────────────────────────────────────────────────────────
    // The parts a goal's rule is built from (see the header). A goal is shared
    // by every plan, so it names no module of any one: its measures cover them
    // all. What each measure counts is sim/goals.js's.

    const GOAL_METRICS = ['net-worth', 'savings', 'debt', 'expenses', 'income'];
    const GOAL_OPS = ['gte', 'lte'];
    const GOAL_UNITS = ['amount', 'times', 'percent'];
    const GOAL_DUES = ['date', 'age'];
    // A goal with no deadline given is due this far from now.
    const GOAL_DUE_MONTHS = 120;
    const defaultBy = () => ymAdd(ymNow(), GOAL_DUE_MONTHS);
    // How large a target may be, by unit.
    const GOAL_VALUE = { amount: 1e11, times: 1000, percent: 1000 };
    const GOAL_AGE = { min: 1, max: 120 };
    // The colours a goal's card can be, in the order offered: eight stone names
    // over eight Ant Design hues (goals.css).
    const GOAL_COLORS = ['lapis', 'tourmaline', 'tigers-eye', 'garnet', 'tanzanite', 'amber', 'rhodolite', 'emerald'];
    // Colours offered before the stones, read as the stone nearest them.
    const OLD_GOAL_COLORS = {
        teal: 'tourmaline', blue: 'lapis', violet: 'tanzanite', rose: 'garnet',
        orange: 'amber', green: 'emerald', slate: 'lapis', gold: 'tigers-eye',
    };

    /** A new goal: "Net worth is at least $100,000 by" ten years from now, with
     *  any of `fields` over it. */
    function createGoal(fields = {}) {
        const goal = {
            id: newId('g'), name: 'New goal',
            metric: 'net-worth', op: 'gte', unit: 'amount', value: 100000, of: 'expenses',
            due: 'date', by: defaultBy(), age: null, color: GOAL_COLORS[0],
        };
        for (const key of Object.keys(goal)) {
            if (key !== 'id' && fields[key] !== undefined) goal[key] = fields[key];
        }
        return goal;
    }

    /** The month a goal is due in `plan` ('YYYY-MM'), or null when it has no
     *  deadline there. An age deadline is the month the plan's person turns
     *  that age, so it has none in a plan whose age is not set. */
    function goalDate(plan, goal) {
        if (goal.due === 'date') return goal.by || null;
        if (goal.due !== 'age' || plan.settings.age == null) return null;
        return ymAdd(plan.settings.start, Math.round((goal.age - plan.settings.age) * 12));
    }

    // ── Construction ───────────────────────────────────────────────────────

    function createPlan({ name = 'Untitled plan', start = ymNow(), years = 5 } = {}) {
        const now = new Date().toISOString();
        return {
            id: newId('p'),
            name,
            version: PLAN_VERSION,
            createdAt: now,
            updatedAt: now,
            settings: { start, years, inflation: 2.5, age: null, retireAge: null },
            view: { x: 0, y: 0, zoom: 1 },
            nodes: [],
            links: [],
        };
    }

    /** The icon a module wears: the one the user chose, else its preset's. */
    function iconOf(node) {
        return node.icon || Catalog.preset(node.type).icon;
    }

    function createNode(plan, presetId, x, y) {
        const p = Catalog.preset(presetId);
        if (!p) throw new Error(`unknown module type: ${presetId}`);
        const params = Catalog.defaultParams(p);
        return { id: newId('n'), type: p.id, name: p.name, x: Math.round(x), y: Math.round(y), params };
    }

    // ── Age ────────────────────────────────────────────────────────────────

    /** The plan's person's age in month `ym`, in whole years, from their age
     *  when the plan starts. Null when no age is set. */
    function ageAt(plan, ym) {
        const { age, start } = plan.settings;
        if (age == null) return null;
        return Math.floor(age + ymDiff(start, ym) / 12);
    }

    /** The month the plan's person turns `age` ('YYYY-MM'), or null when
     *  either age is not set. */
    function ageMonth(plan, age) {
        if (age == null || plan.settings.age == null) return null;
        return ymAdd(plan.settings.start, Math.round((age - plan.settings.age) * 12));
    }

    /** The age an income stops at (its own, or the plan's retirement age),
     *  or null when it does not stop at an age or that age is not set. */
    function stopAge(plan, node) {
        const v = node.params;
        if (v.stopBy === 'age') return v.endAge ?? null;
        if (v.stopBy === 'retire') return plan.settings.retireAge ?? null;
        return null;
    }

    /** The last month an income pays ('YYYY-MM'), or null when it runs on.
     *  Stopping at an age (its own or the plan's retirement age), that is the
     *  month before the plan's person turns it (the month an age goal falls
     *  due, goalDate), so it needs the plan's age. */
    function incomeEnd(plan, node) {
        const v = node.params;
        if (v.stopBy === 'date') return v.end || null;
        const ym = ageMonth(plan, stopAge(plan, node));
        return ym == null ? null : ymAdd(ym, -1);
    }

    // ── Two-way links ──────────────────────────────────────────────────────
    // A link from one account's balance to another account may be two-way.
    // `back` is the way back:
    //
    //   back = { mode: 'percent' | 'fixed' | 'rest',   the rule coming back, out
    //            value,                                 of the target's balance,
    //            when: 'monthly' | 'yearly' | 'once',   with the same choices as
    //            month, date, growth,                   the way out (a balance link's)
    //            startWhen }                            and its own start
    //
    // Both ways run side by side, each from its own start.

    const BACK_MODES = RULES.account.balance;
    const BACK_WHENS = timingsFor('balance', 'fixed');

    // ── Starting ───────────────────────────────────────────────────────────
    // A side of a link starts now (`startWhen` null or absent), or the first
    // month a condition is met, and keeps running from then on:
    //
    //   startWhen = { kind: 'age', age }                  the plan's person reaches `age`
    //             | { kind: 'retire' }                    they reach the plan's retireAge
    //             | { kind: 'balance', account, amount }  `account` holds `amount` or more
    //
    // Sent once with a condition, it is sent the month it starts (it has no
    // date of its own). A condition that cannot be met (an age with no plan
    // age, an account that is gone) never starts it, and the engine flags it.

    const START_KINDS = ['age', 'retire', 'balance'];

    /** The age an age condition waits for: its own, or the plan's
     *  retirement age. Null when it is not an age condition or the age is not set. */
    function startAge(plan, cond) {
        if (!cond) return null;
        if (cond.kind === 'age') return cond.age ?? null;
        if (cond.kind === 'retire') return plan.settings.retireAge ?? null;
        return null;
    }

    /** The month an age condition (an age or the retirement age) is met
     *  ('YYYY-MM'), or null when an age it needs is not set (or the
     *  condition is not an age). */
    function startAgeMonth(plan, cond) {
        return ageMonth(plan, startAge(plan, cond));
    }

    /** Whether a link may be two-way: from one account's balance to another account. */
    function canTurn(plan, link) {
        return link.basis === 'balance' && roleOf(nodeById(plan, link.from)) === 'account'
            && roleOf(nodeById(plan, link.to)) === 'account';
    }

    /** Make `link` two-way, its way back starting now. A link already
     *  running the other way between the pair becomes the way back (its rule,
     *  timing and start) and is removed. Returns false when the link cannot
     *  be two-way or already is. */
    function makeTwoWay(plan, link) {
        if (!link || link.back || !canTurn(plan, link)) return false;
        const back = { mode: 'fixed', value: 2000, when: 'monthly', date: null,
            growth: plan.settings.inflation || 0, startWhen: null, stopWhen: null };
        const opposite = plan.links.find((l) => l.from === link.to && l.to === link.from && l.basis === 'balance');
        if (opposite) {
            if (BACK_MODES.includes(opposite.mode)) Object.assign(back, { mode: opposite.mode, value: opposite.mode === 'rest' ? 0 : opposite.value });
            if (opposite.mode === 'fixed') back.growth = opposite.growth || 0;
            if (BACK_WHENS.includes(opposite.when)) Object.assign(back, { when: opposite.when, date: opposite.date || null });
            if (opposite.startWhen) back.startWhen = { ...opposite.startWhen };
            if (opposite.stopWhen) back.stopWhen = { ...opposite.stopWhen };
            plan.links.splice(plan.links.indexOf(opposite), 1);
        }
        if (back.when === 'once' && !back.date && !back.startWhen) back.date = ymAdd(plan.settings.start, 12);
        link.back = back;
        return true;
    }

    /** Whether a link from `fromId` to `toId` may be drawn, and why not. Two
     *  modules may be linked once per basis (a card's purchases, a loan's proceeds...),
     *  so a pair is full only when every basis that reaches the target is
     *  taken. With a `basis`, only that one is checked. */
    function canConnect(plan, fromId, toId, basis = null) {
        if (fromId === toId) return { ok: false, reason: 'self' };
        const from = plan.nodes.find((n) => n.id === fromId);
        const to = plan.nodes.find((n) => n.id === toId);
        if (!from || !to) return { ok: false, reason: 'missing' };
        const tr = roleOf(to);
        const bases = basesFor(from);
        if (!Catalog.LINK_TARGETS[roleOf(from)].includes(tr) || !bases.length) return { ok: false, reason: 'role' };
        const reaches = bases.filter((b) => portTargets(from, b).includes(tr));
        if (basis ? !reaches.includes(basis) : !reaches.length) return { ok: false, reason: 'basis' };
        // The bases this pair has free are always among the ones that reach.
        const free = basesBetween(plan, from, to);
        if (basis ? !free.includes(basis) : !free.length) return { ok: false, reason: 'duplicate' };
        return { ok: true };
    }

    function blankRule() {
        return { mode: 'rest', value: 0, basis: 'inflow', when: 'monthly', date: null,
            start: null, end: null, growth: 0 };
    }

    /** The rule a freshly drawn link starts with. Picked so the first link
     *  usually does what was meant without opening the editor: income's first
     *  link takes the rest, later ones take a slice of it, an account sends a
     *  fixed amount from its balance, a debt is paid what it asks, and a target
     *  with a natural price (Rent, a wedding) asks for that price. */
    function defaultRule(plan, from, to, basis = null) {
        const rule = startingRule(plan, from, to);
        if (basis) return rule.basis === basis ? preferPercent(rule, from) : ruleOnBasis(plan, from, to, basis);
        // The usual basis may already link this pair: take the next free one.
        const free = basesBetween(plan, from, to);
        return free.length && !free.includes(rule.basis) ? ruleOnBasis(plan, from, to, free[0]) : preferPercent(rule, from);
    }

    /** Whether a link claims all that is left: a rest link, or the 100% that
     *  a new link starts with in its place. */
    const takesRest = (l) => l.mode === 'rest' || (l.mode === 'percent' && Number(l.value) >= 100);

    /** A new link starts on % wherever that is on offer. A rule that would
     *  take the rest takes all (100%) instead, so the first link still gets
     *  everything and later ones carve their share out of it. */
    function preferPercent(rule, from) {
        if (rule.mode === 'rest' && modesFor(from, rule.basis).includes('percent')) {
            Object.assign(rule, { mode: 'percent', value: 100 });
        }
        return rule;
    }

    /** The rule for a link on a given basis. Only one link per source and
     *  basis may take the rest, so a later one takes a share instead. */
    function ruleOnBasis(plan, from, to, basis) {
        const rule = rawRuleOnBasis(plan, from, to, basis);
        const modes = modesFor(from, basis);
        const taken = plan.links.some((l) => l.from === from.id && l.basis === basis && takesRest(l));
        if (rule.mode === 'rest' && taken && modes.includes('percent')) Object.assign(rule, { mode: 'percent', value: 50 });
        return preferPercent(rule, from);
    }

    function rawRuleOnBasis(plan, from, to, basis) {
        const rule = Object.assign(blankRule(), { basis });
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id && l.basis === basis);
        switch (basis) {
            case 'charges':
                return Object.assign(rule, priceRule(plan, to, tp.inLink || { when: 'monthly', value: 100 }));
            case 'balance': {
                if (tp.role === 'debt') return Object.assign(rule, paymentRule());
                if (tp.inLink) return Object.assign(rule, priceRule(plan, to, tp.inLink));
                return Object.assign(rule, { mode: 'fixed', value: 500 });
            }
            case 'proceeds':
                return Object.assign(rule, { mode: 'rest', when: 'once' });
            default:
                if (tp.inLink && modesFor(from, basis).includes('fixed')) {
                    return Object.assign(rule, priceRule(plan, to, tp.inLink));
                }
                return existing.some(takesRest) ? Object.assign(rule, { mode: 'percent', value: 25 }) : rule;
        }
    }

    /** Paying a target with a usual price (a preset's `inLink`): its own cost
     *  when it has one that no other link pays yet, else that amount, on its
     *  timing. */
    function priceRule(plan, to, buy) {
        if (to.params.cost != null && !costPayer(plan, to.id)) return { mode: 'cost', value: 0, when: 'monthly' };
        return { mode: 'fixed', value: buy.value, when: buy.when,
            date: buy.relDate != null ? ymAdd(plan.settings.start, buy.relDate) : null };
    }

    /** Paying a debt starts at a round monthly figure to edit. */
    function paymentRule() {
        return { mode: 'fixed', value: 500, when: 'monthly' };
    }

    function startingRule(plan, from, to) {
        const rule = blankRule();
        const fp = Catalog.preset(from.type);
        const tp = Catalog.preset(to.type);
        const existing = plan.links.filter((l) => l.from === from.id);
        const hasRest = (basis) => existing.some((l) => l.basis === basis && takesRest(l));

        // A card pays for spending: a purchase, at that spending's usual price.
        if (fp.kind === 'card') {
            return Object.assign(rule, { basis: 'charges' }, priceRule(plan, to, tp.inLink || { when: 'monthly', value: 100 }));
        }

        if (tp.inLink) {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            if (RULES[fp.role][basis] && RULES[fp.role][basis].includes('fixed')) {
                return Object.assign(rule, { basis }, priceRule(plan, to, tp.inLink));
            }
        }

        // Paying a debt starts at a round monthly figure.
        if (tp.role === 'debt' && fp.role !== 'debt') {
            const basis = fp.role === 'account' ? 'balance' : 'inflow';
            return Object.assign(rule, { basis }, paymentRule());
        }
        // Pay into a 401(k) is usually a slice of it.
        if (tp.employerMatch && fp.role === 'source') {
            return Object.assign(rule, { mode: 'percent', value: 6 });
        }

        switch (fp.role) {
            case 'account':
                return Object.assign(rule, { basis: 'balance', mode: 'fixed', value: 500 });
            case 'debt':
                if (from.params.start && !existing.some((l) => l.basis === 'proceeds')) {
                    return Object.assign(rule, { basis: 'proceeds', mode: 'rest', when: 'once' });
                }
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 50 })
                    : rule;
            case 'modifier':
                // A budget group splits its money among its categories.
                if (fp.kind === 'group') {
                    return Object.assign(rule, { mode: 'percent', value: hasRest('inflow') ? 25 : 50 });
                }
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 10 })
                    : rule;
            default:
                return hasRest('inflow')
                    ? Object.assign(rule, { mode: 'percent', value: 10 })
                    : rule;
        }
    }

    function createLink(plan, fromId, toId, basis = null) {
        const from = plan.nodes.find((n) => n.id === fromId);
        const to = plan.nodes.find((n) => n.id === toId);
        return { id: newId('l'), from: fromId, to: toId, ...defaultRule(plan, from, to, basis) };
    }

    /** Bring a link's rule back inside the space its source and target allow,
     *  after either or the rule changed. Keeps every field it can. */
    function fitRule(link, from, to) {
        const bases = basesFor(from);
        if (!bases.includes(link.basis)) link.basis = bases[0] || 'inflow';
        const modes = modesFor(from, link.basis, to);
        if (!modes.includes(link.mode)) link.mode = modes.includes('percent') ? 'percent' : modes[0];
        const timings = timingsFor(link.basis, link.mode);
        if (!timings.includes(link.when)) link.when = timings[0];
        return link;
    }

    /** Move a link onto another basis (money from the balance rather than
     *  from the earnings, say). The rule starts afresh for that basis, since
     *  its amounts mean something else there; the link's window and raise
     *  stay. Returns false when the basis is not open to this pair. */
    function changeBasis(plan, link, basis) {
        const from = nodeById(plan, link.from);
        const to = nodeById(plan, link.to);
        if (!from || !to || link.basis === basis || !basesBetween(plan, from, to, link.id).includes(basis)) return false;
        const { start, end, growth } = link;
        Object.assign(link, ruleOnBasis(plan, from, to, basis), { start, end, growth });
        fitRule(link, from, to);
        return true;
    }

    /** Move one end of a link (`end`: 'to', the receiving end, or 'from', the
     *  sending end): onto another module, or just to another dot of the one it
     *  already touches. The rule stays where the new pair takes it; otherwise
     *  the link moves to a basis that does. Returns { ok } or { ok: false,
     *  reason } with canConnect's reasons. */
    function reconnect(plan, link, nodeId, side = null, end = 'to') {
        const sideKey = end === 'from' ? 'fromSide' : 'toSide';
        if (nodeId !== link[end]) {
            const fromId = end === 'from' ? nodeId : link.from;
            const toId = end === 'from' ? link.to : nodeId;
            const check = canConnect(plan, fromId, toId);
            if (!check.ok) return check;
            const from = nodeById(plan, fromId);
            const to = nodeById(plan, toId);
            const keeps = canConnect(plan, fromId, toId, link.basis).ok;
            link[end] = nodeId;
            if (!keeps) changeBasis(plan, link, basesBetween(plan, from, to, link.id)[0]);
            fitRule(link, from, to);
            // Another link already pays the new target's cost: this one would pay it twice.
            if (link.mode === 'cost' && costPayer(plan, toId, link.id)) Object.assign(link, { mode: 'fixed', value: 0 });
            // Only a link between two accounts turns around.
            if (link.back && !canTurn(plan, link)) delete link.back;
        }
        if (side) link[sideKey] = side; else delete link[sideKey];
        return { ok: true };
    }

    // ── Validation ─────────────────────────────────────────────────────────
    // validatePlan is the gate in front of the file: the backend runs it on
    // every save and import, so nothing malformed is ever written. It rejects
    // structural problems (wrong types, unknown modules, dangling links) and
    // clamps numbers into their ranges, which is a fix rather than an error.
    // Returns a fresh, normalized copy; never mutates its input.

    class PlanError extends Error {}

    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fail = (msg) => { throw new PlanError(msg); };

    function cleanString(v, max, what) {
        if (typeof v !== 'string') fail(`${what} must be text`);
        // Control characters have no business in a name; strip rather than reject.
        // eslint-disable-next-line no-control-regex
        const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        return s.slice(0, max);
    }

    function cleanNumber(v, min, max, what) {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a number`);
        return Math.min(max, Math.max(min, v));
    }

    function cleanYm(v, what, optional) {
        if (v == null || v === '') {
            if (optional) return null;
            fail(`${what} is required`);
        }
        if (!ymParse(v)) fail(`${what} must be a month (YYYY-MM)`);
        return v;
    }

    function cleanId(v, what) {
        if (typeof v !== 'string' || !ID_RE.test(v)) fail(`${what} is not a valid id`);
        return v;
    }

    function cleanParams(p, raw) {
        const out = {};
        const fields = Catalog.ROLE_FIELDS[p.role];
        const base = Catalog.defaultParams(p);
        let src = isObj(raw) ? raw : {};
        // An income's end date came before its Stops setting: it stops on it.
        if (p.role === 'source' && src.stopBy === undefined && src.end) src = { ...src, stopBy: 'date' };
        for (const key of fields) {
            const spec = Catalog.FIELDS[key];
            const v = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : base[key];
            if (p.fixed && Object.prototype.hasOwnProperty.call(p.fixed, key)) {
                out[key] = p.fixed[key];
                continue;
            }
            switch (spec.type) {
                case 'money':
                case 'percent':
                case 'number':
                    if ((v == null || v === '') && spec.optional) { out[key] = null; break; }
                    out[key] = cleanNumber(v, spec.min, spec.max, key);
                    break;
                case 'choice':
                    if (!spec.options.some(([val]) => val === v)) fail(`${key} has an unknown value`);
                    out[key] = v;
                    break;
                case 'month':
                    out[key] = Math.round(cleanNumber(v == null ? 0 : v, 0, 12, key));
                    break;
                case 'yearmonth':
                    out[key] = cleanYm(v, key, true);
                    break;
                case 'account':
                    out[key] = v == null || v === '' ? null : cleanId(v, key);
                    break;
                default:
                    fail(`unknown field type for ${key}`);
            }
        }
        return out;
    }

    const MODES = ['percent', 'fixed', 'rest', 'cost'];
    const BASES = ['inflow', 'balance', 'proceeds', 'charges'];
    const WHENS = ['monthly', 'yearly', 'once'];
    const SIDES = ['t', 'r', 'b', 'l'];

    function cleanLink(raw, nodesById, i) {
        if (!isObj(raw)) fail(`link ${i} is malformed`);
        const link = {
            id:     cleanId(raw.id, `link ${i}`),
            from:   cleanId(raw.from, `link ${i} source`),
            to:     cleanId(raw.to, `link ${i} target`),
            mode:   MODES.includes(raw.mode) ? raw.mode : fail(`link ${i} has an unknown mode`),
            value:  cleanNumber(raw.value ?? 0, 0, LIMITS.money, `link ${i} value`),
            basis:  BASES.includes(raw.basis) ? raw.basis : fail(`link ${i} has an unknown basis`),
            when:   WHENS.includes(raw.when) ? raw.when : fail(`link ${i} has an unknown timing`),
            date:   cleanYm(raw.date, `link ${i} date`, true),
            start:  cleanYm(raw.start, `link ${i} start`, true),
            end:    cleanYm(raw.end, `link ${i} end`, true),
            growth: cleanNumber(raw.growth ?? 0, -100, 100, `link ${i} growth`),
        };
        // Which dot of each card the link is drawn from and to (top, right, bottom, left).
        // Optional: a link without them is drawn between the sides that face each other.
        if (SIDES.includes(raw.fromSide)) link.fromSide = raw.fromSide;
        if (SIDES.includes(raw.toSide)) link.toSide = raw.toSide;
        const from = nodesById.get(link.from);
        const to = nodesById.get(link.to);
        if (!from || !to) fail(`link ${i} points at a module that does not exist`);
        if (link.from === link.to) fail(`link ${i} links a module to itself`);
        if (!Catalog.LINK_TARGETS[roleOf(from)].includes(roleOf(to))) {
            fail(`link ${i} joins modules that cannot be linked`);
        }
        fitRule(link, from, to);
        if (!portTargets(from, link.basis).includes(roleOf(to))) {
            fail(`link ${i} sends ${link.basis} to a module that cannot take it`);
        }
        if (link.mode === 'percent') link.value = Math.min(link.value, 100);
        // Proceeds happen on the module's own date, so they always start with it.
        const startWhen = link.basis === 'proceeds' ? null : cleanStart(raw.startWhen, nodesById, `link ${i}`);
        if (startWhen) link.startWhen = startWhen;
        const stopWhen = link.basis === 'proceeds' ? null : cleanStart(raw.stopWhen, nodesById, `link ${i} stop`);
        if (stopWhen) link.stopWhen = stopWhen;
        // Proceeds happen on the module's own date, not the link's; a link
        // with a start condition is sent once the month it starts.
        if (link.when === 'once' && link.basis !== 'proceeds' && !link.date && !startWhen) {
            fail(`link ${i} needs a date`);
        }
        // Only a link from one account's balance to another turns around.
        if (isObj(raw.back) && link.basis === 'balance' && roleOf(from) === 'account' && roleOf(to) === 'account') {
            link.back = cleanBack(raw.back, nodesById, `link ${i}`);
        }
        return link;
    }

    /** A two-way link's way back, normalized. One from before each side had
     *  a start turned around (`turn`, with `turnDate`, or once `date`): one
     *  that turned at an age starts at it, any other starts now, and sent
     *  once without that age it keeps the turn's date as its own. */
    function cleanBack(raw, nodesById, what) {
        const mode = BACK_MODES.includes(raw.mode) ? raw.mode : 'fixed';
        const turned = typeof raw.turn === 'string';
        const turnDate = !turned ? null : raw.switches === undefined ? raw.date : raw.turnDate;
        const startWhen = turned && raw.switches !== false && raw.turn === 'age' && raw.age != null
            ? cleanStart({ kind: 'age', age: raw.age }, nodesById, what)
            : cleanStart(raw.startWhen, nodesById, what);
        let when = BACK_WHENS.includes(raw.when) ? raw.when : 'monthly';
        let date = cleanYm(turned && raw.switches === undefined ? null : raw.date, `${what} date back`, true);
        // Sent once, it needs a date of its own or a start to be sent at.
        if (when === 'once' && !date && !startWhen) date = cleanYm(turnDate ?? null, `${what} date back`, true);
        if (when === 'once' && !date && !startWhen) when = 'monthly';
        return {
            mode,
            value: mode === 'rest' ? 0 : cleanNumber(raw.value ?? 0, 0, mode === 'percent' ? 100 : LIMITS.money, `${what} amount back`),
            when,
            date,
            growth: cleanNumber(raw.growth ?? 0, -100, 100, `${what} growth back`),
            startWhen,
            stopWhen: cleanStart(raw.stopWhen, nodesById, `${what} stop`),
        };
    }

    /** A side's start condition, normalized: null (now), an age, or an
     *  account reaching an amount. An account that is gone (or is not an
     *  account) is cleared, so the condition waits to be told. */
    function cleanStart(raw, nodesById, what) {
        if (!isObj(raw) || !START_KINDS.includes(raw.kind)) return null;
        if (raw.kind === 'age') {
            return { kind: 'age', age: cleanNumber(raw.age ?? 65, GOAL_AGE.min, GOAL_AGE.max, `${what} start age`) };
        }
        if (raw.kind === 'retire') return { kind: 'retire' };
        const acct = typeof raw.account === 'string' ? nodesById.get(raw.account) : null;
        return {
            kind: 'balance',
            account: acct && roleOf(acct) === 'account' ? acct.id : null,
            amount: cleanNumber(raw.amount ?? 0, 0, LIMITS.money, `${what} start amount`),
        };
    }

    /** A goal of a kind from before goals were rules, as the rule it meant.
     *  An FI or retirement goal compared all savings with a year of spending
     *  and loan payments over its withdrawal rate (4% is 25 times). */
    function ruleOfKind(raw, i) {
        const by = raw.by ?? null;
        const dated = { due: 'date', by };
        const fi = { metric: 'savings', op: 'gte', unit: 'times', value: 100 / (Number(raw.rate) || 4), of: 'expenses' };
        switch (raw.kind) {
            case 'net-worth': return { metric: 'net-worth', op: 'gte', unit: 'amount', value: raw.target ?? 1000000, ...dated };
            case 'savings':   return { metric: 'savings', op: 'gte', unit: 'amount', value: raw.target ?? 10000, ...dated };
            case 'debt-free': return { metric: 'debt', op: 'lte', unit: 'amount', value: 0, ...dated };
            case 'fi':        return { ...fi, ...dated };
            case 'retire':    return { ...fi, due: 'age', by: null, age: raw.age ?? 65 };
            default: return fail(`goal ${i} has an unknown kind`);
        }
    }

    const oneOf = (list, v, what) => (list.includes(v) ? v : fail(`${what} has an unknown value`));

    /** A goal, normalized. A goal it cannot read (an unknown measure, saved by
     *  a newer build) is rejected rather than dropped: dropping it would lose
     *  it on the next save. Fields a rule does not have (a module a goal once
     *  named, when goals belonged to one plan) are left behind. */
    function cleanGoal(raw, i) {
        if (!isObj(raw)) fail(`goal ${i} is malformed`);
        const src = raw.metric === undefined && raw.kind !== undefined ? { ...raw, ...ruleOfKind(raw, i) } : raw;
        const what = `goal ${i}`;
        const unit = oneOf(GOAL_UNITS, src.unit ?? 'amount', `${what} target`);
        // A goal saved with no deadline (from when one could have none) is given one.
        const due = src.due == null || src.due === 'none' ? 'date' : oneOf(GOAL_DUES, src.due, `${what} deadline`);
        const goal = {
            id: cleanId(raw.id, what),
            name: cleanString(raw.name ?? '', LIMITS.name, `${what} name`) || 'Goal',
            metric: oneOf(GOAL_METRICS, src.metric, `${what} measure`),
            op: oneOf(GOAL_OPS, src.op ?? 'gte', `${what} comparison`),
            unit,
            value: cleanNumber(src.value ?? 0, 0, GOAL_VALUE[unit], `${what} target`),
            of: oneOf(GOAL_METRICS, src.of ?? 'expenses', `${what} measure`),
            due,
            by: cleanYm(src.by, `${what} date`, true),
            age: src.age == null ? null : cleanNumber(src.age, GOAL_AGE.min, GOAL_AGE.max, `${what} age`),
            // Only for show, so a colour this build does not know is not worth refusing the goal over.
            color: GOAL_COLORS.includes(src.color) ? src.color : OLD_GOAL_COLORS[src.color] || GOAL_COLORS[0],
        };
        if (due === 'date' && !goal.by) goal.by = defaultBy();
        if (due === 'age' && goal.age == null) goal.age = 65;
        return goal;
    }

    /** The shared goal list, normalized. Returns a fresh copy; throws a
     *  PlanError on one it cannot trust (see cleanGoal). */
    function validateGoals(raw) {
        if (raw == null) return [];
        if (!Array.isArray(raw)) fail('goals are malformed');
        if (raw.length > LIMITS.goals) fail(`at most ${LIMITS.goals} goals`);
        const seen = new Set();
        return raw.map((g, i) => {
            const goal = cleanGoal(g, i);
            if (seen.has(goal.id)) fail(`goal id ${goal.id} is used twice`);
            seen.add(goal.id);
            return goal;
        });
    }

    /** The goals a plan saved before goals were shared held, normalized; none
     *  for a plan without. Read from the plan as saved, before validatePlan
     *  (which keeps none). */
    function legacyGoals(rawPlan) {
        return isObj(rawPlan) && Array.isArray(rawPlan.goals) ? validateGoals(rawPlan.goals.slice(0, LIMITS.goals)) : [];
    }

    /** `goals` with every goal of `incoming` that it does not already hold
     *  (the same kind, name and figures) added, up to the limit. A newcomer
     *  whose id is taken gets a new one. Returns a new list. */
    function mergeGoals(goals, incoming) {
        const sameAs = (g) => JSON.stringify({ ...g, id: null });
        const held = new Set(goals.map(sameAs));
        const ids = new Set(goals.map((g) => g.id));
        const out = goals.slice();
        for (const g of incoming) {
            if (out.length >= LIMITS.goals) break;
            if (held.has(sameAs(g))) continue;
            const goal = ids.has(g.id) ? { ...g, id: newId('g') } : { ...g };
            held.add(sameAs(goal));
            ids.add(goal.id);
            out.push(goal);
        }
        return out;
    }

    /** The Match module is gone: a 401(k) has an Employer match setting now.
     *  A saved Match folds into the pre-tax account it fed, which becomes a
     *  401(k) with the Match's rate and yearly limit. The pay the Match was
     *  told about becomes pay into that 401(k), unless the pay already goes
     *  there. A Match that fed no pre-tax account is dropped. Returns new
     *  node and link lists; `raw` is left as it was. */
    function foldMatches(raw) {
        const isMatch = (n) => isObj(n) && n.type === 'employer-match';
        if (!raw.nodes.some(isMatch)) return { nodes: raw.nodes, links: raw.links };
        const byId = new Map(raw.nodes.filter(isObj).map((n) => [n.id, n]));
        // Saved types may be retired ones, so read them as their survivors.
        const presetOf = (n) => (n && Catalog.preset((retiredAs(n) || n).type)) || {};
        const takesPretaxNode = (n) => takesPretax(presetOf(n));
        const links = raw.links.filter(isObj);
        const intoK = new Map();   // a 401(k) id -> the node it is saved as
        const moved = new Map();   // a pay link -> the 401(k) id it now feeds
        const dropped = new Set();
        for (const m of raw.nodes.filter(isMatch)) {
            const out = links.find((l) => l.from === m.id && takesPretaxNode(byId.get(l.to)));
            const k = out && byId.get(out.to);
            if (k && !intoK.has(k.id)) {
                const params = isObj(m.params) ? m.params : {};
                intoK.set(k.id, { ...k, type: '401k',
                    params: { ...(isObj(k.params) ? k.params : {}), match: params.rate ?? 0, matchLimit: params.capYearly ?? null } });
                for (const pay of links.filter((l) => l.to === m.id && presetOf(byId.get(l.from)).role === 'source')) {
                    const paid = links.some((l) => l.from === pay.from && l.to === k.id && l.basis === pay.basis);
                    if (!paid) moved.set(pay, k.id);
                }
            }
            dropped.add(m.id);
        }
        return {
            nodes: raw.nodes.filter((n) => !isMatch(n)).map((n) => (isObj(n) && intoK.get(n.id)) || n),
            links: raw.links.flatMap((l) => {
                if (moved.has(l)) return [{ ...l, to: moved.get(l) }];
                return isObj(l) && (dropped.has(l.from) || dropped.has(l.to)) ? [] : [l];
            }),
        };
    }

    function validatePlan(input) {
        if (!isObj(input)) fail('plan is malformed');
        if (!Array.isArray(input.nodes)) fail('plan modules are missing');
        if (!Array.isArray(input.links)) fail('plan links are missing');
        if (input.nodes.length > LIMITS.nodes) fail(`a plan holds at most ${LIMITS.nodes} modules`);
        if (input.links.length > LIMITS.links) fail(`a plan holds at most ${LIMITS.links} links`);
        const raw = { ...input, ...foldMatches(input) };
        const settings = isObj(raw.settings) ? raw.settings : fail('plan settings are missing');
        const view = isObj(raw.view) ? raw.view : { x: 0, y: 0, zoom: 1 };
        // Goals are shared now, not kept in a plan: the ones an older plan held
        // are read out of it (legacyGoals) before this drops them.

        const plan = {
            id: cleanId(raw.id, 'plan'),
            name: cleanString(raw.name ?? '', LIMITS.name, 'plan name') || 'Untitled plan',
            version: PLAN_VERSION,
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : new Date().toISOString(),
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : new Date().toISOString(),
            settings: {
                start: cleanYm(settings.start, 'plan start', false),
                years: Math.round(cleanNumber(settings.years, 1, LIMITS.years, 'plan length')),
                inflation: cleanNumber(settings.inflation ?? 0, -20, 50, 'inflation'),
                age: settings.age == null ? null : cleanNumber(settings.age, 0, GOAL_AGE.max, 'age'),
                retireAge: settings.retireAge == null ? null
                    : cleanNumber(settings.retireAge, GOAL_AGE.min, GOAL_AGE.max, 'retirement age'),
            },
            view: {
                x: cleanNumber(Number(view.x) || 0, -1e6, 1e6, 'view x'),
                y: cleanNumber(Number(view.y) || 0, -1e6, 1e6, 'view y'),
                zoom: cleanNumber(Number(view.zoom) || 1, 0.2, 3, 'view zoom'),
            },
            nodes: [],
            links: [],
        };

        const nodesById = new Map();
        const removedIds = new Set();
        raw.nodes.forEach((n, i) => {
            if (!isObj(n)) fail(`module ${i} is malformed`);
            if (REMOVED_TYPES.has(n.type)) { removedIds.add(n.id); return; }
            const retired = retiredAs(n);
            const p = Catalog.preset(retired ? retired.type : n.type);
            if (!p) fail(`module ${i} has an unknown type`);
            const node = {
                id: cleanId(n.id, `module ${i}`),
                type: p.id,
                name: cleanString(n.name ?? p.name, LIMITS.name, `module ${i} name`) || p.name,
                x: Math.round(cleanNumber(n.x, -1e6, 1e6, `module ${i} x`)),
                y: Math.round(cleanNumber(n.y, -1e6, 1e6, `module ${i} y`)),
                params: cleanParams(p, retired && retired.params ? { ...(isObj(n.params) ? n.params : {}), ...retired.params } : n.params),
            };
            // An icon the category does not offer is dropped, not rejected: the
            // module wears its preset's icon instead.
            const icon = n.icon ?? (retired && retired.icon);
            if (typeof icon === 'string' && icon !== p.icon && Catalog.iconChoices(p).includes(icon)) node.icon = icon;
            if (nodesById.has(node.id)) fail(`module id ${node.id} is used twice`);
            nodesById.set(node.id, node);
            plan.nodes.push(node);
        });
        // Cash back lands in an account that exists, else it credits the card.
        for (const n of plan.nodes) {
            const to = n.params.cashBackTo && nodesById.get(n.params.cashBackTo);
            if (n.params.cashBackTo && !(to && roleOf(to) === 'account')) n.params.cashBackTo = null;
        }

        // Cash back once travelled along links from the card, and a card could
        // send what it overpaid onward. Both are gone: a card's cash back is a
        // setting now (the account the old links favoured, if any), and the
        // overpayment stays with whoever paid.
        const isCard = (id) => {
            const n = nodesById.get(id);
            return !!n && Catalog.preset(n.type).kind === 'card';
        };
        const retiredCardLink = (l) => isObj(l) && (l.basis === 'cashback' || (l.basis === 'inflow' && isCard(l.from)));
        const backLinks = raw.links.filter((l) => isObj(l) && l.basis === 'cashback' && isCard(l.from));
        for (const card of plan.nodes.filter((n) => n.params.cashBackTo == null && isCard(n.id))) {
            const mine = backLinks.filter((l) => l.from === card.id);
            const shared = mine.filter((l) => l.mode === 'percent').reduce((sum, l) => sum + (Number(l.value) || 0), 0);
            let best = null;
            let bestShare = 0;
            for (const l of mine) {
                const share = l.mode === 'rest' ? Math.max(0, 100 - shared) : l.mode === 'percent' ? Number(l.value) || 0 : 0;
                if (share > bestShare) { best = l; bestShare = share; }
            }
            const to = best && nodesById.get(best.to);
            if (to && roleOf(to) === 'account') card.params.cashBackTo = to.id;
        }

        // Spending once routed onward from any module (a budget group, now a
        // modifier, was the exception), and a card could charge a budget group:
        // older plans lose those links and the money stays where it was.
        const sinkLink = (l) => {
            const from = isObj(l) && nodesById.get(l.from);
            const to = isObj(l) && nodesById.get(l.to);
            if (!from || !to) return false;
            if (roleOf(from) === 'expense') return true;
            return l.basis === 'charges' && Catalog.preset(to.type).kind === 'group';
        };
        const touchesRemoved = (l) => isObj(l) && (removedIds.has(l.from) || removedIds.has(l.to));

        // An account sends only from its balance, and a rule no longer asks for
        // "the payment due". A saved fixed deposit link becomes the same fixed
        // amount from the balance (unless the pair has one already); other
        // deposit and earnings links have no equivalent and are dropped. A due
        // link becomes the fixed payment it was making: a loan's level payment
        // over the years it had left (saved plans only; loans no longer have
        // that setting), or a card's balance plus its monthly purchases.
        const levelPayment = (id) => {
            const n = raw.nodes.find((o) => isObj(o) && o.id === id);
            const q = (n && isObj(n.params) ? n.params : {});
            const principal = Number(q.balance) || 0;
            const months = q.term ? Math.max(1, Math.round(Number(q.term) * 12)) : 0;
            if (!months) return 0;
            const r = (Number(q.rate) || 0) / 1200;
            return r > 0 ? principal * r / (1 - Math.pow(1 + r, -months)) : principal / months;
        };
        const settleRule = (l) => {
            const from = nodesById.get(l.from);
            const to = nodesById.get(l.to);
            if (!from || !to) return l;
            let out = l;
            if (roleOf(from) === 'account' && l.basis !== 'balance') {
                const twin = raw.links.some((o) => isObj(o) && o !== l && o.from === l.from && o.to === l.to && o.basis === 'balance');
                if (l.basis !== 'inflow' || l.mode !== 'fixed' || twin) return null;
                out = { ...l, basis: 'balance' };
            }
            if (out.mode === 'due') {
                const payment = Catalog.preset(to.type).kind === 'card'
                    ? (to.params.balance || 0) + raw.links
                        .filter((o) => isObj(o) && o.from === to.id && o.basis === 'charges' && o.mode === 'fixed' && o.when === 'monthly')
                        .reduce((sum, o) => sum + (Number(o.value) || 0), 0)
                    : levelPayment(to.id);
                out = { ...out, mode: 'fixed', value: payment, when: 'monthly' };
            }
            return out;
        };
        // "Everything above" an amount was once a link's own rule; what an
        // account keeps is the account's now. Its first such link (the one that
        // ran first) sets the minimum, when the account has none, and takes the
        // rest. Its other above links and its old rest only ever got what that
        // minimum keeps now, so they send 0%.
        const sweepers = new Map();
        for (const l of raw.links) {
            if (isObj(l) && l.mode === 'above' && l.basis === 'balance' && !sweepers.has(l.from)) sweepers.set(l.from, l);
        }
        const retireAbove = (l) => {
            const sweeper = sweepers.get(l.from);
            const from = nodesById.get(l.from);
            if (!sweeper || !from || roleOf(from) !== 'account' || l.basis !== 'balance') return l;
            if (l === sweeper) {
                if (from.params.minBalance == null) {
                    from.params.minBalance = cleanNumber(l.value ?? 0, 0, LIMITS.money, 'minimum balance');
                }
                return { ...l, mode: 'rest', value: 0 };
            }
            return l.mode === 'above' || l.mode === 'rest' ? { ...l, mode: 'percent', value: 0 } : l;
        };
        const seenLinks = new Set();
        const seenPairs = new Set();
        raw.links.filter((l) => !sinkLink(l) && !retiredCardLink(l) && !touchesRemoved(l))
            .map((l) => (isObj(l) ? settleRule(l) : l)).filter(Boolean)
            .map((l) => (isObj(l) ? retireAbove(l) : l)).forEach((l, i) => {
            const link = cleanLink(l, nodesById, i);
            if (seenLinks.has(link.id)) fail(`link id ${link.id} is used twice`);
            const pair = `${link.from}>${link.to}>${link.basis}`;
            if (seenPairs.has(pair)) fail(`link ${i} duplicates another link`);
            seenLinks.add(link.id);
            seenPairs.add(pair);
            plan.links.push(link);
        });

        // At most one rest link per source and basis: two "rests" cannot both
        // take everything that is left.
        const rests = new Set();
        for (const l of plan.links) {
            if (l.mode !== 'rest') continue;
            const key = `${l.from}:${l.basis}`;
            if (rests.has(key)) l.mode = 'percent';
            rests.add(key);
        }

        // One link pays an expense's cost: a second would pay it twice, so it
        // becomes a fixed amount to fill in.
        const costsPaid = new Set();
        for (const l of plan.links) {
            if (l.mode !== 'cost') continue;
            if (costsPaid.has(l.to)) Object.assign(l, { mode: 'fixed', value: 0 });
            costsPaid.add(l.to);
        }
        return plan;
    }

    /** A deep copy with fresh ids throughout: for imports and duplicates, so a
     *  copy can never collide with the plan it came from. */
    function cloneWithNewIds(plan, name) {
        const copy = JSON.parse(JSON.stringify(plan));
        const map = new Map();
        copy.id = newId('p');
        if (name) copy.name = name;
        copy.createdAt = copy.updatedAt = new Date().toISOString();
        for (const n of copy.nodes) {
            const id = newId('n');
            map.set(n.id, id);
            n.id = id;
        }
        for (const n of copy.nodes) {
            if (n.params && n.params.cashBackTo) n.params.cashBackTo = map.get(n.params.cashBackTo) || null;
        }
        for (const l of copy.links) {
            l.id = newId('l');
            l.from = map.get(l.from);
            l.to = map.get(l.to);
            for (const s of [l, l.back]) {
                for (const c of [s && s.startWhen, s && s.stopWhen]) {
                    if (c && c.account) c.account = map.get(c.account) || null;
                }
            }
        }
        delete copy.goals;
        return copy;
    }

    return {
        PLAN_VERSION, LIMITS, GEOM, MONTHS, RULES, PlanError, REMOVED_TYPES, reconnect,
        ymParse, ymFormat, ymNow, ymAdd, ymDiff, ymLabel,
        newId, roleOf, basesFor, modesFor, timingsFor, costPayer, portTargets, targetRoles, basesBetween, changeBasis, isPretax,
        createPlan, createNode, iconOf, ageAt, ageMonth, stopAge, startAge, incomeEnd, canTurn, makeTwoWay, BACK_MODES, BACK_WHENS, START_KINDS, startAgeMonth, RETIRED_TYPES, canConnect, createLink, fitRule,
        GOAL_METRICS, GOAL_OPS, GOAL_UNITS, GOAL_DUES, GOAL_VALUE, GOAL_AGE, GOAL_COLORS, createGoal, goalDate,
        validateGoals, legacyGoals, mergeGoals, validatePlan, cloneWithNewIds,
    };
}));
