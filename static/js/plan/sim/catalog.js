'use strict';

// ─── catalog.js ─────────────────────────────────────────────────────────────
// The module library: every module a plan can hold, and the five behaviours
// ("roles") they are all built from.
//
// THE STANDARD. A module's role decides what it does to money, and nothing else
// does. There are five:
//
//   source    Income     Makes money on a schedule. Output only.
//   account   Account    Holds a balance that grows at a rate. Counts toward
//                        net worth. An optional minimum it keeps: shares and
//                        sweeps out of it only take what is over that.
//   expense   Spending   Money that arrives here leaves the plan. An optional
//                        cost on a schedule (and a yearly inflation rate),
//                        which a link set to its cost pays.
//   debt      Debt       Holds what is owed. Interest adds to it; money that
//                        arrives pays it down. A loan may be secured by
//                        something it bought (a home, a car): that thing's
//                        value counts toward net worth beside what is owed.
//                        Nothing flows in or out of it; it only appreciates
//                        (or, at a negative rate, depreciates).
//   modifier  Modifier   Money passes through unchanged and is split on: the
//                        budget group. What it does not pass on is spent in
//                        the group.
//
// Every preset below (about a dozen of them) is one of those five roles with a
// name, an icon, the fields it shows and starting values. Learning the five
// roles is learning the whole library: a Roth IRA and a CD behave alike because
// both are accounts, and the canvas paints them alike for the same reason.
//
// Amounts are set by sources. Links split money between modules (see plan.js
// for link rules). Accounts keep what reaches them, spending consumes it, and
// money that has nowhere to go lands in the plan's Unassigned pool, so nothing
// ever vanishes from the totals.
//
// Dual-environment: a classic <script> in the renderer (window.PlanCatalog)
// and a CommonJS module for the backend validator and the test suite.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlanCatalog = api;
}(typeof self !== 'undefined' ? self : this, function () {

    // ── Roles ──────────────────────────────────────────────────────────────
    // hasIn decides whether a module draws an input port (whether it draws an
    // output port depends on its bases: plan.js, basesFor). `holds` marks the
    // two roles that carry a balance from month to month.
    const ROLES = {
        source:   { id: 'source',   label: 'Income',   hasIn: false, holds: false },
        account:  { id: 'account',  label: 'Account',  hasIn: true,  holds: true },
        expense:  { id: 'expense',  label: 'Spending', hasIn: true,  holds: false },
        debt:     { id: 'debt',     label: 'Debt',     hasIn: true,  holds: true },
        modifier: { id: 'modifier', label: 'Modifier', hasIn: true,  holds: false },
    };
    const ROLE_ORDER = ['source', 'account', 'expense', 'debt', 'modifier'];

    // ── Swatches ───────────────────────────────────────────────────────────
    // The colour and tag a module wears ([data-role] in the CSS). It is its
    // role's, except that a budget group, which only splits, wears its own
    // neutral 'Group' so it does not read as a tax or fee.
    const SWATCHES = {
        ...ROLES,
        group: { id: 'group', label: 'Group' },
    };

    /** The swatch a preset wears: a SWATCHES id. */
    function swatchOf(p) {
        return p.kind === 'group' ? 'group' : p.role;
    }

    // Which roles a link may run into, by the role it leaves. Nothing links
    // into a source (income has no input). Spending sends nothing on. A credit
    // card pays for spending: its links out to spending are purchases charged
    // to the card.
    const LINK_TARGETS = {
        source:   ['account', 'expense', 'debt', 'modifier'],
        account:  ['account', 'expense', 'debt', 'modifier'],
        expense:  ['expense'],
        debt:     ['account', 'expense', 'debt', 'modifier'],
        modifier: ['account', 'expense', 'debt', 'modifier'],
    };

    // ── Fields ─────────────────────────────────────────────────────────────
    // Every parameter any module can have. A role lists the ones it uses
    // (ROLE_FIELDS); a preset may show fewer and relabel them.
    //
    //   money      a currency amount
    //   percent    a percentage, entered as 22 for 22%
    //   number     a plain quantity, shown with its `suffix`
    //   choice     one of `options` ([value, label] pairs)
    //   month      a calendar month, 1-12 (0 = no specific month)
    //   yearmonth  'YYYY-MM', or null when optional and left blank
    //   account    the id of an account in the plan, or null
    const FIELDS = {
        amount:     { type: 'money',     label: 'Amount',           min: 0,    max: 1e10 },
        cost:       { type: 'money',     label: 'Cost',             min: 0,    max: 1e10, optional: true },
        per:        { type: 'choice',    label: 'Every',
                      options: [['week', 'Week'], ['biweek', '2 weeks'], ['month', 'Month'],
                                ['year', 'Year'], ['once', 'Once']] },
        payMonth:   { type: 'month',     label: 'Paid in' },
        growth:     { type: 'percent',   label: 'Raise',            min: -100, max: 100, suffix: '/yr' },
        tax:        { type: 'percent',   label: 'Withholding',      min: 0,    max: 95 },
        start:      { type: 'yearmonth', label: 'Starts',           optional: true },
        end:        { type: 'yearmonth', label: 'Ends',             optional: true },
        balance:    { type: 'money',     label: 'Starting balance', min: 0,    max: 1e11 },
        minBalance: { type: 'money',     label: 'Keep at least',    min: 0,    max: 1e11, optional: true },
        rate:       { type: 'percent',   label: 'Interest',         min: -100, max: 1000, suffix: '/yr' },
        lockUntil:  { type: 'yearmonth', label: 'Locked until',     optional: true },
        capYearly:  { type: 'money',     label: 'Yearly limit',     min: 0,    max: 1e10, optional: true },
        cashBack:   { type: 'percent',   label: 'Cash back',        min: 0,    max: 100 },
        cashBackTo: { type: 'account',   label: 'Cash back to',     optional: true },
        annualFee:  { type: 'money',     label: 'Annual fee',       min: 0,    max: 1e10, optional: true },
        limit:      { type: 'money',     label: 'Credit limit',     min: 0,    max: 1e10, optional: true },
        match:      { type: 'percent',   label: 'Employer match',   min: 0,    max: 200 },
        matchLimit: { type: 'money',     label: 'Yearly match limit', min: 0, max: 1e10, optional: true },
        stopBy:     { type: 'choice',    label: 'Stops',
                      options: [['never', 'Never'], ['date', 'On a date'], ['age', 'At an age'], ['retire', 'At retirement age']] },
        endAge:     { type: 'number',    label: 'At age',           min: 1,    max: 120,  optional: true, suffix: 'yrs' },
        asset:      { type: 'money',     label: 'Asset value',      min: 0,    max: 1e11, optional: true },
        assetRate:  { type: 'percent',   label: 'Appreciation',     min: -100, max: 100,  suffix: '/yr' },
    };

    // How many of each `per` period fall in a month. A yearly amount and a
    // one-off are paid on their own schedule, so they are not listed.
    const PER_MONTH = { week: 52 / 12, biweek: 26 / 12, month: 1 };

    const ROLE_FIELDS = {
        source:   ['amount', 'per', 'payMonth', 'growth', 'tax', 'start', 'stopBy', 'end', 'endAge'],
        account:  ['balance', 'minBalance', 'rate', 'lockUntil', 'capYearly', 'match', 'matchLimit'],
        expense:  ['cost', 'per', 'payMonth', 'growth', 'start', 'end'],
        debt:     ['balance', 'rate', 'start', 'asset', 'assetRate', 'cashBack', 'cashBackTo', 'annualFee', 'limit'],
        modifier: [],
    };

    const ROLE_DEFAULTS = {
        source:   { amount: 0, per: 'month', payMonth: 0, growth: 0, tax: 0, start: null, stopBy: 'never', end: null, endAge: null },
        account:  { balance: 0, minBalance: null, rate: 0, lockUntil: null, capYearly: null, match: 0, matchLimit: null },
        expense:  { cost: null, per: 'month', payMonth: 0, growth: 0, start: null, end: null },
        debt:     { balance: 0, rate: 0, start: null, asset: null, assetRate: 0, cashBack: 0, cashBackTo: null, annualFee: null, limit: null },
        modifier: {},
    };

    // ── Categories ─────────────────────────────────────────────────────────
    // How the library is shelved. A category is for finding a module, the
    // role is what it does.
    //
    // `icons` is the set a placed module in the category may wear instead of
    // its preset's icon (the user picks one in the inspector). Every preset's
    // own icon is offered too (see iconChoices).
    const CATEGORIES = [
        { id: 'income',     name: 'Income',     icon: 'briefcase',
          icons: ['briefcase', 'money', 'arrow-u-up-left', 'laptop', 'coins', 'hand-coins', 'storefront',
                  'receipt', 'handshake', 'chalkboard-teacher', 'hammer', 'paint-brush', 'camera', 'pen-nib',
                  'microphone', 'music-notes', 'truck', 'stethoscope', 'wrench', 'code', 'shopping-bag',
                  'house-line', 'gift', 'scroll', 'hand-heart', 'trophy', 'calendar-check', 'currency-dollar', 'chart-line-up'] },
        { id: 'accounts',   name: 'Accounts',   icon: 'bank',
          icons: ['wallet', 'piggy-bank', 'vault', 'coin-vertical', 'lifebuoy', 'certificate', 'money-wavy', 'bank',
                  'coins', 'currency-dollar', 'lock-key', 'shield-check', 'umbrella', 'house-line', 'car',
                  'airplane-tilt', 'graduation-cap', 'heart', 'star', 'flag', 'target', 'calendar-check',
                  'hand-coins', 'money', 'gift', 'sun', 'tree', 'seal-check', 'plant', 'tree-evergreen', 'heartbeat',
                  'sun-horizon', 'umbrella-simple', 'mountains', 'flower', 'leaf', 'tree-palm', 'sailboat', 'golf',
                  'campfire', 'coffee', 'binoculars', 'hourglass', 'calendar-heart', 'first-aid', 'stethoscope',
                  'pill', 'books', 'student', 'baby', 'hand-heart', 'chart-line-up', 'chart-pie-slice', 'trend-up',
                  'seal-percent', 'currency-btc', 'currency-eth', 'building-office', 'diamond', 'chart-bar',
                  'chart-line', 'chart-donut', 'scales', 'globe', 'rocket', 'lightning', 'cpu', 'flask', 'crown',
                  'medal', 'coin'] },
        { id: 'spending',   name: 'Spending',   icon: 'shopping-cart',
          icons: ['folder', 'house', 'basket', 'fork-knife', 'lightning', 'bus', 'shield-check', 'first-aid', 'siren',
                  'repeat', 'popcorn', 'handbag', 'airplane-tilt', 'island', 'baby', 'book-open', 'paw-print', 'gift',
                  'hand-heart', 'receipt', 'hammer', 'shopping-cart', 'shopping-bag', 'package', 'coffee', 'pizza',
                  'hamburger', 'beer-bottle', 'wine', 't-shirt', 'sneaker', 'scissors', 'television',
                  'game-controller', 'music-notes', 'headphones', 'phone', 'wifi-high', 'drop', 'flame',
                  'gas-pump', 'car', 'train', 'bicycle', 'tooth', 'pill', 'heart', 'dog', 'cat',
                  'graduation-cap', 'barbell', 'ticket', 'camera', 'paint-brush', 'wrench', 'plant',
                  'flower', 'toolbox', 'lamp', 'bed', 'cake', 'balloon'] },
        { id: 'debt',       name: 'Debt',       icon: 'credit-card',
          icons: ['credit-card', 'student', 'car-profile', 'house-simple', 'key', 'handshake', 'first-aid-kit',
                  'shopping-cart-simple', 'bank', 'receipt', 'scales', 'warning', 'clock', 'hourglass', 'link',
                  'anchor', 'lock', 'notebook', 'file-text', 'percent', 'money', 'coins', 'hand-coins', 'wallet',
                  'gavel', 'cardholder'] },
        { id: 'groups',     name: 'Group',      icon: 'folder',
          icons: ['folder', 'arrows-split', 'squares-four', 'funnel', 'house', 'basket', 'shopping-cart',
                  'wallet', 'piggy-bank'] },
    ];

    // ── Presets ────────────────────────────────────────────────────────────
    // id          stable key, stored in plans as the node's `type`
    // fields      which of the role's fields to show (default: all of them)
    // labels      per-field label overrides
    // defaults    starting values merged over ROLE_DEFAULTS. Amounts, rates and
    //             dates always start empty; only a cadence (Every, Paid in) is set
    // fixed       values the preset pins and hides (a windfall is always 'once')
    // kind        modifiers: 'group' (a budget group: it passes everything
    //             on, split by its links). Debts: 'card' (a credit card).
    // pretax      accounts paid from gross pay: income sent here is taken before
    //             withholding (see engine.js, pre-tax contributions)
    // employerMatch  accounts whose Employer match setting adds to what pay puts
    //             in (see engine.js, employer match)
    // inLink      the rule a new link INTO this module starts with
    // keywords    extra search terms
    // A loan's Asset value is what it is secured by (a mortgage's home, a car
    // loan's car): worth that today, or when it is bought if the loan starts
    // later in the plan.
    const DEBT_FIELDS = ['balance', 'rate', 'start', 'asset', 'assetRate'];
    // An income may stop: never, after a month (its Last paid, inclusive), or
    // the month its plan's person reaches an age, its own or the plan's
    // retirement age (plan.js, incomeEnd).
    const STOPS = ['stopBy', 'end', 'endAge'];
    const STOP_LABELS = { end: 'Last paid' };
    const P = (cat, role, id, name, icon, extra = {}) => ({ cat, role, id, name, icon, ...extra });

    // A new link into a spending module starts at 0 with this timing.
    const monthly = () => ({ mode: 'fixed', value: 0, when: 'monthly' });

    const PRESETS = [
        // Income
        // Only a one-time income takes a date. The rest run for the whole plan
        // unless set to stop (STOPS).
        P('income', 'source', 'salary', 'Salary', 'briefcase', {
            defaults: { per: 'year' },
            fixed: { payMonth: 0 },          // a yearly salary is paid out monthly
            fields: ['amount', 'per', 'growth', 'tax', ...STOPS],
            labels: { tax: 'Income tax', ...STOP_LABELS },
            keywords: 'job wage pay employment freelance contract consulting side hustle' }),
        P('income', 'source', 'paycheck', 'Paycheck', 'money', {
            defaults: { per: 'biweek' },
            fixed: { tax: 0 },               // take-home pay is already after tax
            fields: ['amount', 'per', 'payMonth', 'growth', ...STOPS],
            labels: { amount: 'Take-home', ...STOP_LABELS },
            keywords: 'net pay biweekly job gig allowance support royalties other income tax refund irs return' }),
        P('income', 'source', 'one-time-income', 'One-time income', 'sparkle', {
            fixed: { per: 'once' },
            fields: ['amount', 'tax', 'start'],
            labels: { start: 'Date', tax: 'Tax' },
            keywords: 'windfall lottery prize inheritance estate gift one-time' }),

        // Accounts. Banking first: cash, checking, savings and a money market
        // are one thing at different rates; only a lock date makes a deposit
        // its own module.
        P('accounts', 'account', 'bank-account', 'Bank account', 'bank', {
            fields: ['balance', 'minBalance', 'rate'],
            labels: { rate: 'APY' },
            keywords: 'checking savings hysa high-yield money market emergency fund cash bank debit everyday save interest' }),
        P('accounts', 'account', 'term-deposit', 'Term deposit', 'certificate', {
            fields: ['balance', 'minBalance', 'rate', 'lockUntil'],
            labels: { rate: 'APY', lockUntil: 'Matures' },
            keywords: 'cd certificate of deposit locked fixed term' }),

        // Retirement and investing. Every holding is a balance that grows at an
        // expected return, so one module covers stocks, funds, bonds, crypto and
        // gold. What sets the Retirement Account apart is that pay sent to it is
        // pre-tax and an employer may add to it (401(k), Traditional IRA, HSA).
        // Anything paid from take-home pay (a Roth IRA, a 529, a brokerage) is
        // an Investment, which may be locked until a date like any account.
        P('accounts', 'account', '401k', 'Retirement Account', 'piggy-bank', {
            pretax: true,
            employerMatch: true,
            fields: ['balance', 'minBalance', 'rate', 'lockUntil', 'capYearly', 'match', 'matchLimit'],
            labels: { rate: 'Expected return', capYearly: 'Yearly contribution limit' },
            keywords: '401k 403b 457 tsp workplace retirement employer match pre-tax free money traditional ira hsa health savings account' }),
        P('accounts', 'account', 'investment', 'Investment', 'chart-line-up', {
            fields: ['balance', 'minBalance', 'rate', 'lockUntil'],
            labels: { rate: 'Expected return' },
            keywords: 'brokerage stocks etf index fund s&p 500 bonds treasury t-bills crypto bitcoin reit gold invest taxable roth ira 529 plan college education retirement tax-free' }),

        // Spending. Every expense consumes what arrives. It may have a cost of
        // its own, on a schedule like income's; a link set to the cost pays it.
        // Without one, what it spends is up to its links.
        P('spending', 'expense', 'expense', 'Expense', 'shopping-cart', {
            labels: { growth: 'Inflation' },
            inLink: monthly(),
            keywords: 'rent groceries food dining utilities bills transport insurance healthcare subscriptions entertainment shopping travel childcare education pets gifts charity taxes home upkeep repairs' }),
        P('spending', 'expense', 'one-time-expense', 'One-time expense', 'package', {
            fixed: { per: 'once' },
            fields: ['cost', 'start'],
            labels: { start: 'Date' },
            inLink: { mode: 'fixed', value: 0, when: 'once', relDate: 12 },
            keywords: 'wedding renovation remodel vacation trip down payment car purchase furniture appliance funeral emergency repair medical bill one-off big purchase' }),

        // Debt. A card is its own thing (purchases, cash back). All
        // other debt is a balance owed at a rate, repaid by the links into it.
        P('debt', 'debt', 'credit-card', 'Credit card', 'credit-card', {
            kind: 'card',
            fields: ['balance', 'rate', 'limit', 'cashBack', 'cashBackTo', 'annualFee'],
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'cash back rewards points miles travel revolving debt' }),
        P('debt', 'debt', 'loan', 'Loan', 'handshake', {
            fields: DEBT_FIELDS,
            labels: { balance: 'Balance owed', rate: 'APR' },
            keywords: 'mortgage student car auto personal home house property real estate vehicle asset equity heloc medical bnpl buy now pay later installment borrow' }),

        // Group: a modifier that changes nothing, shelved and coloured on its own.
        P('groups', 'modifier', 'living', 'Budget Group', 'folder', {
            kind: 'group',
            fields: [],
            keywords: 'living expenses cost of living spending budget group category split' }),
    ];

    const PRESET_BY_ID = Object.create(null);
    for (const p of PRESETS) {
        if (PRESET_BY_ID[p.id]) throw new Error(`duplicate preset id ${p.id}`);
        if (!ROLES[p.role]) throw new Error(`preset ${p.id}: unknown role ${p.role}`);
        if (p.role === 'modifier' && p.kind !== 'group') {
            throw new Error(`preset ${p.id}: modifier needs a kind`);
        }
        PRESET_BY_ID[p.id] = p;
    }

    function preset(id) {
        return PRESET_BY_ID[id] || null;
    }

    const CATEGORY_BY_ID = Object.create(null);
    for (const c of CATEGORIES) CATEGORY_BY_ID[c.id] = c;

    /** Icons a module of this preset may wear: its category's set, plus the
     *  icon its preset ships with. No duplicates, preset icon first. */
    function iconChoices(p) {
        const cat = CATEGORY_BY_ID[p.cat];
        return [...new Set([p.icon, ...(cat ? cat.icons : [])])];
    }

    /** The fields a preset shows, in display order. */
    function fieldsFor(p) {
        const all = ROLE_FIELDS[p.role];
        const shown = p.fields ? all.filter((k) => p.fields.includes(k)) : all.slice();
        const pinned = p.fixed ? Object.keys(p.fixed) : [];
        return shown.filter((k) => !pinned.includes(k));
    }

    /** A field's label on a preset (preset override, else the generic one). */
    function fieldLabel(p, key) {
        return (p.labels && p.labels[key]) || FIELDS[key].label;
    }

    /** Starting params for a preset: role defaults, preset defaults, pins. */
    function defaultParams(p) {
        return { ...ROLE_DEFAULTS[p.role], ...(p.defaults || {}), ...(p.fixed || {}) };
    }

    return {
        ROLES, ROLE_ORDER, SWATCHES, swatchOf, LINK_TARGETS, FIELDS, PER_MONTH, ROLE_FIELDS,
        CATEGORIES, PRESETS, preset, iconChoices, fieldsFor, fieldLabel, defaultParams,
    };
}));
