'use strict';

// ─── goals-board.js ─────────────────────────────────────────────────────────
// The Goals workspace, as an Ant Design page: the goals every plan is measured
// against (one list, shared by all plans) and how a plan does on each.
//
//   header        the plan the goals are measured in (a dropdown of every
//                 plan; picking one opens it) and Add goal
//   figures       how many goals that plan meets on time, late, never, or
//                 cannot measure
//   the list      each goal: its rule as a sentence, how close the plan comes
//                 to it (PlanGoals' progress), and its status. Edit opens
//                 the goal editor; Delete removes it, and the toast's Undo (or
//                 Ctrl+Z) brings it back. Its handle drags it to a new place
//                 in the list (or, focused, the arrow keys move it); the
//                 order is the list's everywhere, the table below included.
//   across plans  every goal against every plan, one status each
//
// Every status here is read off a run over the goal horizon (Runs.forGoals),
// not the length on show elsewhere: a goal asks whether the plan ever meets
// it, so the length chips in Analyze and Compare never change it.
//
// A goal is one rule (plan.js has its shape), written in the goal editor, a
// modal form: its name, measure, comparison, target (an amount, a multiple of
// another measure, or a share of one), deadline (a date or an age) and
// colour. The editor reads the rule back as a sentence while it is written.
// Saving is one undoable step.
//
// Analyze's Net worth chart flags the month a plan meets each goal, in the
// goal's colour.

(function () {
    const P = window.PlanModel;
    const D = window.Describe;
    const G = window.PlanGoals;
    const K = window.Components;
    const root = document.getElementById('goals-board');
    if (!root) return;

    const esc = escapeHtml;
    // The kinds of target, and the figure each starts at when picked.
    const UNITS = [['amount', 'Amount'], ['times', 'Times'], ['percent', 'Percent']];
    const UNIT_START = { amount: 100000, times: 25, percent: 40 };
    const VALUE_LABEL = { amount: 'Amount', times: 'Multiple', percent: 'Share' };
    const DUES = [['date', 'By a date', 'calendar-blank'], ['age', 'By an age', 'user']];
    // How each status tone (describe.js, goalStatus) is tagged.
    const STATUS_TAG = {
        positive: { tone: 'success', icon: 'check-circle' },
        warning: { tone: 'warning', icon: 'clock' },
        negative: { tone: 'error', icon: 'x-circle' },
        muted: { tone: '', icon: 'minus-circle' },
    };
    // How each status reads as progress: Ant's Progress statuses.
    const PROGRESS_STATUS = { met: 'success', late: 'warning', unmet: 'exception' };

    root.innerHTML = `
        <div class="ws-page scroll-y">
            ${K.pageHead({
                start: K.planPick({ act: 'plan', label: 'Plan the goals are measured in' }),
                extra: `<button class="ant-btn ant-btn-primary" type="button" data-act="add">${planIcon('plus')}<span>Add goal</span></button>`,
            })}
            <div class="plan-stat-cards" data-stats></div>
            <section class="ant-card" aria-label="Your goals">
                <div class="ant-card-body goals-body">
                    <p class="ant-visually-hidden" id="goal-handle-hint">Use the up and down arrow keys to move the goal.</p>
                    <ul class="list goals-list"></ul>
                    <div data-empty hidden>${K.empty({
                        icon: 'target',
                        title: 'No goals yet',
                        text: 'A goal is a rule every plan is measured against, such as net worth reaching 25 times a year of expenses by age 65.',
                        action: { act: 'add', label: 'Add goal', icon: 'plus' },
                    })}</div>
                </div>
            </section>
            <section class="ant-card" data-matrix-card aria-labelledby="goals-matrix-title">
                <div class="ant-card-head"><div class="ant-card-head-wrapper">
                    <h2 class="ant-card-head-title" id="goals-matrix-title">Across plans</h2>
                </div></div>
                <div class="ant-card-body plan-card-flush"><div class="ant-table-wrapper" data-matrix></div></div>
            </section>
        </div>`;

    const statsEl = root.querySelector('[data-stats]');
    const list = root.querySelector('.goals-list');
    const emptyEl = root.querySelector('[data-empty]');
    const matrixCard = root.querySelector('[data-matrix-card]');
    const matrixEl = root.querySelector('[data-matrix]');
    const planName = root.querySelector('.plan-pick-name');
    const showing = () => PlanStore.state.workspace === 'goals';
    let fresh = null;   // a goal just saved, to flash once it is drawn

    // ── Measuring ──────────────────────────────────────────────────────────

    /** The open plan's run over the goal horizon, or null when it failed. */
    function openRun() {
        const { plan } = PlanStore.state;
        const results = plan ? Runs.forGoals(plan) : null;
        return results ? { plan, results } : null;
    }

    /** A status in a few words for a narrow table cell; the full words are its title. */
    function shortStatus(ev, plan) {
        const full = D.goalStatus(ev, plan);
        const title = full.detail ? `${full.text} · ${full.detail}` : full.text;
        if (ev.status === 'blocked') return { text: 'Cannot measure', tone: '', icon: 'minus-circle', title };
        if (ev.status === 'met') return { text: ev.month === 0 ? 'Already' : D.monthLabel(plan, ev.month), tone: 'success', icon: 'check-circle', title };
        if (ev.status === 'late') return { text: `${D.monthLabel(plan, ev.month)} · late`, tone: 'warning', icon: 'clock', title };
        return { text: 'Never met', tone: 'error', icon: 'x-circle', title };
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function renderStats(evs) {
        const n = evs.length;
        statsEl.hidden = !n || evs.some((e) => !e);
        if (statsEl.hidden) return;
        const count = (status) => evs.filter((e) => e.status === status).length;
        const met = count('met');
        const late = count('late');
        const never = count('unmet');
        const blocked = count('blocked');
        const of = `of ${n}`;
        statsEl.innerHTML = [
            K.statCard({ title: 'Met on time', value: String(met), suffix: of, icon: 'check-circle', tone: met ? 'up' : 'muted' }),
            K.statCard({ title: 'Met late', value: String(late), suffix: of, icon: 'clock', tone: late ? 'warn' : 'muted' }),
            K.statCard({ title: 'Never met', value: String(never), suffix: of, icon: 'x-circle', tone: never ? 'down' : 'muted' }),
            blocked ? K.statCard({ title: 'Cannot be measured', value: String(blocked), suffix: of, icon: 'minus-circle', tone: 'muted' }) : '',
        ].join('');
    }

    /** One goal in the list: its handle (with more than one goal), its colour
     *  and measure, its name and rule, its progress, its status, and its
     *  actions. `i` of `count` is its place in the list. */
    function row(g, ev, run, i, count) {
        const name = g.name || 'Goal';
        const handle = count > 1
            ? `<button class="goal-handle" type="button" data-handle
                aria-label="Reorder ${esc(name)}, ${i + 1} of ${count}" aria-describedby="goal-handle-hint"
                title="Drag to reorder">${planIcon('dots-six-vertical')}</button>`
            : '';
        let progress = '';
        let status = '';
        if (ev && run) {
            const st = D.goalStatus(ev, run.plan);
            const look = STATUS_TAG[st.tone];
            status = K.tag(st.detail ? `${st.text} · ${st.detail}` : st.text, { tone: look.tone, icon: look.icon });
            if (ev.progress == null) {
                progress = `<span class="goal-progress-note">${esc(st.text)}</span>`;
            } else {
                const caption = ev.status === 'met' ? 'Met in time'
                    : ev.status === 'late' ? 'Met, after the deadline'
                    : `Closest, ${D.monthLabel(run.plan, ev.progressAt)}`;
                progress = `${K.progress(ev.progress, { status: PROGRESS_STATUS[ev.status], label: `${name}: progress, ${caption}` })}
                    <span class="goal-progress-note">${esc(caption)}</span>`;
            }
        }
        return `<li class="list-item goal-row${fresh === g.id ? ' is-new' : ''}" data-goal="${esc(g.id)}">
            <div class="list-item-meta">
                ${handle}
                <span class="goal-avatar" data-color="${esc(g.color)}" aria-hidden="true">${planIcon(D.GOAL_METRICS[g.metric].icon)}</span>
                <div class="goal-text">
                    <p class="list-item-title">${esc(name)}</p>
                    <p class="list-item-desc">${esc(D.goalSentence(g))}</p>
                </div>
            </div>
            <div class="goal-progress">${progress}</div>
            <div class="goal-status">${status}</div>
            <div class="list-item-actions">
                <button class="ant-btn ant-btn-text ant-btn-icon-only" type="button" data-act="edit" aria-label="Edit ${esc(name)}" title="Edit goal">${planIcon('pencil-simple')}</button>
                <button class="ant-btn ant-btn-text ant-btn-icon-only" type="button" data-act="delete" aria-label="Delete ${esc(name)}" title="Delete goal">${planIcon('trash')}</button>
            </div>
        </li>`;
    }

    /** Every goal against every plan, each plan over its own length. */
    function renderMatrix(goals) {
        if (!goals.length) { matrixEl.innerHTML = ''; return; }
        const cols = Runs.allForGoals().map(({ plan, results }) => ({
            plan, evs: results ? G.evaluate(plan, results, goals) : null,
        }));
        const cell = (c, i) => {
            if (!c.evs) return '<td class="is-muted">—</td>';
            const s = shortStatus(c.evs[i], c.plan);
            return `<td>${K.tag(s.text, { tone: s.tone, icon: s.icon, title: s.title })}</td>`;
        };
        matrixEl.innerHTML = `<table class="ant-table plan-table ant-table-middle">
            <caption class="ant-visually-hidden">When each plan meets each goal</caption>
            <thead><tr><th scope="col" class="is-sticky">Goal</th>${cols.map((c) => `<th scope="col">${esc(c.plan.name)}</th>`).join('')}</tr></thead>
            <tbody>${goals.map((g, i) => `<tr>
                <th scope="row" class="is-sticky"><span class="goal-cell-name"><span class="goal-dot" data-color="${esc(g.color)}"></span>${esc(g.name || 'Goal')}</span></th>
                ${cols.map((c) => cell(c, i)).join('')}</tr>`).join('')}</tbody>
        </table>`;
    }

    function render() {
        if (!showing()) return;
        const goals = PlanStore.state.goals;
        const run = openRun();
        planName.textContent = PlanStore.state.plan ? PlanStore.state.plan.name : '';
        emptyEl.hidden = goals.length > 0;
        list.hidden = !goals.length;
        matrixCard.hidden = !goals.length;
        const evs = run ? G.evaluate(run.plan, run.results, goals) : goals.map(() => null);
        renderStats(evs);
        list.innerHTML = goals.map((g, i) => row(g, evs[i], run, i, goals.length)).join('');
        renderMatrix(goals);
        if (fresh) {
            const el = list.querySelector(`[data-goal="${CSS.escape(fresh)}"]`);
            if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            fresh = null;
        }
    }

    // ── The goal editor ────────────────────────────────────────────────────

    /** A target figure as its field shows it. */
    const figureText = (v) => Fmt.number(v, 2);

    /** Open the editor for goal `id`, or for a new goal when `id` is null. */
    function openEditor(id) {
        const existing = id ? PlanStore.goal(id) : null;
        if (id && !existing) return;
        if (!existing && PlanStore.state.goals.length >= P.LIMITS.goals) {
            PlanStore.limitReached('goals', P.LIMITS.goals);
            return;
        }
        // The rule being written: a copy, so Cancel leaves the goal as it was.
        const draft = existing ? { ...existing } : P.createGoal({ name: '', color: PlanStore.nextGoalColor() });
        const metrics = Object.entries(D.GOAL_METRICS);
        const sym = Fmt.symbolParts();

        const { dialog, close } = Ant.modal({
            title: existing ? 'Edit goal' : 'Add goal',
            className: 'goal-editor',
            width: 560,
            body: `<form class="goal-editor-form" id="goal-editor-form" novalidate>
                    <p class="sentence goal-preview" aria-live="polite"></p>
                    <div class="form-item">
                        <label class="form-label" for="goal-name">Name</label>
                        <input class="field-input" id="goal-name" type="text" maxlength="${P.LIMITS.name}" autocomplete="off" spellcheck="false" placeholder="First million">
                        <p class="form-explain" data-error="name" hidden>Name the goal so you can find it again.</p>
                    </div>
                    <div class="form-row">
                        <div class="form-item">
                            <label class="form-label" for="goal-metric">Measure</label>
                            <select class="field-select" id="goal-metric">${metrics.map(([m, d]) => `<option value="${m}">${esc(d.label)}</option>`).join('')}</select>
                        </div>
                        <div class="form-item">
                            <label class="form-label" for="goal-op">Rule</label>
                            <select class="field-select" id="goal-op">${Object.entries(D.GOAL_OPS).map(([op, d]) =>
                                `<option value="${op}">${esc(d.words.charAt(0).toUpperCase() + d.words.slice(1))}</option>`).join('')}</select>
                        </div>
                    </div>
                    <div class="form-item">
                        <span class="form-label" id="goal-unit-label">Target is</span>
                        ${K.segmented(UNITS, draft.unit, { attr: 'unit', label: 'Kind of target', block: true })}
                    </div>
                    <div class="form-row">
                        <div class="form-item">
                            <label class="form-label" for="goal-value" data-value-label></label>
                            <span class="field-affix" data-value-field></span>
                            <p class="form-explain" data-error="value" hidden></p>
                        </div>
                        <div class="form-item" data-of>
                            <label class="form-label" for="goal-of">Of</label>
                            <select class="field-select" id="goal-of"></select>
                        </div>
                    </div>
                    <div class="form-item">
                        <span class="form-label">Deadline</span>
                        ${K.segmented(DUES, draft.due, { attr: 'due', label: 'Kind of deadline', block: true })}
                    </div>
                    <div class="form-item" data-by>
                        <label class="form-label" for="goal-by">Month</label>
                        <button class="field-input field-month" id="goal-by" type="button" data-month aria-haspopup="dialog"><span></span>${planIcon('calendar-blank')}</button>
                    </div>
                    <div class="form-item" data-age>
                        <label class="form-label" for="goal-age">Age</label>
                        <span class="field-affix"><input class="field-input" id="goal-age" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"><span class="field-affix-text">yrs</span></span>
                        <p class="form-hint">The month each plan reaches this age, from the age set in its plan details.</p>
                        <p class="form-explain" data-error="age" hidden>Enter an age from ${P.GOAL_AGE.min} to ${P.GOAL_AGE.max}.</p>
                    </div>
                    <div class="form-item">
                        <span class="form-label" id="goal-color-label">Colour</span>
                        <div class="swatches" role="radiogroup" aria-labelledby="goal-color-label">${P.GOAL_COLORS.map((c) => `
                            <button class="swatch" type="button" role="radio" data-color="${c}" aria-checked="${draft.color === c}"
                                aria-label="${esc(D.GOAL_COLORS[c])}" title="${esc(D.GOAL_COLORS[c])}">${planIcon('check')}</button>`).join('')}</div>
                    </div>
                </form>`,
            footer: `<button class="ant-btn ant-btn-default" type="button" data-cancel>Cancel</button>
                <button class="ant-btn ant-btn-primary" type="submit" form="goal-editor-form">${existing ? 'Save goal' : 'Add goal'}</button>`,
        });
        dialog.querySelector('[data-cancel]').addEventListener('click', close);
        const form = dialog.querySelector('form');
        const $ = (sel) => form.querySelector(sel);
        const nameInput = $('#goal-name');
        const metricSelect = $('#goal-metric');
        const opSelect = $('#goal-op');
        const ofSelect = $('#goal-of');
        const monthBtn = $('#goal-by');
        const ageInput = $('#goal-age');
        const preview = $('.goal-preview');
        let valueInput = null;

        const showError = (key, message) => {
            const el = $(`[data-error="${key}"]`);
            if (message) el.textContent = message;
            el.hidden = !message;
            const field = { name: nameInput, value: valueInput, age: ageInput }[key];
            if (field) {
                if (message) field.setAttribute('aria-invalid', 'true');
                else field.removeAttribute('aria-invalid');
            }
        };

        /** The figure field, with its unit beside it: the currency symbol by
         *  an amount (before or after, as the currency is set), '×' or '%' after. */
        function drawValueField() {
            const affix = { amount: sym.symbol, times: '×', percent: '%' }[draft.unit];
            const before = draft.unit === 'amount' && !sym.suffix;
            const input = `<input class="field-input" id="goal-value" type="text" inputmode="decimal" autocomplete="off" spellcheck="false">`;
            const text = `<span class="field-affix-text">${esc(affix)}</span>`;
            $('[data-value-field]').innerHTML = before ? text + input : input + text;
            $('[data-value-label]').textContent = VALUE_LABEL[draft.unit];
            valueInput = $('#goal-value');
            valueInput.value = figureText(draft.value);
            showError('value', '');
        }

        /** The "of" measures on offer: any but the rule's own. */
        function drawOf() {
            if (draft.of === draft.metric) draft.of = draft.metric === 'expenses' ? 'income' : 'expenses';
            ofSelect.innerHTML = metrics.filter(([m]) => m !== draft.metric)
                .map(([m, d]) => `<option value="${m}">${esc(d.of)}</option>`).join('');
            ofSelect.value = draft.of;
        }

        /** Show the parts the rule has now, and read it back as a sentence. */
        function sync() {
            $('[data-of]').hidden = draft.unit === 'amount';
            $('[data-by]').hidden = draft.due !== 'date';
            $('[data-age]').hidden = draft.due !== 'age';
            for (const b of form.querySelectorAll('[data-unit]')) b.setAttribute('aria-pressed', String(b.dataset.unit === draft.unit));
            for (const b of form.querySelectorAll('[data-due]')) b.setAttribute('aria-pressed', String(b.dataset.due === draft.due));
            for (const b of form.querySelectorAll('[data-color]')) b.setAttribute('aria-checked', String(b.dataset.color === draft.color));
            monthBtn.firstElementChild.textContent = draft.by ? P.ymLabel(draft.by) : 'Pick a month';
            monthBtn.classList.toggle('is-empty', !draft.by);
            preview.textContent = D.goalSentence(draft);
        }

        nameInput.value = draft.name;
        metricSelect.value = draft.metric;
        opSelect.value = draft.op;
        ageInput.value = draft.age == null ? '65' : figureText(draft.age);
        drawValueField();
        drawOf();
        sync();

        // A figure as it is typed: kept when it reads, flagged when it does not.
        form.addEventListener('input', (e) => {
            if (e.target === nameInput) { showError('name', ''); return; }
            if (e.target === valueInput) {
                const v = Fmt.parseNumber(valueInput.value);
                const max = P.GOAL_VALUE[draft.unit];
                if (Number.isFinite(v) && v >= 0 && v <= max) { draft.value = v; showError('value', ''); sync(); }
                return;
            }
            if (e.target === ageInput) {
                const v = Fmt.parseNumber(ageInput.value);
                if (Number.isFinite(v) && v >= P.GOAL_AGE.min && v <= P.GOAL_AGE.max) { draft.age = v; showError('age', ''); sync(); }
            }
        });
        form.addEventListener('change', (e) => {
            if (e.target === metricSelect) { draft.metric = metricSelect.value; drawOf(); }
            else if (e.target === opSelect) draft.op = opSelect.value;
            else if (e.target === ofSelect) draft.of = ofSelect.value;
            else return;
            sync();
        });
        form.addEventListener('click', (e) => {
            const unit = e.target.closest('[data-unit]');
            if (unit && unit.dataset.unit !== draft.unit) {
                draft.unit = unit.dataset.unit;
                draft.value = UNIT_START[draft.unit];
                drawValueField();
                sync();
                return;
            }
            const due = e.target.closest('[data-due]');
            if (due) {
                draft.due = due.dataset.due;
                if (draft.due === 'age' && draft.age == null) draft.age = Fmt.parseNumber(ageInput.value) || 65;
                if (draft.due === 'date' && !draft.by) draft.by = P.ymAdd(P.ymNow(), 120);
                sync();
                return;
            }
            const swatch = e.target.closest('[data-color]');
            if (swatch) { draft.color = swatch.dataset.color; sync(); return; }
            if (e.target.closest('[data-month]')) {
                Ant.monthPicker(monthBtn, {
                    value: draft.by,
                    defaultPickerValue: draft.by || P.ymAdd(P.ymNow(), 120),
                    onPick: (v) => { if (v) { draft.by = v; sync(); } },
                });
            }
        });
        // Arrow keys move along the colours, as a radio group does.
        form.querySelector('.swatches').addEventListener('keydown', (e) => {
            const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!move) return;
            e.preventDefault();
            const i = P.GOAL_COLORS.indexOf(draft.color);
            draft.color = P.GOAL_COLORS[(i + move + P.GOAL_COLORS.length) % P.GOAL_COLORS.length];
            sync();
            form.querySelector(`[data-color="${draft.color}"]`).focus();
        });

        /** Check every field; true when the rule can be saved. */
        function valid() {
            let ok = true;
            if (!nameInput.value.trim()) { showError('name', 'Name the goal so you can find it again.'); ok = false; }
            const v = Fmt.parseNumber(valueInput.value);
            const max = P.GOAL_VALUE[draft.unit];
            if (!Number.isFinite(v) || v < 0 || v > max) {
                showError('value', `Enter a number from 0 to ${Fmt.number(max)}.`);
                ok = false;
            }
            if (draft.due === 'age') {
                const age = Fmt.parseNumber(ageInput.value);
                if (!Number.isFinite(age) || age < P.GOAL_AGE.min || age > P.GOAL_AGE.max) { showError('age', `Enter an age from ${P.GOAL_AGE.min} to ${P.GOAL_AGE.max}.`); ok = false; }
            }
            if (!ok) form.querySelector('[aria-invalid="true"]')?.focus();
            return ok;
        }

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!valid()) return;
            const fields = {
                name: nameInput.value.trim().slice(0, P.LIMITS.name),
                metric: draft.metric, op: draft.op, unit: draft.unit, value: draft.value, of: draft.of,
                due: draft.due, by: draft.due === 'date' ? draft.by : existing?.by ?? null,
                age: draft.due === 'age' ? draft.age : existing?.age ?? null,
                color: draft.color,
            };
            if (existing) {
                PlanStore.editGoals((goals) => {
                    const g = goals.find((x) => x.id === existing.id);
                    if (!g) return false;
                    Object.assign(g, fields);
                    return true;
                });
                fresh = existing.id;
            } else {
                const created = PlanStore.addGoal(fields);
                if (!created) return;
                fresh = created.id;
            }
            close();
            render();
        });

        nameInput.focus();
        nameInput.select();
    }

    function remove(id) {
        const g = PlanStore.goal(id);
        if (!g) return;
        PlanStore.removeGoal(id);
        planNotice(`Deleted ${g.name || 'the goal'}.`, { action: { label: 'Undo', onClick: () => PlanStore.undo() } });
    }

    // ── Input ──────────────────────────────────────────────────────────────

    root.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const goalEl = act.closest('[data-goal]');
        switch (act.dataset.act) {
            case 'add': openEditor(null); break;
            case 'edit': if (goalEl) openEditor(goalEl.dataset.goal); break;
            case 'delete': if (goalEl) remove(goalEl.dataset.goal); break;
            case 'plan': {
                const { tabs, activeId } = PlanStore.state;
                Ant.dropdown(act, {
                    items: tabs.map((id) => ({
                        label: PlanStore.planName(id), iconHtml: planIcon(id === activeId ? 'check' : 'file'), selected: id === activeId,
                        onClick: () => PlanStore.openPlan(id),
                    })),
                });
                break;
            }
        }
    });

    // ── Reordering ─────────────────────────────────────────────────────────
    // A goal's handle drags it up or down the list (one undo step per drop),
    // as the plan list in the navigation does; with the handle focused, the
    // up and down arrows move it one place, Home and End to either end.

    /** Move goal `id` to `to` and keep its handle focused, so the keys can
     *  carry on and a screen reader reads its new place. */
    function moveTo(id, to) {
        if (!PlanStore.moveGoal(id, to)) return;
        list.querySelector(`[data-goal="${CSS.escape(id)}"] [data-handle]`)?.focus();
    }

    let drag = null;

    list.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-handle]');
        if (!handle || e.button !== 0) return;
        e.preventDefault();
        const item = handle.closest('[data-goal]');
        drag = { id: item.dataset.goal, y0: e.clientY, active: false, item, target: null };
        handle.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.active && Math.abs(e.clientY - drag.y0) < 5) return;
        drag.active = true;
        drag.item.classList.add('is-dragging');
        const items = [...list.querySelectorAll('[data-goal]')];
        items.forEach((t) => t.classList.remove('is-drop-before', 'is-drop-after'));
        const over = items.find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientY >= r.top && e.clientY < r.bottom;
        });
        if (over && over !== drag.item) {
            const r = over.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            over.classList.add(before ? 'is-drop-before' : 'is-drop-after');
            drag.target = { id: over.dataset.goal, before };
        } else {
            drag.target = null;
        }
    });

    function endDrag() {
        if (!drag) return;
        const d = drag;
        drag = null;
        for (const t of list.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after')) {
            t.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
        }
        if (!d.active || !d.target) return;
        const order = PlanStore.state.goals.map((g) => g.id).filter((x) => x !== d.id);
        let i = order.indexOf(d.target.id);
        if (i < 0) return;
        if (!d.target.before) i += 1;
        moveTo(d.id, i);
    }
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);

    list.addEventListener('keydown', (e) => {
        const handle = e.target.closest('[data-handle]');
        if (!handle) return;
        const id = handle.closest('[data-goal]').dataset.goal;
        const at = PlanStore.state.goals.findIndex((g) => g.id === id);
        const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: PlanStore.state.goals.length - 1 }[e.key];
        if (to == null) return;
        e.preventDefault();
        moveTo(id, to);
    });

    PlanStore.on((c) => {
        if (c.type === 'goals' || c.type === 'results' || c.type === 'workspace' || c.type === 'tabs') render();
    });
    // A Format change (Preferences) rewrites every figure.
    window.addEventListener('currencychange', render);
}());
