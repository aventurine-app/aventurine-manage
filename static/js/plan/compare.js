'use strict';

// ─── compare.js ─────────────────────────────────────────────────────────────
// The Compare workspace, as an Ant Design page: up to four plans side by
// side. Every plan runs over the same length (the Over chips, kept in PlanPrefs)
// from its own start; the plans keep their own lengths, as Compare runs a
// copy (Runs.all({ years })).
//
//   Picks         four plan dropdowns, each in its own colour (blue, orange,
//                 cyan, purple). The first is always a plan; the others may
//                 be None. Picking a plan another dropdown shows swaps them.
//                 Each dropdown's file icon wears its line's colour.
//   Tabs          one card, one view at a time (kept in PlanPrefs):
//     Net worth     the picked plans' net worth over the run; with two, the
//                   gap between them is shaded. Hovering reads every month.
//     Metrics       the picked plans as columns, the measures as rows: net
//                   worth and debt at the end, debt payoff (months until
//                   nothing is owed for the rest of the run: "No debt" when
//                   nothing ever is, "Not paid off" when debt is still owed at
//                   the end), expenses (what expense modules and budget groups
//                   spent; taxes and card fees aside), interest, growth
//                   (account earnings plus card cash back), taxes and the
//                   goals met on time. Each row is ranked: the best tagged
//                   Best with a green trophy, the runners-up 2nd (silver) and
//                   3rd (bronze), each tinted, so rank never rests on colour
//                   alone.
//     Goals         when each picked plan meets each goal (over the goal
//                   horizon, not the length compared).
//
// Pressing a plan's name in Metrics opens it in Analyze.

(function () {
    const D = window.Describe;
    const G = window.PlanGoals;
    const K = window.Components;
    const root = document.getElementById('compare');
    if (!root) return;

    const esc = escapeHtml;
    const money = (v, o) => Fmt.money(v, o);

    // The tint each podium place wears (--heat in compare.css), best first.
    const HEAT = [1, 0.6, 0.32];
    const PLACES = ['Best', '2nd', '3rd'];
    // The medal the runners-up's trophies wear (--medal-* in style.css). Best
    // wears the success green instead.
    const MEDALS = [null, 'silver', 'bronze'];

    // The four picks: each one's letter and chart colour.
    const SLOTS = ['a', 'b', 'c', 'd'];
    const SLOT_NAMES = ['First plan', 'Second plan', 'Third plan', 'Fourth plan'];
    const colorOf = (i) => `--chart-plan-${SLOTS[i]}`;

    const VIEWS = [['worth', 'Net worth', 'chart-line'], ['metrics', 'Metrics', 'table'], ['goals', 'Goals', 'target']];

    const LENGTHS = PlanStore.LENGTHS;
    const PREFS = { years: 'compare-years', picks: 'compare-plans', pair: 'compare-pair', view: 'compare-view' };
    const yearsWord = (y) => `${y} year${y === 1 ? '' : 's'}`;

    let view = PlanPrefs.get(PREFS.view, 'worth');
    if (!VIEWS.some(([v]) => v === view)) view = 'worth';

    /** Months until debt-free, in words. */
    const payoff = (v) => (v === Infinity ? 'Not paid off' : v === 0 ? 'No debt' : D.duration(v));

    // Metrics' rows: their name, how to read them off a run, and which end is
    // best ('max', 'min'; Infinity, debt still owed at the end, never places).
    const MEASURES = [
        { id: 'worth', name: 'Net worth', note: 'At the end', best: 'max', show: (v) => money(v), signed: true },
        { id: 'owed', name: 'Owed', note: 'At the end', best: 'min', show: (v) => money(v) },
        { id: 'payoff', name: 'Debt payoff', note: 'Until debt-free', best: 'min', show: payoff },
        { id: 'expenses', name: 'Expenses', note: 'Over the whole run', best: 'min', show: (v) => money(v) },
        { id: 'interest', name: 'Interest paid', note: 'Over the whole run', best: 'min', show: (v) => money(v) },
        { id: 'growth', name: 'Growth', note: 'Interest and rewards', best: 'max', show: (v) => money(v) },
        { id: 'taxes', name: 'Taxes paid', note: 'Over the whole run', best: 'min', show: (v) => money(v) },
        { id: 'goalsMet', name: 'Goals met on time', goals: true, best: 'max', show: (v, f) => `${v} of ${f.goalCount}` },
    ];

    root.innerHTML = `
        <div class="ws-page scroll-y">
            <section class="ant-card compare-pick" aria-label="Plans to compare">
                <div class="compare-pick-body">${SLOTS.map((s, i) => `
                    <div class="compare-slot" style="--slot: var(${colorOf(i)})">
                        ${K.planPick({ act: `pick-${i}`, label: SLOT_NAMES[i] })}
                    </div>`).join('')}
                </div>
            </section>
            <section class="ant-card compare-card" aria-label="Plans compared">
                <div class="outlook-bar">
                    ${K.tabs(VIEWS, view, { label: 'Compare view' })}
                    <div class="outlook-tools compare-over">
                        <span class="page-label" aria-hidden="true">Over</span>
                        ${K.segmented(LENGTHS.map((y) => [y, `${y}Y`]), null, { attr: 'years', label: 'Length every plan runs over', chips: true })}
                    </div>
                </div>
                <div class="compare-pane" data-pane="worth" role="tabpanel" aria-label="Net worth">
                    <div class="chart-pane">
                        <div class="chart-legend compare-legend"></div>
                        <div class="chart-box compare-chart"></div>
                    </div>
                    <div class="compare-none" hidden></div>
                </div>
                <div class="compare-pane ant-table-wrapper" data-pane="metrics" role="tabpanel" aria-label="Metrics"></div>
                <div class="compare-pane ant-table-wrapper" data-pane="goals" role="tabpanel" aria-label="Goals"></div>
            </section>
        </div>`;

    const pickBtns = SLOTS.map((_, i) => root.querySelector(`[data-act="pick-${i}"]`));
    const panes = root.querySelectorAll('[data-pane]');
    const legendEl = root.querySelector('.compare-legend');
    const chartBox = root.querySelector('.compare-chart');
    const chartPane = root.querySelector('.chart-pane');
    const noneEl = root.querySelector('.compare-none');
    const metricsEl = root.querySelector('[data-pane="metrics"]');
    const goalsEl = root.querySelector('[data-pane="goals"]');
    const overEl = root.querySelector('.compare-over');
    const showing = () => PlanStore.state.workspace === 'compare';

    /** The length every plan is run over. */
    function years() {
        const y = Number(PlanPrefs.get(PREFS.years, 30));
        return LENGTHS.includes(y) ? y : 30;
    }

    /** The four picks, as plan ids or null: those kept in PlanPrefs where they
     *  still exist (an older two-plan pair is read too), else the first four
     *  plans in the navigation. The first is a plan whenever there is one. */
    function picks() {
        const { tabs } = PlanStore.state;
        const read = (key) => { try { return JSON.parse(PlanPrefs.get(key, 'null')); } catch { return null; } };
        let saved = read(PREFS.picks);
        if (!Array.isArray(saved)) saved = read(PREFS.pair);
        if (!Array.isArray(saved)) saved = tabs.slice(0, SLOTS.length);
        const seen = new Set();
        const out = SLOTS.map((_, i) => {
            const id = saved[i];
            if (!tabs.includes(id) || seen.has(id)) return null;
            seen.add(id);
            return id;
        });
        if (!out[0] && tabs.length) {
            // The first pick is never None: an unpicked plan, else the first picked.
            const free = tabs.find((id) => !seen.has(id));
            if (free) out[0] = free;
            else { const j = out.findIndex(Boolean); out[0] = out[j]; out[j] = null; }
        }
        return out;
    }
    const setPicks = (ids) => PlanPrefs.set(PREFS.picks, JSON.stringify(ids));

    // ── Figures ────────────────────────────────────────────────────────────

    /** Months until no debt is owed for the rest of the run: 0 when none ever
     *  is, Infinity when some still is at the end. */
    function debtFree(res) {
        const n = res.months;
        const debts = Object.values(res.nodes).filter((r) => r.role === 'debt');
        for (let k = n; k >= 0; k--) {
            let owed = 0;
            for (const r of debts) owed += r.balance[k];
            if (owed > 0.005) return k === n ? Infinity : k + 1;
        }
        return 0;
    }

    /** One plan's figures over its run, in the money shown, or null when the
     *  run failed. */
    function figures(plan, res) {
        if (!res) return null;
        const n = res.months;
        const def = G.deflator(plan, n);
        const F = res.flows;
        const sum = (fn) => { let s = 0; for (let m = 0; m < n; m++) s += fn(m) * def[m + 1]; return s; };
        let owed = 0;
        for (const r of Object.values(res.nodes)) {
            if (r.role === 'debt') owed += r.balance[n];
        }
        // Goals are judged over the goal horizon, not the length compared.
        const goals = PlanStore.state.goals;
        const goalRes = goals.length ? Runs.forGoals(plan) : null;
        const evs = goalRes ? G.evaluate(plan, goalRes, goals) : [];
        return {
            worth: res.netWorth[n] * def[n],
            worthSeries: Float64Array.from(res.netWorth, (v, k) => v * def[k]),
            owed: owed * def[n],
            payoff: debtFree(res),
            // What expenses and budget groups spent: the Sankey's Spending,
            // without taxes or a card's fees.
            expenses: sum((m) => F.spent[m]),
            interest: sum((m) => F.interest[m]),
            growth: sum((m) => F.growth[m] + F.cashback[m]),
            // Card annual fees (the only other cut, `skimmed`) are fees, not taxes.
            taxes: sum((m) => F.withheld[m]),
            evs: goalRes ? evs : null,
            goalsMet: evs.filter((e) => e.status === 'met').length,
            goalCount: goals.length,
        };
    }

    /** The picked plans that ran, in pick order, each with its slot. */
    function picked(rows) {
        return picks().map((id, slot) => {
            const r = id && rows.find((x) => x.plan.id === id);
            return r && r.f ? { ...r, slot } : null;
        }).filter(Boolean);
    }


    // ── Net worth ──────────────────────────────────────────────────────────

    /** Ticks along a run of `y` years counted from each plan's own start
     *  (the plans may start in different months): Start, 1y, 2y…, thinned
     *  to at most ~8 labels. */
    function runTicks(y) {
        const step = Math.ceil((y + 1) / 8);
        const ticks = [];
        for (let j = 0; j <= y; j += step) ticks.push({ i: j * 12, label: j ? `${j}y` : 'Start' });
        return ticks;
    }

    function renderWorth(chosen, y) {
        chartPane.hidden = !chosen.length;
        noneEl.hidden = !!chosen.length;
        if (!chosen.length) {
            noneEl.innerHTML = K.empty({ icon: 'files', title: 'No plans to compare' });
            return;
        }
        if (view !== 'worth') return;
        const count = y * 12 + 1;
        const two = chosen.length === 2;
        legendEl.innerHTML = chosen.map((p) =>
            `<span class="chart-legend-item"><i class="is-line" style="--swatch: var(${colorOf(p.slot)})"></i>${esc(p.plan.name)}</span>`).join('');
        PlanChart.draw(chartBox, {
            kind: 'area',
            label: `Net worth of ${chosen.map((p) => p.plan.name).join(', ')} over ${yearsWord(y)}`,
            count,
            xTicks: runTicks(y),
            bands: [],
            lines: chosen.map((p) => ({ label: p.plan.name, color: colorOf(p.slot), values: p.f.worthSeries })),
            between: two,
            format: (v) => money(v, { compact: true }),
            tooltip: (k) => ({
                title: k === 0 ? 'At the start' : `${D.duration(k)} in`,
                rows: [
                    ...chosen.map((p) => ({ label: p.plan.name, color: colorOf(p.slot), value: money(p.f.worthSeries[k]) })),
                    ...(two ? [{ label: 'Difference', color: '--chart-grid', value: money(chosen[0].f.worthSeries[k] - chosen[1].f.worthSeries[k], { sign: true }), total: true }] : []),
                ],
            }),
        });
    }

    // ── Metrics ────────────────────────────────────────────────────────────

    function renderMetrics(chosen, y) {
        if (!chosen.length) { metricsEl.innerHTML = K.empty({ icon: 'files', title: 'No plans to compare' }); return; }
        const rows = MEASURES.filter((m) => !m.goals || chosen[0].f.goalCount);
        /** A figure's podium place in its row (0 = best), or -1 off the podium
         *  or last. Figures within half a unit tie and share a place. */
        const placer = (m) => {
            const vals = chosen.map((p) => p.f[m.id]).filter(Number.isFinite)
                .sort((a, b) => (m.best === 'max' ? b - a : a - b));
            const distinct = vals.filter((v, i) => i === 0 || Math.abs(v - vals[i - 1]) >= 0.5);
            return (v) => {
                if (distinct.length < 2) return -1;
                const i = distinct.findIndex((d) => Math.abs(v - d) < 0.5);
                return i >= 0 && i < HEAT.length && i < distinct.length - 1 ? i : -1;
            };
        };
        const cell = (m, place, p) => {
            const v = p.f[m.id];
            const at = place(v);
            const cls = ['is-num', at >= 0 ? 'is-heat' : '', m.signed && v < -0.5 ? 'is-negative' : ''].filter(Boolean).join(' ');
            const badge = at >= 0 ? K.tag(PLACES[at], { tone: at === 0 ? 'success' : '', icon: 'trophy' }) : '';
            const medal = at > 0 ? ` data-medal="${MEDALS[at]}"` : '';
            return `<td class="${cls}"${at >= 0 ? ` style="--heat: ${HEAT[at]}"` : ''}><span class="compare-cell"${medal}>${badge}<span class="compare-value">${esc(m.show(v, p.f))}</span></span></td>`;
        };
        // Each plan's first and last months, as the plan builder's scrubber names them.
        const head = (p) => `<th scope="col" class="is-num"><span class="compare-col">
            <button class="ant-btn ant-btn-link compare-plan" type="button" data-open="${esc(p.plan.id)}" title="Analyze ${esc(p.plan.name)}">${esc(p.plan.name)}</button>
            <span class="compare-col-note">${esc(`${D.monthLabel(p.plan, 0)} to ${D.monthLabel(p.plan, y * 12 - 1)}`)}</span></span></th>`;
        metricsEl.innerHTML = `<table class="ant-table plan-table compare-table">
            <caption class="ant-visually-hidden">${esc(chosen.map((p) => p.plan.name).join(', '))} compared over ${esc(yearsWord(y))}</caption>
            <thead><tr><th scope="col" class="is-sticky">Measure</th>${chosen.map(head).join('')}</tr></thead>
            <tbody>${rows.map((m) => {
                const place = placer(m);
                return `<tr><th scope="row" class="is-sticky"><span class="compare-measure">${esc(m.name)}${m.note ? `<span class="compare-col-note">${esc(m.note)}</span>` : ''}</span></th>
                    ${chosen.map((p) => cell(m, place, p)).join('')}</tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    // ── Goals ──────────────────────────────────────────────────────────────

    /** A goal's status in a few words for a table cell; the full words are
     *  its title. As the goal board's matrix shows it (goals-board.js). */
    function shortStatus(ev, plan) {
        const full = D.goalStatus(ev, plan);
        const title = full.detail ? `${full.text} · ${full.detail}` : full.text;
        if (ev.status === 'blocked') return { text: 'Cannot measure', tone: '', icon: 'minus-circle', title };
        if (ev.status === 'met') return { text: ev.month === 0 ? 'Already' : D.monthLabel(plan, ev.month), tone: 'success', icon: 'check-circle', title };
        if (ev.status === 'late') return { text: `${D.monthLabel(plan, ev.month)} · late`, tone: 'warning', icon: 'clock', title };
        return { text: 'Never met', tone: 'error', icon: 'x-circle', title };
    }

    function renderGoals(chosen) {
        const goals = PlanStore.state.goals;
        if (!goals.length) {
            goalsEl.innerHTML = K.empty({ icon: 'target', title: 'No goals yet',
                text: 'Add goals to see when each plan meets them.', action: { act: 'goals', label: 'Open Goals', icon: 'target' } });
            return;
        }
        if (!chosen.length) { goalsEl.innerHTML = K.empty({ icon: 'files', title: 'No plans to compare' }); return; }
        const cell = (p, i) => {
            const ev = p.f.evs && p.f.evs[i];
            if (!ev) return '<td class="is-muted">—</td>';
            const s = shortStatus(ev, p.plan);
            return `<td>${K.tag(s.text, { tone: s.tone, icon: s.icon, title: s.title })}</td>`;
        };
        goalsEl.innerHTML = `<table class="ant-table plan-table ant-table-middle compare-goals">
            <caption class="ant-visually-hidden">When each plan meets each goal</caption>
            <thead><tr><th scope="col" class="is-sticky">Goal</th>${chosen.map((p) => `<th scope="col">${esc(p.plan.name)}</th>`).join('')}</tr></thead>
            <tbody>${goals.map((g, i) => `<tr>
                <th scope="row" class="is-sticky">${esc(g.name || 'Goal')}</th>
                ${chosen.map((p) => cell(p, i)).join('')}</tr>`).join('')}</tbody>
        </table>`;
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function renderPicks() {
        const ids = picks();
        const many = PlanStore.state.tabs.length > 1;
        ids.forEach((id, i) => {
            const btn = pickBtns[i];
            const name = id ? PlanStore.planName(id) : '';
            const nameEl = btn.querySelector('.plan-pick-name');
            nameEl.textContent = name || 'None';
            nameEl.classList.toggle('is-placeholder', !id);
            btn.disabled = i > 0 && !many;
            btn.setAttribute('aria-label', `${SLOT_NAMES[i]}: ${name || 'None'}`);
        });
    }

    function renderTabs() {
        root.querySelectorAll('[data-tab]').forEach((b) => {
            const on = b.dataset.tab === view;
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
        });
        panes.forEach((p) => { p.hidden = p.dataset.pane !== view; });
        // Goals are judged over the goal horizon, so the length is no use
        // there; its chips keep their room, so the bar keeps its height.
        overEl.classList.toggle('is-off', view === 'goals');
    }

    function render() {
        if (!showing()) return;
        const y = years();
        root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.years) === y)));
        renderTabs();
        renderPicks();
        const rows = Runs.all({ years: y }).map(({ plan, results }) => ({ plan, results, f: figures(plan, results) }));
        const chosen = picked(rows);
        renderWorth(chosen, y);
        renderMetrics(chosen, y);
        renderGoals(chosen);
    }

    function showView(v) {
        if (v === view) return;
        view = v;
        PlanPrefs.set(PREFS.view, v);
        render();
    }

    /** The plans' menu for one pick; picking a plan another pick shows swaps
     *  the two, and every pick but the first may be None. */
    function pickMenu(btn, slot) {
        const ids = picks();
        const now = ids[slot];
        const choose = (id) => {
            const next = [...ids];
            const j = id ? next.indexOf(id) : -1;
            if (j >= 0) next[j] = now;
            next[slot] = id;
            setPicks(next);
            render();
        };
        const items = PlanStore.state.tabs.map((id) => ({
            label: PlanStore.planName(id), iconHtml: planIcon(id === now ? 'check' : 'file'), selected: id === now,
            onClick: () => choose(id),
        }));
        if (slot > 0) items.push({ type: 'divider' }, { label: 'None', iconHtml: planIcon(now ? 'minus' : 'check'), selected: !now, onClick: () => choose(null) });
        Ant.dropdown(btn, { items });
    }

    root.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) { showView(tab.dataset.tab); return; }
        const open = e.target.closest('[data-open]');
        if (open) {
            PlanStore.setWorkspace('analyze');
            PlanStore.openPlan(open.dataset.open);
            return;
        }
        const y = e.target.closest('[data-years]');
        if (y) { PlanPrefs.set(PREFS.years, y.dataset.years); render(); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'goals') { PlanStore.setWorkspace('goals'); return; }
        const m = /^pick-(\d)$/.exec(act.dataset.act);
        if (m) pickMenu(act, Number(m[1]));
    });

    // Arrow keys move along the tabs, as Ant's Tabs do.
    root.querySelector('.plan-tabs-nav').addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = VIEWS.findIndex(([v]) => v === view);
        const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length][0];
        showView(next);
        root.querySelector(`[data-tab="${next}"]`).focus();
    });

    // Redraw the chart when its box changes size (as Net worth's tab opens,
    // too), coalesced to one per frame.
    let resizeQueued = false;
    new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => { resizeQueued = false; render(); });
    }).observe(chartBox);

    PlanStore.on((c) => {
        if (c.type === 'workspace' || c.type === 'tabs' || c.type === 'results' || c.type === 'goals') render();
    });
    window.addEventListener('currencychange', render);
}());
