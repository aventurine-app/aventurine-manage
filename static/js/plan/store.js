'use strict';

// ─── store.js ───────────────────────────────────────────────────────────────
// App state and the only ways to change it.
//
//   PlanStore.state         plans (in navigation order: `tabs`), the active plan,
//                       the shared goals, the workspace, selection, results,
//                       the scrubbed month, save state. Read freely; never write.
//   PlanStore.on(fn)        change events: fn({ type }) with type one of
//                       'tabs' | 'plan' | 'goals' | 'selection' | 'results' |
//                       'scrub' | 'save' | 'workspace'
//   PlanStore.edit(fn)      THE way to change the active plan. Snapshots it for
//                       undo, runs fn(plan) to mutate it, re-simulates on the
//                       next frame and schedules a save.
//   PlanStore.editGoals(fn) the same for the goal list every plan shares.
//   PlanStore.setWorkspace  'plans' (the builder), 'goals', 'analyze' or 'compare'.
//                       The page's address names it (/plan#goals, main.js).
//   PlanStore.setYears(y)   the length every plan runs over (the 1Y–50Y chips in
//                       the scrubber and Analyze). One length for all plans, so
//                       switching plans keeps it; a preference of this
//                       machine. A plan's own settings.years is only the
//                       first visit's default.
//   PlanStore.clearAll()    forget every plan, as the database locks.
//
// Undo follows the workspace: in Goals it steps through goal edits, anywhere
// else through the active plan's.
//
// Editing is local-first: the plan in memory is the truth while the page is
// open, and the backend (handlers/plans.js, the database file) gets the whole
// plan 500 ms after the last change, and at once when the page is left. The
// engine runs in the page on every edit, so the outlook is always current
// with what is on the canvas.

(function () {
    const C = window.PlanCatalog;
    const P = window.PlanModel;
    const Engine = window.PlanEngine;

    const WORKSPACES = ['plans', 'goals', 'analyze', 'compare'];
    // The goal list's key in the dirty set and the undo history. Plan ids
    // cannot contain a colon, so it never meets one.
    const GOALS = ':goals';
    const YEARS_KEY = 'years';
    // The lengths on offer wherever a plan's run is chosen: the scrubber's
    // chips, Analyze's, and Compare's Over.
    const LENGTHS = Object.freeze([1, 3, 5, 10, 20, 30, 40, 50]);

    /** The saved length, or null when none is saved (or it is out of range). */
    function savedYears() {
        const y = Number(PlanPrefs.get(YEARS_KEY));
        return Number.isInteger(y) && y >= 1 && y <= P.LIMITS.years ? y : null;
    }

    const state = {
        workspace: 'plans',
        goals: [],              // shared by every plan (plan.js, validateGoals)
        tabs: [],               // plan ids in tab order
        activeId: null,
        plan: null,
        selection: null,        // { kind: 'node' | 'link', id }, in the builder
        preview: null,          // preset id shown in the inspector before it is added
        previewIcon: null,      // icon picked for the previewed preset; the module is added wearing it
        results: null,
        years: savedYears(),    // every plan's run length; set from the first plan opened when none is saved
        scrub: null,           // month index under the chart cursor
        save: 'saved',          // 'saved' | 'saving' | 'error'
    };

    const plans = new Map();     // id → plan document
    const history = new Map();   // id → { undo: [], redo: [] }
    const dirty = new Set();
    const listeners = new Set();
    let saveTimer = null;
    let simQueued = false;
    let gesture = null;
    let coalesce = { key: null, at: 0 };

    const MAX_UNDO = 100;
    const SAVE_DELAY = 500;
    const COALESCE_MS = 1200;

    /** One backend call as { ok, status, body }. apiFetch hands the request
     *  to the backend before its first await, so requests reach the database
     *  in the order they are made, and one made as the page closes still
     *  arrives. A failure of the bridge itself comes back as status 0. */
    async function request(method, url, body = null) {
        try {
            const res = await apiFetch(url, { method, body: body == null ? undefined : JSON.stringify(body) });
            return { ok: res.ok, status: res.status, body: (await res.json()) || {} };
        } catch (e) {
            console.error('[plan] request failed', method, url, e);
            return { ok: false, status: 0, body: { error: 'the database did not answer' } };
        }
    }

    function emit(type) {
        for (const fn of listeners) {
            try { fn({ type }); } catch (e) { console.error('[store] listener failed', e); }
        }
    }

    function on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // ── Simulation ─────────────────────────────────────────────────────────

    function simulateNow() {
        simQueued = false;
        if (!state.plan) {
            state.results = null;
        } else {
            try {
                state.results = Engine.simulate(atLength(state.plan, state.years));
            } catch (e) {
                console.error('[store] simulation failed', e);
                state.results = null;
            }
        }
        emit('results');
    }

    /** The plan as the engine should run it: over `years`, without changing it. */
    function atLength(plan, years) {
        return years == null || years === plan.settings.years
            ? plan
            : { ...plan, settings: { ...plan.settings, years } };
    }

    function setYears(years) {
        if (!Number.isInteger(years) || years < 1 || years > P.LIMITS.years || years === state.years) return;
        state.years = years;
        PlanPrefs.set(YEARS_KEY, String(years));
        state.scrub = null;
        simulateNow();
    }

    function queueSimulation() {
        if (simQueued) return;
        simQueued = true;
        requestAnimationFrame(simulateNow);
    }

    // ── Undo ───────────────────────────────────────────────────────────────
    // A snapshot is the plan without its camera: undo puts modules back, it
    // does not move the view.

    function hist(id) {
        if (!history.has(id)) history.set(id, { undo: [], redo: [] });
        return history.get(id);
    }

    function snapshot() {
        // The camera is left out: a replacer that drops the top-level `view`.
        return JSON.stringify(state.plan, function (key, value) {
            return this === state.plan && key === 'view' ? undefined : value;
        });
    }

    function pushUndo(snap, id = state.activeId) {
        const h = hist(id);
        h.undo.push(snap);
        if (h.undo.length > MAX_UNDO) h.undo.shift();
        h.redo.length = 0;
    }

    /** Mutate the active plan. `fn(plan)` returning false cancels the edit.
     *  `key` merges a run of edits to one field into a single undo step. */
    function edit(fn, { key = null } = {}) {
        if (!state.plan) return undefined;
        const now = performance.now();
        const merge = key !== null && key === coalesce.key && now - coalesce.at < COALESCE_MS;
        const before = merge || gesture ? null : snapshot();
        const result = fn(state.plan);
        if (result === false) return result;
        if (before !== null && before !== snapshot()) pushUndo(before);
        coalesce = { key, at: now };
        changed();
        return result;
    }

    function changed() {
        state.plan.updatedAt = new Date().toISOString();
        pruneSelection();
        markDirty(state.activeId);
        queueSimulation();
        emit('plan');
    }

    /** Mutate the shared goal list, as edit() does the plan: `fn(goals)`
     *  returning false cancels, `key` merges a run of edits to one field. */
    function editGoals(fn, { key = null } = {}) {
        const now = performance.now();
        const merge = key !== null && key === coalesce.key && now - coalesce.at < COALESCE_MS;
        const before = merge ? null : JSON.stringify(state.goals);
        const result = fn(state.goals);
        if (result === false) return result;
        if (before !== null && before !== JSON.stringify(state.goals)) pushUndo(before, GOALS);
        coalesce = { key, at: now };
        goalsChanged();
        return result;
    }

    function goalsChanged() {
        pruneSelection();
        markDirty(GOALS);
        emit('goals');
    }

    /** A drag: many moves, one undo step, no re-simulation while it runs
     *  (positions do not change the numbers). */
    function beginGesture() {
        if (state.plan && !gesture) gesture = snapshot();
    }

    function gestureMove(fn) {
        if (!gesture) return;
        fn(state.plan);
        emit('plan');
    }

    function endGesture() {
        if (!gesture) return;
        const before = gesture;
        gesture = null;
        if (before === snapshot()) return;
        pushUndo(before);
        coalesce = { key: null, at: 0 };
        state.plan.updatedAt = new Date().toISOString();
        markDirty(state.activeId);
        emit('plan');
    }

    function restore(snap) {
        const doc = JSON.parse(snap);
        doc.view = state.plan.view;
        plans.set(doc.id, doc);
        state.plan = doc;
        coalesce = { key: null, at: 0 };
        changed();
    }

    function restoreGoals(snap) {
        state.goals = JSON.parse(snap);
        coalesce = { key: null, at: 0 };
        goalsChanged();
    }

    /** The history undo works on now, with how to snapshot and restore it. */
    function undoTarget() {
        if (state.workspace === 'goals') return { h: hist(GOALS), snap: () => JSON.stringify(state.goals), put: restoreGoals };
        return state.plan ? { h: hist(state.activeId), snap: snapshot, put: restore } : null;
    }

    function undo() {
        const t = undoTarget();
        if (!t || !t.h.undo.length) return false;
        t.h.redo.push(t.snap());
        t.put(t.h.undo.pop());
        return true;
    }

    function redo() {
        const t = undoTarget();
        if (!t || !t.h.redo.length) return false;
        t.h.undo.push(t.snap());
        t.put(t.h.redo.pop());
        return true;
    }

    const canUndo = () => { const t = undoTarget(); return !!t && t.h.undo.length > 0; };
    const canRedo = () => { const t = undoTarget(); return !!t && t.h.redo.length > 0; };

    // ── Selection, scrub, camera ───────────────────────────────────────────

    function select(sel) {
        const hadPreview = state.preview !== null;
        state.preview = null;
        state.previewIcon = null;
        const same = (state.selection && sel && state.selection.kind === sel.kind && state.selection.id === sel.id)
            || (!state.selection && !sel);
        if (same) {
            if (hadPreview) emit('selection');
            return;
        }
        state.selection = sel;
        emit('selection');
    }

    /** Show a library module in the inspector without adding it to the plan. */
    function previewPreset(id) {
        if (state.preview === id) return;
        state.preview = id;
        state.previewIcon = null;
        state.selection = null;
        emit('selection');
    }

    /** Pick the icon the previewed module will be added with (null: its own). */
    function setPreviewIcon(icon) {
        const p = state.preview && C.preset(state.preview);
        if (!p) return;
        state.previewIcon = icon && icon !== p.icon && C.iconChoices(p).includes(icon) ? icon : null;
        emit('selection');
    }

    function pruneSelection() {
        const s = state.selection;
        if (!s) return;
        const list = !state.plan ? [] : s.kind === 'node' ? state.plan.nodes : state.plan.links;
        if (!list.some((x) => x.id === s.id)) {
            state.selection = null;
            emit('selection');
        }
    }

    /** Switch workspace. A selection belongs to the builder (a module, a link
     *  or a library preview), so leaving it lets the selection go. */
    function setWorkspace(w) {
        const next = WORKSPACES.includes(w) ? w : 'plans';
        if (state.workspace === next) return;
        state.workspace = next;
        coalesce = { key: null, at: 0 };
        setScrub(null);
        emit('workspace');
        if (next !== 'plans' && (state.selection || state.preview)) select(null);
    }

    function setScrub(k) {
        if (state.scrub === k) return;
        state.scrub = k;
        emit('scrub');
    }

    /** Camera moves are saved with the plan but are not undoable edits. */
    function setView(view) {
        if (!state.plan) return;
        state.plan.view = view;
        markDirty(state.activeId);
    }

    // ── Saving ─────────────────────────────────────────────────────────────

    function setSave(s) {
        if (state.save === s) return;
        state.save = s;
        emit('save');
    }

    function markDirty(id) {
        if (!id) return;
        dirty.add(id);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flush, SAVE_DELAY);
    }

    let flushing = null;
    let lastError = null;

    async function flush() {
        clearTimeout(saveTimer);
        saveTimer = null;
        // A loop, not an if: another caller waiting on the same save may have
        // started the next one by the time this one wakes.
        while (flushing) await flushing;
        if (!dirty.size) return true;
        flushing = (async () => {
            setSave('saving');
            let ok = true;
            for (const id of [...dirty]) {
                const req = saveRequest(id);
                dirty.delete(id);
                if (!req) continue;
                const r = await request('PUT', req.url, req.body);
                if (r.ok) continue;
                ok = false;
                dirty.add(id);
                lastError = r.body && r.body.error;
                console.error('[store] save failed', r.status, r.body);
            }
            setSave(ok ? 'saved' : 'error');
            if (!ok) {
                const why = lastError ? ` (${lastError})` : '';
                planNotice(`Changes could not be saved${why}.`, { type: 'error', action: { label: 'Retry', onClick: flush }, duration: 0 });
            }
            return ok;
        })();
        try {
            return await flushing;
        } finally {
            flushing = null;
        }
    }

    /** What saving `id` (a plan id, or GOALS) sends: { url, body }, or null. */
    function saveRequest(id) {
        if (id === GOALS) return { url: '/api/plans/goals', body: { goals: state.goals } };
        const doc = plans.get(id);
        return doc ? { url: `/api/plans/${encodeURIComponent(id)}`, body: { plan: doc } } : null;
    }

    // Leaving the page (another page in the sidebar, closing the window)
    // leaves no time to await a reply. The request is still handed to the
    // backend at once, which writes it whether or not anyone is listening.
    window.addEventListener('beforeunload', () => {
        clearTimeout(saveTimer);
        for (const id of dirty) {
            const req = saveRequest(id);
            if (req) request('PUT', req.url, req.body);
        }
        dirty.clear();
    });

    // Minimising the window is announced too; save then, in case it is not
    // opened again.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });

    /** The database locked: forget every plan, the goals and the undo history,
     *  and drop unsaved changes (the backend refuses them while locked).
     *  Unlocking reloads the page, which loads them again. */
    function clearAll() {
        clearTimeout(saveTimer);
        dirty.clear();
        plans.clear();
        history.clear();
        Object.assign(state, {
            goals: [], tabs: [], activeId: null, plan: null, selection: null, preview: null,
            previewIcon: null, results: null, scrub: null,
        });
    }

    // ── Limits ─────────────────────────────────────────────────────────────

    const LIMIT_WORDS = {
        plans:   (n) => `You can have at most ${n} plan${n === 1 ? '' : 's'}.`,
        modules: (n) => `A plan holds at most ${n} module${n === 1 ? '' : 's'}.`,
        links:   (n) => `A plan holds at most ${n} link${n === 1 ? '' : 's'}.`,
        goals:   (n) => `You can set at most ${n} goal${n === 1 ? '' : 's'}.`,
    };

    /** Tell the user a cap stopped them. `kind` is plans, modules, links or goals. */
    function limitReached(kind, max) {
        planNotice(LIMIT_WORDS[kind](max), { type: 'error' });
    }

    // ── Plans (tabs) ───────────────────────────────────────────────────────

    const planName = (id) => (plans.get(id) || {}).name || 'Plan';
    const getPlan = (id) => plans.get(id) || null;

    // Every plan is in memory from boot on (they are small, and Compare runs
    // them all), so opening one needs no request.
    function loadPlan(id) {
        const doc = plans.get(id);
        if (!doc) throw new Error(`no plan ${id}`);
        return doc;
    }

    async function openPlan(id) {
        if (id === state.activeId && state.plan) return;
        const doc = loadPlan(id);
        // With no length saved yet, the first plan opened sets it, so a
        // returning user keeps the length they had.
        if (state.years == null) {
            state.years = doc.settings.years;
            PlanPrefs.set(YEARS_KEY, String(state.years));
        }
        state.activeId = id;
        state.plan = doc;
        state.selection = null;
        state.preview = null;
        state.previewIcon = null;
        state.scrub = null;
        emit('tabs');
        emit('selection');
        emit('plan');
        simulateNow();
        persistTabs();
    }

    function persistTabs() {
        if (state.tabs.length) request('PUT', '/api/plans/order', { order: state.tabs, active: state.activeId });
    }

    async function addPlan(doc) {
        const r = await request('POST', '/api/plans', { plan: doc });
        if (!r.ok) {
            const cap = /^at most (\d+) plans?$/.exec(r.body.error || '');
            if (cap) limitReached('plans', Number(cap[1]));
            else planNotice('The plan could not be created.', { type: 'error' });
            return null;
        }
        plans.set(r.body.plan.id, r.body.plan);
        state.tabs.push(r.body.plan.id);
        await openPlan(r.body.plan.id);
        return r.body.plan;
    }

    function uniqueName(base) {
        const names = new Set(state.tabs.map(planName));
        if (!names.has(base)) return base;
        for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
    }

    function newPlan() {
        const start = state.plan ? state.plan.settings.start : P.ymNow();
        return addPlan(P.createPlan({ name: uniqueName('Untitled plan'), start }));
    }

    async function duplicatePlan(id) {
        await flush();
        const src = loadPlan(id);
        return addPlan(P.cloneWithNewIds(src, uniqueName(`${src.name} copy`)));
    }

    async function renamePlan(id, name) {
        const clean = name.trim().slice(0, P.LIMITS.name);
        if (!clean) return;
        if (id === state.activeId) {
            edit((plan) => { plan.name = clean; });
        } else {
            const doc = loadPlan(id);
            doc.name = clean;
            markDirty(id);
        }
        emit('tabs');
    }

    async function deletePlan(id) {
        await flush();
        const r = await request('DELETE', `/api/plans/${encodeURIComponent(id)}`);
        if (!r.ok) {
            planNotice('The plan could not be deleted.', { type: 'error' });
            return;
        }
        plans.delete(id);
        history.delete(id);
        dirty.delete(id);
        state.tabs = state.tabs.filter((x) => x !== id);
        if (state.activeId === id) {
            state.activeId = null;
            state.plan = null;
            if (r.body.active) await openPlan(r.body.active);
            else await newPlan();
        } else {
            emit('tabs');
        }
    }

    function reorderTabs(order) {
        state.tabs = order.slice();
        emit('tabs');
        persistTabs();
    }

    // ── Files ──────────────────────────────────────────────────────────────
    // A plan file is read here, from a file the user picks, and its text is
    // sent to the backend, which checks it. Exports are written by the
    // backend to a path the user picks in a save dialog (preload's
    // electronFile), so the page never names a path of its own.

    const IMPORT_ACCEPT = '.json,.prism,.citrine-plan,application/json';
    // Larger than any real plan file; the backend checks again.
    const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

    /** The text of a plan file the user picks, or null if they cancel. The
     *  picker opens before anything is awaited: it needs the click that
     *  asked for it. */
    function pickPlanFile() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = IMPORT_ACCEPT;
            input.hidden = true;
            document.body.append(input);
            const done = (settle, value) => {
                input.remove();
                settle(value);
            };
            input.addEventListener('cancel', () => done(resolve, null));
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) return done(resolve, null);
                if (file.size > MAX_IMPORT_BYTES) return done(reject, new Error('file is too large to be a plan'));
                try {
                    return done(resolve, await file.text());
                } catch {
                    return done(reject, new Error('file could not be read'));
                }
            });
            input.click();
        });
    }

    /** Import a plan file the user picks, and open it. Resolves to the plan,
     *  or null when nothing was imported (cancelled, or refused). */
    async function importPlan() {
        let text;
        try {
            text = await pickPlanFile();
        } catch (e) {
            planNotice(`Not imported: ${e.message}.`, { type: 'error' });
            return null;
        }
        if (text == null) return null;
        const r = await request('POST', '/api/plans/import', { text });
        if (!r.ok) {
            planNotice(r.body.error ? `Not imported: ${r.body.error}.` : 'The plan could not be imported.', { type: 'error' });
            return null;
        }
        // A one-plan file brings one; Download All's file every plan in it.
        const added = r.body.plans;
        for (const plan of added) {
            plans.set(plan.id, plan);
            state.tabs.push(plan.id);
        }
        // The file may have brought goals into the shared list.
        state.goals = r.body.goals;
        emit('goals');
        await openPlan(added[0].id);
        planNotice(added.length === 1 ? `Imported ${added[0].name}.` : `Imported ${added.length} plans.`, { type: 'success' });
        return added[0];
    }

    /** Ask where to save, then have the backend write it there. `kind` names
     *  the save dialog's file type ('plan' | 'csv' | 'zip'). */
    async function saveAs(kind, suggestedName, url, body, done) {
        await flush();
        const path = await window.electronFile?.choosePlanExportPath(kind, suggestedName);
        if (!path) return;
        const r = await request('POST', url, { ...body, path });
        if (!r.ok) planNotice(r.body.error ? `Not saved: ${r.body.error}.` : 'The file could not be saved.', { type: 'error' });
        else planNotice(done, { type: 'success' });
    }

    /** Save one plan as a file: `format` 'json' (the plan file) or 'csv' (month by month). */
    function exportPlan(id, format = 'json') {
        return saveAs(format === 'csv' ? 'csv' : 'plan', planName(id),
            `/api/plans/${encodeURIComponent(id)}/export`, { format }, 'Plan exported.');
    }

    /** Download All: every plan and the goals, as one zip. */
    function exportAll() {
        const today = new Date().toISOString().slice(0, 10);
        return saveAs('zip', `Aventurine Plans ${today}`, '/api/plans/export-all', {}, 'Plans exported.');
    }

    /** Load every plan and the goals (one request), then open the active
     *  plan. A database with no plans gets a blank one, which opens on the
     *  empty-plan card. */
    async function boot() {
        const r = await request('GET', '/api/plans');
        if (!r.ok) throw new Error(r.body.error || 'plans could not be listed');
        for (const plan of r.body.plans) plans.set(plan.id, plan);
        state.tabs = r.body.order.slice();
        state.goals = r.body.goals;
        emit('goals');
        if (r.body.quarantined) {
            planNotice(`${r.body.quarantined} saved ${r.body.quarantined === 1 ? 'plan was' : 'plans were'} made by a newer version of Aventurine and ${r.body.quarantined === 1 ? 'is' : 'are'} not shown.`,
                { type: 'warning', duration: 8000 });
        }
        if (!state.tabs.length) await newPlan();
        else await openPlan(r.body.active || state.tabs[0]);
    }

    // ── Module and link actions ────────────────────────────────────────────
    // Domain operations shared by the canvas, the library and the inspector.

    const node = (id) => state.plan && state.plan.nodes.find((n) => n.id === id);
    const link = (id) => state.plan && state.plan.links.find((l) => l.id === id);

    function addNode(presetId, x, y) {
        let created = null;
        edit((plan) => {
            if (plan.nodes.length >= P.LIMITS.nodes) {
                limitReached('modules', P.LIMITS.nodes);
                return false;
            }
            created = P.createNode(plan, presetId, x, y);
            if (state.preview === presetId && state.previewIcon) created.icon = state.previewIcon;
            plan.nodes.push(created);
            return true;
        });
        if (created) select({ kind: 'node', id: created.id });
        return created;
    }

    /** A copy of one module beside it, named as a copy, and selected. */
    function duplicateNode(id) {
        const snap = copyNodes([id]);
        if (!snap) return null;
        snap.nodes[0].name = `${snap.nodes[0].name} copy`.slice(0, P.LIMITS.name);
        const [made] = pasteNodes(snap, 32);
        if (!made) return null;
        select({ kind: 'node', id: made });
        return node(made);
    }

    /** Copies of `ids` and the links among them, ready for pasteNodes. */
    function copyNodes(ids) {
        const plan = state.plan;
        if (!plan) return null;
        const want = new Set(ids);
        const nodes = plan.nodes.filter((n) => want.has(n.id));
        if (!nodes.length) return null;
        const links = plan.links.filter((l) => want.has(l.from) && want.has(l.to));
        return JSON.parse(JSON.stringify({ nodes, links }));
    }

    /** Paste a copyNodes snapshot into the open plan, `offset` px from where it
     *  was copied, with fresh ids. Returns the new node ids. */
    function pasteNodes(snap, offset) {
        if (!snap || !state.plan) return [];
        const ids = new Map();
        const made = [];
        edit((plan) => {
            if (plan.nodes.length + snap.nodes.length > P.LIMITS.nodes) {
                limitReached('modules', P.LIMITS.nodes);
                return false;
            }
            if (plan.links.length + snap.links.length > P.LIMITS.links) {
                limitReached('links', P.LIMITS.links);
                return false;
            }
            for (const src of snap.nodes) {
                const n = JSON.parse(JSON.stringify(src));
                ids.set(src.id, n.id = P.newId('n'));
                n.x += offset;
                n.y += offset;
                plan.nodes.push(n);
                made.push(n.id);
            }
            // Cash back follows a copied account; to one left behind it still
            // goes if that account is in this plan (the plan clears it if not).
            for (const n of plan.nodes.filter((x) => made.includes(x.id))) {
                if (n.params && ids.has(n.params.cashBackTo)) n.params.cashBackTo = ids.get(n.params.cashBackTo);
            }
            for (const src of snap.links) {
                const l = JSON.parse(JSON.stringify(src));
                l.id = P.newId('l');
                l.from = ids.get(src.from);
                l.to = ids.get(src.to);
                // A start or stop on a copied account's size follows the copy.
                for (const s of [l, l.back]) {
                    for (const c of [s && s.startWhen, s && s.stopWhen]) if (c && ids.has(c.account)) c.account = ids.get(c.account);
                }
                plan.links.push(l);
            }
            return true;
        });
        return made;
    }

    /** Remove modules and every link touching them, as one undo step. */
    function removeNodes(ids) {
        const gone = new Set(ids);
        edit((plan) => {
            plan.nodes = plan.nodes.filter((n) => !gone.has(n.id));
            plan.links = plan.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
            // A card that paid its cash back into a removed account credits itself again.
            for (const n of plan.nodes) if (n.params && gone.has(n.params.cashBackTo)) n.params.cashBackTo = null;
            // A flow waiting on a removed account's size waits to be told which.
            for (const l of plan.links) {
                for (const s of [l, l.back]) {
                    for (const c of [s && s.startWhen, s && s.stopWhen]) if (c && gone.has(c.account)) c.account = null;
                }
            }
        });
    }

    const removeNode = (id) => removeNodes([id]);

    /** Link two modules on `basis`, or on the usual (else next free) one. */
    /** `sides` ({ fromSide, toSide }) pins the dots the link is drawn between. */
    function connect(fromId, toId, basis = null, sides = null) {
        const check = P.canConnect(state.plan, fromId, toId, basis);
        if (!check.ok) return null;
        let created = null;
        edit((plan) => {
            if (plan.links.length >= P.LIMITS.links) return false;
            created = P.createLink(plan, fromId, toId, basis);
            if (sides) Object.assign(created, sides);
            plan.links.push(created);
            return true;
        });
        if (created) select({ kind: 'link', id: created.id });
        return created;
    }

    /** Drag one end of a link ('to' or 'from') to another module, or to another
     *  dot of the same one. Returns { ok } or { ok: false, reason }. */
    function reconnect(id, nodeId, side, end = 'to') {
        let result = { ok: false, reason: 'missing' };
        edit((plan) => {
            const l = plan.links.find((x) => x.id === id);
            if (!l) return false;
            result = P.reconnect(plan, l, nodeId, side, end);
            return result.ok;
        });
        return result;
    }

    function removeLink(id) {
        edit((plan) => { plan.links = plan.links.filter((l) => l.id !== id); });
    }

    // ── Goals ──────────────────────────────────────────────────────────────
    // One list, shared by every plan. Edited in the Goals workspace; each plan
    // is measured against it in Analyze.

    const goal = (id) => state.goals.find((g) => g.id === id);

    /** The colour a new goal takes: the next one no other goal wears (then they repeat). */
    function nextGoalColor() {
        const goals = state.goals;
        const free = P.GOAL_COLORS.filter((c) => !goals.some((g) => g.color === c));
        return free[0] || P.GOAL_COLORS[goals.length % P.GOAL_COLORS.length];
    }

    /** Add a goal, from `fields` (its rule, name and colour; plan.js fills in
     *  the rest). Returns it, or null at the limit. */
    function addGoal(fields = {}) {
        let created = null;
        editGoals((goals) => {
            if (goals.length >= P.LIMITS.goals) {
                limitReached('goals', P.LIMITS.goals);
                return false;
            }
            created = P.createGoal({ color: nextGoalColor(), ...fields });
            goals.push(created);
            return true;
        });
        return created;
    }

    function removeGoal(id) {
        editGoals((goals) => {
            const at = goals.findIndex((g) => g.id === id);
            if (at < 0) return false;
            goals.splice(at, 1);
            return true;
        });
    }

    /** Move goal `id` to index `to` of the list (clamped to it), as one undo
     *  step. True when it moved. */
    function moveGoal(id, to) {
        return editGoals((goals) => {
            const from = goals.findIndex((g) => g.id === id);
            const at = Math.max(0, Math.min(goals.length - 1, to));
            if (from < 0 || from === at) return false;
            goals.splice(at, 0, goals.splice(from, 1)[0]);
            return true;
        }) === true;
    }

    window.PlanStore = {
        state, on, edit, beginGesture, gestureMove, endGesture, undo, redo, canUndo, canRedo,
        select, setScrub, setView, flush, boot, limitReached, openPlan, newPlan, addPlan, duplicatePlan,
        renamePlan, deletePlan, reorderTabs, importPlan, exportPlan, exportAll, planName, getPlan,
        node, link, previewPreset, setPreviewIcon, addNode, duplicateNode, copyNodes, pasteNodes, removeNode, removeNodes,
        connect, reconnect, removeLink, goal, editGoals, addGoal, nextGoalColor, removeGoal, moveGoal, setWorkspace,
        setYears, atLength, clearAll, LENGTHS,
    };
}());
