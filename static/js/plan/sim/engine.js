'use strict';

// ─── engine.js ──────────────────────────────────────────────────────────────
// The simulator. Runs a plan month by month and returns every balance and
// every flow. Pure: the same plan always gives the same numbers. No clock, no
// randomness, no DOM, so it runs live in the renderer on every edit and under
// node --test unchanged.
//
// One month, in order:
//   1. Debts that start this month become owed, and their proceeds are paid
//      out along their proceeds links. A loan secured by an asset brings the
//      asset in with it.
//   2. Balances move. Accounts earn (or lose) at their rate and keep it;
//      debts accrue interest; assets appreciate. Cards make their purchases.
//   3. Income arrives and is split along their links. Money keeps
//      moving through spending and modifiers until it comes to rest. An
//      account keeps whatever arrives.
//   4. Scheduled moves out of account balances run (withdrawals, shares,
//      sweeps), upstream accounts first, so a transfer made early in the pass
//      is seen by the accounts below it in the same month.
//   5. The month's balances are recorded.
//
// Rates. An account's rate is an effective annual rate (APY): a 4% account
// grows by exactly 4% over twelve months. A debt's rate is an APR charged
// monthly at APR/12, which is how cards and loans quote it.
//
// Pre-tax contributions. Income sent to a 401(k), an HSA or a Traditional IRA
// is taken from gross pay before withholding, so only what is left is taxed.
// Every percentage from an income is a share of the same paycheck, so they
// add up together: 10% to a 401(k) and 90% to a bank account is all of it.
// A pre-tax share goes in whole; any other share is withheld on the way out
// (90% of gross pay, less withholding). Fixed amounts and the rest are
// take-home pay, except a fixed amount into a pre-tax account.
//
// Employer match. A 401(k)'s Employer match is the share of each contribution
// the employer adds, up to its yearly match limit. Only pay sent straight from
// income is matched (not transfers from other accounts), and the match is new
// money: it does not count toward the account's yearly contribution limit.
//
// Overdrawing. A fixed amount out of an account's balance is drawn in full,
// even past zero: the account goes negative (and earns nothing while it is)
// rather than the payment falling short, and the plan is flagged `overdrawn`
// from the first month it ends below zero. The other ways out of a balance
// (a share of it, the rest) are measured against what it holds, so they take
// nothing from an empty or overdrawn account.
//
// Minimum balance. An account's Keep at least is a floor for those other ways
// out: a share or the rest is measured against only what is over it, so a
// checking account that keeps $4,000 splits each paycheck and leaves the
// $4,000 alone. An account below its minimum keeps what arrives until it is
// back up to it. A fixed amount is still drawn in full (a bill is paid), and
// the plan is flagged `below-minimum` from the first month an account that had
// reached its minimum ends below it.
//
// Two-way links. A link between two accounts may have a way back, out of the
// target's balance into the source, with the same rules as any balance link,
// running side by side with the way out.
//
// Starting. Each side of a link starts now or when its condition is first met
// (plan.js, Starting): an age, or an account's balance at the top of a month
// reaching an amount. A fixed amount rises each year from its start. A side
// that never starts (no plan age, no account picked, a size never reached) is
// flagged `no-start`.
//
// Stopping. A side may stop when a condition of the same kinds is first met;
// it does not run from that month on. A two-way link's way out can stop at
// retirement as its way back starts. One that cannot be met (an age missing,
// no account picked) runs on and is flagged `no-stop`.
//
// Stopping income. A salary or paycheck may be set to stop: its Last paid
// month is the last it pays, and stopping at an age it pays up to the month
// before the plan's person turns that age (plan.js, incomeEnd). Without the
// plan's age set, an age stop is flagged `stop-no-age`, and a stop at the
// retirement age without it set `stop-no-retire-age`; either runs on.
//
// Expense costs. An expense may have a cost of its own, on a schedule like
// income's (every month, a yearly lump, once) and rising by its inflation rate
// each year from when it starts. A link set to the cost pays exactly what falls
// due that month: it is a fixed amount whose size and timing come from the
// expense, so it overdraws, charges a card and falls short like any fixed one.
// Setting a link to the cost is optional: whatever links feed an expense, the
// plan is flagged `cost-uncovered` when what comes in over the plan is less
// than the cost that falls due.
//
// Paying debts. A payment never exceeds what is owed: once a debt is paid off,
// the money its links would have sent stays with the payer and falls through
// to the payer's later links (its rest, usually savings). A debt that has its
// own Overpayment links is the exception: that is a snowball, and the freed
// payments go on along them instead. (Only loans have them. A card is paid
// down and no further: what it cannot take stays with the payer.)
//
// Credit limits. A card with a limit never charges past it: purchases are held
// to the credit left (limit less balance owed). On a card, a percent link
// charges that share of the limit each time it fires and a rest link charges
// whatever credit is left after the others. Without a limit neither charges
// anything. A card owing more than 30% of its limit at the month's peak (after
// purchases, before payments) is flagged as `utilization`.
//
// Assets. A loan's Asset value is the home or car it is secured by. The asset
// counts toward net worth from the start (or, for a loan that starts inside the
// plan, from the month it is bought) and changes each month at its
// Appreciation rate, an effective annual rate like an account's. That change
// is growth. No money flows into or out of it: what was paid for it was
// spending, and its arrival is `acquired`. It stays after the loan is paid off.
//
// Conservation. Money enters only as income, an employer
// match, cash back, growth or a loan's proceeds, and leaves only as spending,
// a tax or fee, or debt interest. A credit card's annual fee is a fee: it is added to the
// balance owed, so it lowers net worth the month it is charged. Money with nowhere to go lands in the Unassigned pool, which
// counts toward net worth. So the change in net worth always equals
//   income - withholding + match + cash back + growth + acquired - interest - spent - taxes/fees
// and the test suite checks that identity on every scenario.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const Catalog = isNode ? require('./catalog.js') : root.PlanCatalog;
    const Plan = isNode ? require('./plan.js') : root.PlanModel;
    const api = factory(Catalog, Plan);
    if (isNode) module.exports = api;
    else root.PlanEngine = api;
}(typeof self !== 'undefined' ? self : this, function (Catalog, Plan) {

    // Amounts under a millionth of a currency unit are treated as zero, so
    // float dust never shows up as a shortfall or a loop that will not settle.
    const EPS = 1e-6;

    // Money moving between modules in one month is processed as a queue of
    // arrivals. A loop of links that each pass on everything (two "rest" links
    // facing each other) would never settle; past this many arrivals in one
    // month the remainder is parked in Unassigned and the plan is flagged.
    const MAX_ARRIVALS_PER_MONTH = 20000;

    // Evaluation order inside one basis: fixed amounts first, then percentages
    // (each of the full amount), then the rest.
    const MODE_ORDER = { fixed: 1, percent: 2, rest: 3 };

    // Share of a card's limit past which carrying a balance is a red flag.
    // (1% to 10% is the ideal range; only the red flag is reported.)
    const UTILIZATION_FLAG = 30;

    function simulate(plan) {
        const start = plan.settings.start;
        const months = Math.max(1, Math.round(plan.settings.years * 12));
        const startMonth = Plan.ymParse(start).m;
        const idxOf = (ym) => (ym ? Plan.ymDiff(start, ym) : null);
        const series = () => new Float64Array(months);

        // ── State ──────────────────────────────────────────────────────────
        const states = [];
        const byId = new Map();
        plan.nodes.forEach((node, index) => {
            const preset = Catalog.preset(node.type);
            if (!preset) return;
            const s = makeState(node, preset, index, months, idxOf, series);
            // An income's stop can hang on the plan's age, so it is read here.
            if (s.role === 'source') {
                const end = Plan.incomeEnd(plan, node);
                s.endIdx = end ? idxOf(end) : Infinity;
            }
            states.push(s);
            byId.set(s.id, s);
        });

        // A side with a start condition (plan.js, Starting) waits for it: an
        // age is a month known now; an account's size is checked at the top
        // of each month (`waiting`). Sent once, it is sent the month it starts.
        const waiting = [];
        const startOn = (L, cond) => {
            if (!cond) return;
            L.cond = cond;
            if (cond.kind === 'age' || cond.kind === 'retire') {
                const ym = Plan.startAgeMonth(plan, cond);
                L.startIdx = ym == null ? Infinity : Math.max(L.startIdx, idxOf(ym));
                if (L.when === 'once') L.dateIdx = L.startIdx;
                return;
            }
            const acct = cond.account && byId.get(cond.account);
            L.waitOn = acct && acct.role === 'account' ? acct : null;
            L.notBefore = L.startIdx;
            L.startIdx = Infinity;
            if (L.when === 'once') L.dateIdx = null;
            if (L.waitOn) waiting.push(L);
        };

        // A side with a stop condition does not run from the month it is met
        // on: an age is a month known now; an account's size is checked at
        // the top of each month (`stopping`), after any start that month.
        const stopping = [];
        const stopOn = (L, cond) => {
            if (!cond) return;
            L.stopCond = cond;
            if (cond.kind === 'age' || cond.kind === 'retire') {
                const ym = Plan.startAgeMonth(plan, cond);
                if (ym != null) L.endIdx = Math.min(L.endIdx, idxOf(ym) - 1);
                return;
            }
            const acct = cond.account && byId.get(cond.account);
            L.stopOnAcct = acct && acct.role === 'account' ? acct : null;
            if (L.stopOnAcct) stopping.push(L);
        };

        const linkStates = [];
        for (const link of plan.links) {
            const from = byId.get(link.from);
            const to = byId.get(link.to);
            if (!from || !to || !from.outs[link.basis]) continue;
            // A link paying an expense's cost is a fixed amount set by the expense.
            const pays = link.mode === 'cost';
            const L = {
                id: link.id, link, from, to,
                mode: pays ? 'fixed' : link.mode, costOf: pays ? to : null,
                basis: link.basis, when: link.when,
                value: link.value, growth: link.growth || 0,
                dateIdx: link.date ? idxOf(link.date) : null,
                startIdx: link.start ? idxOf(link.start) : -Infinity,
                endIdx: link.end ? idxOf(link.end) : Infinity,
                flow: series(),
                short: 0, shortFirst: -1,
                givenMonth: -1, given: 0,   // fixed links: paid so far this month
            };
            // A source keeps its pre-tax links apart: they split gross pay.
            const group = link.basis === 'inflow' && from.role === 'source' && Plan.isPretax(plan, link)
                ? 'pretax' : link.basis;
            from.outs[group].push(L);
            linkStates.push(L);

            startOn(L, link.startWhen);
            stopOn(L, link.stopWhen);

            // A two-way link's way back runs out of the target's balance into
            // the source, side by side with the way out, each from its own
            // start. Both halves carry the link's id; the way back is marked `back`.
            if (link.back && from.role === 'account' && to.role === 'account') {
                const b = link.back;
                const B = {
                    id: link.id, link, from: to, to: from, back: true,
                    mode: b.mode, costOf: null, basis: 'balance', when: b.when,
                    value: b.value, growth: b.mode === 'fixed' ? b.growth || 0 : 0,
                    dateIdx: b.date ? idxOf(b.date) : null,
                    startIdx: -Infinity,
                    endIdx: Infinity,
                    flow: series(),
                    short: 0, shortFirst: -1,
                    givenMonth: -1, given: 0,
                };
                startOn(B, b.startWhen);
                stopOn(B, b.stopWhen);
                to.outs.balance.push(B);
                linkStates.push(B);
            }
        }
        for (const s of states) {
            for (const basis of Object.keys(s.outs)) {
                s.outs[basis].sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
            }
        }

        const accounts = states.filter((s) => s.role === 'account');
        const debts = states.filter((s) => s.role === 'debt');
        const sources = states.filter((s) => s.role === 'source');
        const cards = states.filter((s) => s.kind === 'card');
        // Where each card's cash back goes: an account, else the card's balance.
        for (const s of cards) {
            const to = s.params.cashBackTo && byId.get(s.params.cashBackTo);
            s.cashBackTo = to && to.role === 'account' ? to : null;
        }
        const flowOrder = topoOrder(states, linkStates).filter((s) => s.role === 'account');

        const totals = {
            earned: series(), withheld: series(), match: series(), cashback: series(),
            growth: series(), interest: series(), spent: series(), skimmed: series(),
            proceeds: series(), debtPaid: series(), acquired: series(),
        };
        const unassigned = new Float64Array(months + 1);
        const unassignedIn = series();
        const netWorth = new Float64Array(months + 1);
        let unassignedBal = 0;
        let runaway = false;

        // ── Moving money ───────────────────────────────────────────────────
        // A flat queue of [state, amount, link] arrivals, drained after each
        // phase. The link is the one the money came along (null for cash back).
        const queue = [];
        let head = 0;
        let arrivals = 0;
        let t = 0;
        let cal = startMonth;

        const activeAt = (L) => t >= L.startIdx && t <= L.endIdx;
        const costDue = (s) => scheduled(s, s.params.cost || 0, t, cal);
        const firesNow = (L) => {
            if (L.costOf) return costDue(L.costOf) > EPS;
            return L.when === 'monthly'
                // Yearly: in the month it starts (the plan's first, starting
                // now) and every twelfth after, so a start leaves no gap.
                || (L.when === 'yearly' && (t - Math.max(0, L.startIdx)) % 12 === 0)
                || (L.when === 'once' && t === L.dateIdx);
        };
        const fixedValue = (L) => {
            if (L.costOf) return costDue(L.costOf);
            const years = Math.floor((t - Math.max(0, L.startIdx)) / 12);
            return L.growth ? L.value * Math.pow(1 + L.growth / 100, years) : L.value;
        };
        const locked = (s) => s.lockIdx != null && t < s.lockIdx;

        function park(s, amount) {
            unassignedBal += amount;
            unassignedIn[t] += amount;
            if (s && s.unplaced) s.unplaced[t] += amount;
        }

        function noteShort(L, amount) {
            L.short += amount;
            if (L.shortFirst < 0) L.shortFirst = t;
        }

        function transfer(L, amount) {
            L.flow[t] += amount;
            L.from.outflow[t] += amount;
            if (L.to.role === 'debt') L.to.pending += amount;
            queue.push(L.to, amount, L);
        }

        /** How much more a debt can take this month: what it owes less what is
         *  already on its way to it. Unlimited for a snowball (Overpayment links),
         *  whose overpayments move on. */
        function room(d) {
            if (d.outs.inflow.some(activeAt)) return Infinity;
            return Math.max(0, d.bal - d.pending);
        }

        /** A link's wanted amount, held to what its target debt can take. */
        function capToDebt(L, want) {
            return L.to.role === 'debt' ? Math.min(want, room(L.to)) : want;
        }

        /** The employer's match on `contribution`, paid into account `s`: its
         *  match rate of it, up to the yearly match limit. */
        function addMatch(s, contribution) {
            const room = s.matchLimit == null ? Infinity : Math.max(0, s.matchLimit - s.matchedThisYear);
            const added = Math.min(contribution * s.matchRate / 100, room);
            if (added <= EPS) return;
            s.matchedThisYear += added;
            s.matched[t] += added;
            s.bal += added;
            totals.match[t] += added;
        }

        /** Split `amount` arriving at `s` across its links on `basis`, a
         *  percentage taken of `base` (income: see Pre-tax contributions).
         *  Returns what no link took. */
        function allocate(s, basis, amount, base = amount) {
            const list = s.outs[basis];
            if (!list.length || amount <= EPS) return amount;
            let remaining = amount;
            for (const L of list) {
                if (!activeAt(L)) continue;
                let want;
                if (L.mode === 'fixed') {
                    if (!firesNow(L)) continue;
                    if (L.givenMonth !== t) { L.givenMonth = t; L.given = 0; }
                    want = fixedValue(L) - L.given;
                } else if (L.mode === 'percent') {
                    want = base * L.value / 100;
                } else {
                    want = remaining;
                }
                want = capToDebt(L, want);
                if (want <= EPS) continue;
                const give = Math.min(want, remaining);
                if (L.mode === 'fixed') L.given += give;
                // A fixed amount can still be topped up by a later arrival this
                // month, so its shortfall is settled at month end instead.
                if (L.mode === 'percent' && want - give > EPS) noteShort(L, want - give);
                if (give > EPS) {
                    transfer(L, give);
                    remaining -= give;
                }
            }
            return remaining > EPS ? remaining : 0;
        }

        /** Money reaching a debt: the balance falls first, and anything past
         *  zero moves on through the debt's links. Returns what went to the
         *  balance. */
        function settle(s, amount) {
            const pay = Math.min(amount, s.bal);
            s.bal -= pay;
            if (pay > EPS && s.bal <= EPS) {
                s.bal = 0;
                if (s.paidOffAt < 0) s.paidOffAt = t;
            }
            const over = amount - pay;
            if (over > EPS) {
                const left = allocate(s, 'inflow', over);
                if (left > EPS) park(s, left);
            }
            return pay;
        }

        /** Money `amount` reaching `s`, along link `via` (null when it came
         *  some other way). */
        function receive(s, amount, via) {
            switch (s.role) {
                case 'account': {
                    let accepted = amount;
                    if (s.cap != null) {
                        const room = Math.max(0, s.cap - s.depositsThisYear);
                        if (amount > room + EPS) {
                            accepted = room;
                            s.capped += amount - room;
                            if (s.cappedFirst < 0) s.cappedFirst = t;
                            park(s, amount - room);
                        }
                    }
                    if (accepted <= EPS) return;
                    s.depositsThisYear += accepted;
                    s.inflow[t] += accepted;
                    s.bal += accepted;
                    if (s.matchRate > 0 && via && via.from.role === 'source') addMatch(s, accepted);
                    return;
                }
                case 'expense': {
                    s.inflow[t] += amount;
                    const kept = allocate(s, 'inflow', amount);
                    s.consumed[t] += kept;
                    totals.spent[t] += kept;
                    return;
                }
                case 'debt': {
                    s.pending = Math.max(0, s.pending - amount);
                    s.inflow[t] += amount;
                    const pay = settle(s, amount);
                    s.paid[t] += pay;
                    totals.debtPaid[t] += pay;
                    return;
                }
                case 'modifier': {
                    // A budget group: everything arriving is split by its links.
                    s.inflow[t] += amount;
                    const left = allocate(s, 'inflow', amount);
                    if (left <= EPS) return;
                    // What a budget group does not hand on is spent in the group.
                    s.consumed[t] += left;
                    totals.spent[t] += left;
                    return;
                }
                default:
                    // Nothing links into income; validatePlan rejects it.
                    park(s, amount);
            }
        }

        function drain() {
            while (head < queue.length) {
                const s = queue[head];
                const amount = queue[head + 1];
                const via = queue[head + 2];
                head += 3;
                if (++arrivals > MAX_ARRIVALS_PER_MONTH) {
                    runaway = true;
                    park(null, amount);
                    continue;
                }
                receive(s, amount, via);
            }
            queue.length = 0;
            head = 0;
        }

        /** A card's purchases this month. Each charges link adds its amount to
         *  the balance and sends it to the spending it pays for, held to the
         *  credit left under the card's limit (if it has one). A percent link
         *  charges a share of the limit; a rest link charges the credit left.
         *  Cash back is deposited in the card's cash back account, or else
         *  credits the balance. */
        function chargeCard(s) {
            const limit = s.params.limit > 0 ? s.params.limit : null;
            for (const L of s.outs.charges) {
                if (!activeAt(L) || !firesNow(L)) continue;
                const available = limit == null ? Infinity : Math.max(0, limit - s.bal);
                let want;
                if (L.mode === 'fixed') want = fixedValue(L);
                else if (limit == null) want = 0;
                else want = L.mode === 'percent' ? limit * L.value / 100 : available;
                const amount = Math.min(want, available);
                L.givenMonth = t;
                L.given = amount;
                if (L.mode === 'percent' && want - amount > EPS) noteShort(L, want - amount);
                if (amount <= EPS) continue;
                s.bal += amount;
                s.charged[t] += amount;
                const back = amount * (s.params.cashBack || 0) / 100;
                if (back > EPS) {
                    s.cashback[t] += back;
                    totals.cashback[t] += back;
                    if (s.cashBackTo) {
                        s.outflow[t] += back;
                        queue.push(s.cashBackTo, back, null);
                    } else {
                        settle(s, back);
                    }
                }
                transfer(L, amount);
            }
            // Utilization is read at the month's peak, once purchases are on and
            // before payments land, which is when a statement would close.
            if (limit != null) {
                const used = s.bal / limit * 100;
                if (used > s.utilPeak) s.utilPeak = used;
                if (used > UTILIZATION_FLAG && s.utilFirst < 0) s.utilFirst = t;
            }
        }

        function withdraw(s) {
            // What a share or the rest may take: the balance over the account's
            // minimum (see Minimum balance above).
            const floor = s.params.minBalance || 0;
            const spare = () => Math.max(0, s.bal - floor);
            const base = spare();
            for (const L of s.outs.balance) {
                if (!activeAt(L) || !firesNow(L)) continue;
                let want;
                switch (L.mode) {
                    case 'fixed':
                        want = fixedValue(L);
                        L.givenMonth = t;
                        L.given = 0;
                        break;
                    case 'percent': want = base * L.value / 100; break;
                    default:        want = spare();
                }
                // A fixed amount is drawn in full, past zero if need be (see
                // Overdrawing above); the rest take only what is spare.
                const held = capToDebt(L, want);
                const give = L.mode === 'fixed' ? held : Math.min(held, spare());
                if (L.mode === 'fixed') L.given = give;
                if (give > EPS) {
                    s.bal -= give;
                    transfer(L, give);
                }
            }
        }

        function settleFixedShortfalls() {
            for (const L of linkStates) {
                if (L.mode !== 'fixed' || !activeAt(L) || !firesNow(L)) continue;
                // A payment to a debt that is paid off is not short: nothing is owed.
                if (L.to.role === 'debt' && L.to.bal <= EPS) continue;
                const given = L.givenMonth === t ? L.given : 0;
                const missing = fixedValue(L) - given;
                if (missing > EPS) noteShort(L, missing);
            }
        }

        // ── Opening position ───────────────────────────────────────────────
        for (const s of accounts) s.bal = s.params.balance || 0;
        for (const s of debts) s.bal = s.originates ? 0 : (s.params.balance || 0);
        recordBalances(0);

        // ── The months ─────────────────────────────────────────────────────
        for (t = 0; t < months; t++) {
            cal = ((startMonth - 1 + t) % 12) + 1;
            arrivals = 0;
            // Sides waiting on an account's size start once it is reached.
            for (let i = waiting.length - 1; i >= 0; i--) {
                const L = waiting[i];
                if (L.waitOn.bal < L.cond.amount - EPS) continue;
                L.startIdx = Math.max(t, L.notBefore);
                if (L.when === 'once') L.dateIdx = L.startIdx;
                waiting.splice(i, 1);
            }
            // Sides set to stop at an account's size stop once it is reached.
            for (let i = stopping.length - 1; i >= 0; i--) {
                const L = stopping[i];
                if (L.stopOnAcct.bal < L.stopCond.amount - EPS) continue;
                L.endIdx = Math.min(L.endIdx, t - 1);
                stopping.splice(i, 1);
            }
            if (cal === 1) {
                for (const s of accounts) { s.depositsThisYear = 0; s.matchedThisYear = 0; }
            }

            // Card annual fees: charged in the plan's first month and every
            // twelfth after, added to what the card owes.
            if (t % 12 === 0) {
                for (const s of cards) {
                    const fee = s.params.annualFee || 0;
                    if (fee <= EPS) continue;
                    s.bal += fee;
                    s.fees[t] += fee;
                    totals.skimmed[t] += fee;
                }
            }

            // 1. New debts.
            for (const s of debts) {
                if (!s.originates || t !== s.startIdx) continue;
                const principal = s.params.balance || 0;
                s.bal += principal;
                totals.proceeds[t] += principal;
                if (s.assetValue) {
                    s.assetBal = s.params.asset;
                    totals.acquired[t] += s.assetBal;
                }
                const left = allocate(s, 'proceeds', principal);
                if (left > EPS) park(s, left);
            }
            drain();

            // 2. Growth and interest.
            for (const s of accounts) {
                if (s.bal > EPS && s.monthlyRate !== 0) {
                    const earned = s.bal * s.monthlyRate;
                    s.bal += earned;
                    s.earnings[t] = earned;
                    totals.growth[t] += earned;
                }
            }
            for (const s of debts) {
                if (s.bal > EPS && s.params.rate > 0) {
                    const interest = s.bal * s.params.rate / 1200;
                    s.bal += interest;
                    s.interest[t] = interest;
                    totals.interest[t] += interest;
                }
                if (s.assetBal > EPS && s.assetMonthlyRate !== 0) {
                    const change = s.assetBal * s.assetMonthlyRate;
                    s.assetBal += change;
                    s.assetGrowth[t] = change;
                    totals.growth[t] += change;
                }
            }
            for (const s of cards) chargeCard(s);
            drain();

            // 3. Income.
            for (const s of sources) {
                const gross = scheduled(s, s.params.amount, t, cal);
                if (gross <= EPS) continue;
                const pretax = gross - allocate(s, 'pretax', gross);
                const taxable = gross - pretax;
                const kept = 1 - Math.min(95, s.params.tax || 0) / 100;
                const net = taxable * kept;
                totals.earned[t] += gross;
                totals.withheld[t] += taxable - net;
                s.gross[t] = gross;
                s.pretax[t] = pretax;
                s.produced[t] = pretax + net;
                const left = allocate(s, 'inflow', net, gross * kept);
                if (left > EPS) park(s, left);
                drain();
            }
            // 4. Scheduled moves out of balances.
            for (const s of flowOrder) {
                if (!s.outs.balance.length || locked(s)) continue;
                withdraw(s);
                drain();
            }

            settleFixedShortfalls();

            // 5. Record.
            recordBalances(t + 1);
        }

        function recordBalances(k) {
            let worth = unassignedBal;
            for (const s of accounts) { s.balance[k] = s.bal; worth += s.bal; }
            for (const s of debts) {
                s.balance[k] = s.bal;
                worth -= s.bal;
                if (s.assetValue) { s.assetValue[k] = s.assetBal; worth += s.assetBal; }
            }
            unassigned[k] = unassignedBal;
            netWorth[k] = worth;
        }

        return buildResults({
            plan, months, start, states, linkStates, totals,
            unassigned, unassignedIn, netWorth, runaway,
        });
    }

    // ── Pieces ─────────────────────────────────────────────────────────────

    function makeState(node, preset, index, months, idxOf, series) {
        const role = preset.role;
        const params = node.params || {};
        const s = {
            id: node.id, node, preset, role, kind: preset.kind || null, params, index,
            bal: 0,
            outs: role === 'account' ? { balance: [] }
                : role === 'debt' ? { inflow: [], proceeds: [], ...(preset.kind === 'card' ? { charges: [] } : {}) }
                    : { inflow: [] },
            outflow: series(),
        };
        if (role === 'source') {
            s.outs.pretax = [];
            s.gross = series();
            s.pretax = series();
            s.produced = series();
            s.unplaced = series();
        }
        if (role === 'account') {
            s.balance = new Float64Array(months + 1);
            s.inflow = series();
            s.earnings = series();
            s.unplaced = series();
            s.monthlyRate = Math.pow(1 + Math.max(-100, params.rate || 0) / 100, 1 / 12) - 1;
            s.lockIdx = params.lockUntil ? idxOf(params.lockUntil) : null;
            // Only a preset that shows the Yearly limit setting is held to it.
            s.cap = params.capYearly != null && Catalog.fieldsFor(preset).includes('capYearly') ? params.capYearly : null;
            s.depositsThisYear = 0;
            // Only a preset that shows the Employer match setting is matched.
            s.matchRate = preset.employerMatch ? params.match || 0 : 0;
            s.matchLimit = params.matchLimit == null ? null : params.matchLimit;
            s.matched = series();
            s.matchedThisYear = 0;
            s.capped = 0;
            s.cappedFirst = -1;
        }
        if (role === 'source' || role === 'expense') {
            s.startIdx = params.start ? idxOf(params.start) : 0;
            s.endIdx = params.end ? idxOf(params.end) : Infinity;
        }
        if (role === 'expense') {
            s.inflow = series();
            s.consumed = series();
        }
        if (role === 'debt') {
            s.balance = new Float64Array(months + 1);
            s.inflow = series();
            s.interest = series();
            s.paid = series();
            s.unplaced = series();
            s.startIdx = params.start ? idxOf(params.start) : null;
            // A debt dated inside the plan is borrowed then; one dated before
            // it (or undated) is already owed on day one.
            s.originates = s.startIdx != null && s.startIdx >= 0;
            s.paidOffAt = -1;
            // What the loan is secured by (cards never are). Owned from day one
            // unless the loan, and so the purchase, comes later.
            if (preset.kind !== 'card' && params.asset > 0) {
                s.assetValue = new Float64Array(months + 1);
                s.assetGrowth = series();
                s.assetMonthlyRate = Math.pow(1 + Math.max(-100, params.assetRate || 0) / 100, 1 / 12) - 1;
                s.assetBal = s.originates ? 0 : params.asset;
            }
            s.pending = 0;          // payments queued but not yet arrived
            if (s.kind === 'card') {
                s.charged = series();
                s.cashback = series();
                s.fees = series();
                s.utilPeak = 0;         // highest share of the limit owed, in percent
                s.utilFirst = -1;       // first month it passed UTILIZATION_FLAG
            }
        }
        if (role === 'modifier') {
            s.inflow = series();
            s.consumed = series();
            s.unplaced = series();
        }
        return s;
    }

    /** What falls due in month `t` of an `amount` on module `s`'s schedule:
     *  an income's gross pay, or an expense's cost. */
    function scheduled(s, amount, t, cal) {
        const p = s.params;
        if (!amount) return 0;
        if (p.per === 'once') return t === s.startIdx ? amount : 0;
        if (t < s.startIdx || t > s.endIdx) return 0;
        const years = Math.floor((t - Math.max(0, s.startIdx)) / 12);
        const g = p.growth ? Math.pow(1 + p.growth / 100, years) : 1;
        if (p.per === 'year') {
            if (p.payMonth) return cal === p.payMonth ? amount * g : 0;
            return (amount / 12) * g;
        }
        return amount * (Catalog.PER_MONTH[p.per] || 1) * g;
    }

    /** Upstream-first order of the modules, so a transfer is seen downstream
     *  in the same month. Kahn's algorithm with ties broken by plan order; a
     *  cycle is opened at its earliest module. */
    function topoOrder(states, linkStates) {
        const indeg = new Map(states.map((s) => [s, 0]));
        const next = new Map(states.map((s) => [s, []]));
        for (const L of linkStates) {
            next.get(L.from).push(L.to);
            indeg.set(L.to, indeg.get(L.to) + 1);
        }
        const order = [];
        const done = new Set();
        let ready = states.filter((s) => indeg.get(s) === 0);
        while (order.length < states.length) {
            if (!ready.length) ready = [states.find((s) => !done.has(s))];
            ready.sort((a, b) => a.index - b.index);
            const s = ready.shift();
            if (done.has(s)) continue;
            done.add(s);
            order.push(s);
            for (const n of next.get(s)) {
                if (done.has(n)) continue;
                const d = indeg.get(n) - 1;
                indeg.set(n, d);
                if (d === 0) ready.push(n);
            }
        }
        return order;
    }

    /** Groups of modules that pass arriving money around in a circle. Such a
     *  loop only settles if each turn passes on less than everything. Tarjan's
     *  strongly connected components over the links that fire on arrival. */
    function findLoops(states, linkStates) {
        const instant = new Map(states.map((s) => [s, []]));
        for (const L of linkStates) {
            if (L.basis === 'inflow' || L.basis === 'proceeds') instant.get(L.from).push(L.to);
        }
        let counter = 0;
        const index = new Map();
        const low = new Map();
        const onStack = new Set();
        const stack = [];
        const loops = [];
        function visit(v) {
            index.set(v, counter);
            low.set(v, counter);
            counter++;
            stack.push(v);
            onStack.add(v);
            for (const w of instant.get(v)) {
                if (!index.has(w)) {
                    visit(w);
                    low.set(v, Math.min(low.get(v), low.get(w)));
                } else if (onStack.has(w)) {
                    low.set(v, Math.min(low.get(v), index.get(w)));
                }
            }
            if (low.get(v) === index.get(v)) {
                const group = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    group.push(w.id);
                } while (w !== v);
                if (group.length > 1) loops.push(group);
            }
        }
        for (const s of states) if (!index.has(s)) visit(s);
        return loops;
    }

    const sum = (arr) => { let x = 0; for (let i = 0; i < arr.length; i++) x += arr[i]; return x; };

    /** The first index where `balance` ends below `floor` after having been at
     *  or over it, or -1. An account still filling up to its minimum has not
     *  dipped below it. */
    function firstDipBelow(balance, floor) {
        let reached = false;
        for (let k = 0; k < balance.length; k++) {
            if (balance[k] >= floor - 0.005) reached = true;
            else if (reached) return k;
        }
        return -1;
    }

    function buildResults(r) {
        const { months, states, linkStates, totals } = r;
        const nodes = Object.create(null);
        const warnings = [];
        const milestones = [];
        const startMonth = Plan.ymParse(r.start).m;

        for (const s of states) {
            const out = { role: s.role, kind: s.kind, outflow: s.outflow };
            for (const key of ['balance', 'inflow', 'earnings', 'gross', 'pretax', 'produced',
                'consumed', 'interest', 'paid', 'unplaced', 'charged', 'cashback', 'fees', 'matched',
                'assetValue', 'assetGrowth']) {
                if (s[key]) out[key] = s[key];
            }
            out.totals = {
                in: s.inflow ? sum(s.inflow) : 0,
                out: sum(s.outflow),
                produced: s.produced ? sum(s.produced) : 0,
                pretax: s.role === 'source' ? sum(s.pretax) : 0,
                consumed: s.consumed ? sum(s.consumed) : 0,
                charged: s.charged ? sum(s.charged) : 0,
                cashback: s.cashback ? sum(s.cashback) : 0,
                fees: s.fees ? sum(s.fees) : 0,
                earnings: s.earnings ? sum(s.earnings) : 0,
                matched: s.matched ? sum(s.matched) : 0,
                interest: s.interest ? sum(s.interest) : 0,
                assetGrowth: s.assetGrowth ? sum(s.assetGrowth) : 0,
                paid: s.paid ? sum(s.paid) : 0,
                unplaced: s.unplaced ? sum(s.unplaced) : 0,
            };
            nodes[s.id] = out;

            if (out.totals.unplaced > 0.005 && s.role !== 'account') {
                warnings.push({ code: 'unassigned', nodeId: s.id, amount: out.totals.unplaced });
            }
            if (s.role === 'account') {
                const k = s.balance.findIndex((v) => v < -0.005);
                if (k >= 0) {
                    warnings.push({ code: 'overdrawn', nodeId: s.id, amount: -Math.min(...s.balance), month: Math.max(0, k - 1) });
                }
                const floor = s.params.minBalance || 0;
                const dip = floor > 0 ? firstDipBelow(s.balance, floor) : -1;
                if (dip >= 0) {
                    warnings.push({ code: 'below-minimum', nodeId: s.id, amount: floor, month: Math.max(0, dip - 1) });
                }
            }
            if (s.role === 'expense' && s.params.cost > 0) {
                // However the money arrives (a link set to Cost, a fixed amount,
                // a share), what comes in over the plan should cover the cost.
                let due = 0;
                for (let k = 0; k < months; k++) due += scheduled(s, s.params.cost, k, ((startMonth - 1 + k) % 12) + 1);
                const missing = due - out.totals.in;
                if (missing > 0.005) warnings.push({ code: 'cost-uncovered', nodeId: s.id, amount: missing });
            }
            if (s.role === 'account' && s.capped > 0.005) {
                warnings.push({ code: 'cap', nodeId: s.id, amount: s.capped, month: s.cappedFirst });
            }
            if (s.kind === 'card' && !(s.params.limit > 0)
                && s.outs.charges.some((L) => L.mode !== 'fixed')) {
                warnings.push({ code: 'no-limit', nodeId: s.id });
            }
            if (s.kind === 'card' && s.utilFirst >= 0) {
                warnings.push({ code: 'utilization', nodeId: s.id, amount: s.utilPeak, month: s.utilFirst });
            }
            if (s.role === 'debt') {
                if (s.paidOffAt >= 0) milestones.push({ code: 'paid-off', nodeId: s.id, month: s.paidOffAt });
                const first = s.originates ? s.params.balance || 0 : s.balance[0];
                if (s.balance[months] > first + 0.005) {
                    warnings.push({ code: 'debt-growing', nodeId: s.id, amount: s.balance[months] - first });
                }
            }
            if (s.role === 'source' && s.params.per !== 'once') {
                // Stopped inside the plan: the last month it pays. Before the
                // plan starts, it pays nothing at all.
                if (s.endIdx >= 0 && s.endIdx < months - 1) milestones.push({ code: 'stops', nodeId: s.id, month: s.endIdx });
                else if (s.endIdx < 0) warnings.push({ code: 'stopped-before', nodeId: s.id });
                if (s.params.stopBy === 'retire' && r.plan.settings.retireAge == null) {
                    warnings.push({ code: 'stop-no-retire-age', nodeId: s.id });
                } else if (Plan.stopAge(r.plan, s) != null && r.plan.settings.age == null) {
                    warnings.push({ code: 'stop-no-age', nodeId: s.id });
                }
            }
            if (s.role === 'account' && s.lockIdx != null && s.lockIdx > 0 && s.lockIdx <= months) {
                milestones.push({ code: 'unlocks', nodeId: s.id, month: s.lockIdx });
            }
            // Percentages that add up past 100% cannot all be paid. An
            // income's pre-tax shares are of the same paycheck as the rest.
            for (const [basis, list] of Object.entries(s.outs)) {
                if (basis === 'pretax') continue;
                const shares = basis === 'inflow' && s.role === 'source' ? [...list, ...s.outs.pretax] : list;
                const pct = shares.filter((L) => L.mode === 'percent').reduce((a, L) => a + L.value, 0);
                if (pct > 100 + 1e-9) warnings.push({ code: 'over-100', nodeId: s.id, basis, amount: pct });
            }
        }

        const links = Object.create(null);
        for (const L of linkStates) {
            const total = sum(L.flow);
            const entry = { flow: L.flow, total, avg: total / months, short: L.short };
            // A two-way link's way back sits under its link's entry.
            if (L.back) links[L.id].back = entry;
            else links[L.id] = entry;
            // A side with a start condition says the month it started (null:
            // it never did), and why when it never did.
            if (L.cond) {
                entry.started = Number.isFinite(L.startIdx) ? Math.max(0, L.startIdx) : null;
                if (entry.started == null) {
                    const why = L.cond.kind === 'retire' && r.plan.settings.retireAge == null ? 'no-retire-age'
                        : L.cond.kind === 'age' || L.cond.kind === 'retire' ? 'no-age'
                        : L.waitOn ? 'unreached' : 'no-account';
                    warnings.push({ code: 'no-start', linkId: L.id, nodeId: L.from.id, why, ...(L.back ? { back: true } : {}) });
                }
            }
            // A side with a stop condition says the first month it no longer
            // runs (null: it never stopped). One that cannot be met (an age
            // with an age missing, no account) runs on, and is flagged.
            if (L.stopCond) {
                entry.stopped = L.endIdx + 1 < months ? Math.max(0, L.endIdx + 1) : null;
                const c = L.stopCond;
                const why = c.kind === 'retire' && r.plan.settings.retireAge == null ? 'no-retire-age'
                    : (c.kind === 'age' || c.kind === 'retire') && r.plan.settings.age == null ? 'no-age'
                    : c.kind === 'balance' && !L.stopOnAcct ? 'no-account' : null;
                if (why) warnings.push({ code: 'no-stop', linkId: L.id, nodeId: L.from.id, why, ...(L.back ? { back: true } : {}) });
            }
            if (L.short > 0.005) {
                warnings.push({ code: 'short', linkId: L.id, nodeId: L.from.id, amount: L.short, month: L.shortFirst,
                    ...(L.back ? { back: true } : {}) });
            }
        }

        for (const group of findLoops(states, linkStates)) warnings.push({ code: 'loop', nodeIds: group });
        if (r.runaway) warnings.push({ code: 'runaway' });

        const t = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, sum(v)]));
        t.startNetWorth = r.netWorth[0];
        t.endNetWorth = r.netWorth[months];
        t.unassigned = r.unassigned[months];

        return {
            months, start: r.start,
            netWorth: r.netWorth,
            unassigned: r.unassigned,
            unassignedIn: r.unassignedIn,
            flows: totals,
            totals: t,
            nodes, links, warnings, milestones,
        };
    }

    return { simulate };
}));
