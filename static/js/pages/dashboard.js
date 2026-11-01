'use strict';

// ─── Dashboard ───────────────────────────────────────────────────────────────
// A page of cards the user arranges. Each tab along the top is a LAYOUT: a name
// and a set of cards on a 12-column grid, each card a widget from
// pages/dashcards.js with its own size, its own settings and its own period.
// This file runs the page around those cards: the tabs, Customize (moving,
// resizing, adding and removing cards), each card's period picker, and saving.
// What a card draws is dashcards.js's business, where a card may go is
// widgets/dashgrid.js's, and what a period means is widgets/dashperiod.js's.
// The page is drawn in Ant Design (ant.css, ant.js): line Tabs with Customize
// as their extra content, small Cards, and while customizing editable-card
// Tabs, the layout's name, Add widgets (a Drawer of the widgets), Cancel and
// Save.
//
// SAVING. Layouts live in the database (GET/PUT /api/dashboard, handlers/
// dashboard.js), and one PUT carries every layout. Outside Customize a change
// (a card's period, a chip, the open tab) saves itself a moment later. Inside
// Customize nothing is saved until Save; Cancel puts every layout back as it
// was, and every step in between can be undone (Ctrl+Z, Ctrl+Y). A database
// that never saved a layout gets the Overview layout, the Dashboard as it
// was before layouts existed. If the saved layouts cannot be read, the default
// is shown and nothing is saved, so a failed read can never overwrite them.
//
// EVERY CARD OWNS ITS PERIOD. The picker in the card's header row sets it; there
// is no page-wide date. A card may also wear a colour (chosen in the picker's
// footer, from COLORS, and shown as a dot and an edge on its period control).
// Cards on one layout that wear the same colour are LINKED: they share a
// period, so changing it on one changes it on the rest (those that offer the
// chosen preset). Joining a colour takes on the period of the cards already
// wearing it.
//
// ARRANGING. While customizing, a card is moved by dragging it and resized by
// dragging its corner; the cards around it make room as it goes, by the rule in
// widgets/dashgrid.js. A focused card moves with the arrow keys and resizes with
// Shift and the arrows. A widget is added from the Drawer with its Add button,
// or dragged out of the Drawer onto the grid.
//
// DRAWING. A card is drawn for the box the grid gives it. A ResizeObserver on
// each card body redraws it when that box changes, without the entrance; the
// first paint after its data arrives animates. Cards load through a small hub:
// the Store datasets (balance, ie) and a cache of the other GETs, so two cards
// over the same period share one request.
//
// SECURITY: layout names and every label a card draws are
// user-controlled. All of it passes through escapeHtml before innerHTML, and the
// chart reading is built with textContent.

(function () {
    const { TYPES, GROUPS, OVERVIEW, thumbHtml } = DashCards;

    const COLS = DashGrid.COLS;
    const ROW = 48;                 // one grid row, px
    const GAP = 16;                 // between cards, both ways, px
    const PITCH = ROW + GAP;
    const MAX_H = 12;               // tallest card in rows (handlers/dashboard.js)
    // The link colours: id → name. Each id's swatch is --dash-link-<id> (dashboard.css).
    const COLORS = {
        red: 'Red', orange: 'Orange', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink',
    };
    const MAX_LAYOUTS = 8;
    const MAX_CARDS = 40;
    const NAME_MAX = 32;
    const STACK_BELOW = 640;        // canvas width under which cards stack in one column
    const SAVE_DELAY = 600;
    const UNDO_DEPTH = 60;
    const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

    // ─── State ───────────────────────────────────────────────────────────────
    let state = { active: null, layouts: [] };
    const ui = {
        loaded: false,
        canSave: true,       // false once the saved layouts could not be read
        editing: false,
        base: null,          // the layouts as Customize found them, for Cancel
        undo: [],
        redo: [],
        stacked: false,
    };
    const dom = {};
    const live = new Map();  // card id → { el, body, key, data, loading, error, size, sig, chrome }

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    const activeLayout = () => state.layouts.find((l) => l.id === state.active) || state.layouts[0];
    const cards = () => activeLayout().cards;
    const findCard = (id) => cards().find((c) => c.id === id);
    const cardTitle = (card) => TYPES[card.type].name;
    const resolvePeriod = (card) => DashPeriod.resolve(card.period);
    const samePeriod = (a, b) => a.preset === b.preset && a.month === b.month;
    const defaultSize = (def) => def.sizes.M || Object.values(def.sizes)[0];
    const thisMonth = () => DashPeriod.formatMonth({ year: new Date().getFullYear(), monthIdx: new Date().getMonth() });

    /** A card as this build draws it: a known type, settings over the type's
     *  defaults, a period the type offers, and a box inside the grid at no less
     *  than the type's minimum. null for a type this build does not know. */
    function normaliseCard(raw) {
        const def = isObject(raw) ? TYPES[raw.type] : null;
        if (!def) return null;
        const [minW, minH] = def.min;
        const [w0, h0] = defaultSize(def);
        const w = clamp(Number.isInteger(raw.w) ? raw.w : w0, minW, COLS);
        const h = clamp(Number.isInteger(raw.h) ? raw.h : h0, minH, MAX_H);
        const settings = { ...clone(def.defaults), ...(isObject(raw.settings) ? raw.settings : {}) };
        delete settings.title;  // cards are not renamed; drop a title an earlier build saved
        return {
            id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : uid('c'),
            type: raw.type,
            x: clamp(Number.isInteger(raw.x) ? raw.x : 0, 0, COLS - w),
            y: Math.max(0, Number.isInteger(raw.y) ? raw.y : 0),
            w,
            h,
            settings,
            period: DashPeriod.clean(raw.period, def.periods, def.period),
            color: !def.noLink && Object.hasOwn(COLORS, raw.color) ? raw.color : null,
        };
    }

    function normaliseLayout(raw) {
        const seen = new Set();
        const list = (Array.isArray(raw.cards) ? raw.cards : []).map(normaliseCard).filter((c) => {
            if (!c || seen.has(c.id)) return false;
            seen.add(c.id);
            return true;
        });
        return {
            id: raw.id,
            name: String(raw.name || '').trim().slice(0, NAME_MAX) || 'Dashboard',
            cards: DashGrid.pack(list.slice(0, MAX_CARDS)),
        };
    }

    /** The default layout, for a database that has not saved one. */
    function overviewLayout() {
        return {
            id: uid('l'),
            name: OVERVIEW.name,
            cards: DashGrid.pack(OVERVIEW.cards.map((c) => normaliseCard({ ...c, id: uid('c') }))),
        };
    }

    function uniqueName(base) {
        const names = new Set(state.layouts.map((l) => l.name));
        const stem = base.slice(0, NAME_MAX);
        if (!names.has(stem)) return stem;
        for (let n = 2; ; n++) {
            const suffix = ` ${n}`;
            const candidate = `${stem.slice(0, NAME_MAX - suffix.length)}${suffix}`;
            if (!names.has(candidate)) return candidate;
        }
    }

    function announce(message) {
        if (!dom.live) return;
        dom.live.textContent = '';
        requestAnimationFrame(() => { dom.live.textContent = message; });
    }

    // ─── Data ────────────────────────────────────────────────────────────────
    // Cards load through this hub. The Store datasets are shared app-wide and
    // revalidate themselves. Every other GET is kept for the life of the page
    // (each page load is a fresh document, so nothing here outlives the data it
    // was read from), capped with the oldest out, so paging through periods
    // cannot grow it without bound. A failed request is dropped, not kept.
    const JSON_CACHE_MAX = 48;
    const jsonCache = new Map();
    const hub = {
        store: (name) => Store.ensure(name),
        json(url) {
            const hit = jsonCache.get(url);
            if (hit) {
                jsonCache.delete(url);
                jsonCache.set(url, hit);
                return hit;
            }
            const request = apiFetch(url).then((r) => {
                if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
                return r.json();
            });
            request.catch(() => { if (jsonCache.get(url) === request) jsonCache.delete(url); });
            jsonCache.set(url, request);
            if (jsonCache.size > JSON_CACHE_MAX) jsonCache.delete(jsonCache.keys().next().value);
            return request;
        },
    };

    // ─── Saving ──────────────────────────────────────────────────────────────
    let saveTimer = 0;
    let saveChain = Promise.resolve();

    /** Every layout, in the shape handlers/dashboard.js stores. */
    const payload = () => ({
        active: state.active,
        layouts: state.layouts.map((l) => ({
            id: l.id,
            name: l.name,
            cards: l.cards.map(({ id, type, x, y, w, h, settings, period, color }) => ({ id, type, x, y, w, h, settings, period, color })),
        })),
    });

    /** Save now. Writes go out one at a time, in order, so a slow save can never
     *  land after a newer one. A failure says so and keeps what is on screen;
     *  the next change saves everything again. Resolves true when it saved. */
    function saveNow() {
        clearTimeout(saveTimer);
        saveTimer = 0;
        if (!ui.canSave) return saveChain.then(() => false);
        const body = JSON.stringify(payload());
        saveChain = saveChain.then(async () => {
            try {
                const r = await apiFetch('/api/dashboard', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!r.ok) throw new Error(`PUT /api/dashboard answered ${r.status}`);
                return true;
            } catch (err) {
                console.error('[dashboard] could not save the layouts', err);
                Ant.message.error('Could not save the dashboard');
                return false;
            }
        });
        return saveChain;
    }

    /** Save shortly, outside Customize. Inside it, Save saves. */
    function saveSoon() {
        if (ui.editing || !ui.loaded || !ui.canSave) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, SAVE_DELAY);
    }

    async function loadLayouts() {
        try {
            const r = await apiFetch('/api/dashboard');
            if (!r.ok) throw new Error(`GET /api/dashboard answered ${r.status}`);
            const body = await r.json();
            const layouts = (Array.isArray(body.layouts) ? body.layouts : [])
                .filter((l) => isObject(l) && typeof l.id === 'string' && ID_RE.test(l.id))
                .slice(0, MAX_LAYOUTS)
                .map(normaliseLayout);
            if (layouts.length) {
                const active = layouts.some((l) => l.id === body.active) ? body.active : layouts[0].id;
                return { active, layouts };
            }
        } catch (err) {
            console.error('[dashboard] could not read the saved layouts; showing the default', err);
            ui.canSave = false;
            Ant.message.error('Could not load your saved dashboard');
        }
        const overview = overviewLayout();
        return { active: overview.id, layouts: [overview] };
    }

    // ─── Customize ───────────────────────────────────────────────────────────
    function enterEdit() {
        if (ui.editing || !ui.loaded) return;
        if (saveTimer) saveNow();
        closePop();
        hideChartTip();
        ui.editing = true;
        ui.base = clone(state);
        ui.undo = [];
        ui.redo = [];
        dom.root.classList.add('is-editing');
        const hadFocus = dom.actions.contains(document.activeElement);
        buildControls();
        renderAll();
        if (hadFocus) dom.actions.querySelector('[data-act="widgets"]').focus();
        announce('Customizing. Drag a card to move it, drag its corner to resize it, or focus it and use the arrow keys. Add widgets opens the widget list.');
    }

    /** Whether Customize has changed any layout since it began. */
    const editsMade = () => !!ui.base && JSON.stringify(ui.base.layouts) !== JSON.stringify(state.layouts);

    /** End Customize. `keep` saves what it changed; otherwise every layout goes
     *  back to how Customize found it. */
    function exitEdit(keep) {
        if (!ui.editing) return;
        endGesture(false);
        endLibraryDrag(false);
        closePop();
        closeDrawer();
        const changed = editsMade();
        if (!keep && changed) {
            const back = ui.base;
            state = { active: back.layouts.some((l) => l.id === state.active) ? state.active : back.active, layouts: back.layouts };
        }
        const refocus = dom.actions.contains(document.activeElement) || dom.tabs.contains(document.activeElement);
        ui.editing = false;
        ui.base = null;
        ui.undo = [];
        ui.redo = [];
        dom.root.classList.remove('is-editing');
        buildControls();
        renderAll();
        if (refocus) dom.customize.focus();
        if (keep && changed) {
            saveNow().then((ok) => { if (ok) Ant.message.success('Dashboard saved'); });
        } else {
            // Switching tabs inside Customize is not an edit, but it is where
            // the page now stands.
            saveSoon();
            if (!keep && changed) announce('Changes discarded');
        }
    }

    /** Cancel: straight out when nothing changed, else after a Popconfirm. */
    async function cancelEdit(anchor) {
        if (!editsMade()) { exitEdit(false); return; }
        const ok = await Ant.popconfirm(anchor, {
            title: 'Discard your changes?',
            desc: 'Every layout goes back to how it was before you customized.',
            okText: 'Discard',
            danger: true,
        });
        if (ok) exitEdit(false);
    }

    /** Record the layouts before a change, so it can be undone. */
    function checkpoint() {
        if (!ui.editing) return;
        ui.undo.push(clone(state));
        if (ui.undo.length > UNDO_DEPTH) ui.undo.shift();
        ui.redo = [];
    }

    function travel(from, to, message) {
        if (!from.length) return;
        to.push(clone(state));
        state = from.pop();
        renderAll();
        syncNameInput();
        announce(message);
    }
    const undo = () => travel(ui.undo, ui.redo, 'Undone');
    const redo = () => travel(ui.redo, ui.undo, 'Redone');

    // ─── Geometry ────────────────────────────────────────────────────────────
    const geo = { width: 0, colW: 0 };

    function measure() {
        geo.width = dom.canvas.clientWidth;
        ui.stacked = geo.width < STACK_BELOW;
        dom.root.classList.toggle('is-stacked', ui.stacked);
        geo.colW = Math.max(0, (geo.width - GAP * (COLS - 1)) / COLS);
    }

    const spanPx = (cols) => cols * geo.colW + (cols - 1) * GAP;
    const rowsPx = (rows) => rows * ROW + (rows - 1) * GAP;
    const cellRect = (c) => ({ left: c.x * (geo.colW + GAP), top: c.y * PITCH, width: spanPx(c.w), height: rowsPx(c.h) });

    /** Pixel boxes for a layout: the grid, or one column in reading order when
     *  the canvas is too narrow for twelve. */
    function rectsFor(list) {
        const rects = new Map();
        if (!ui.stacked) {
            for (const c of list) rects.set(c.id, cellRect(c));
            return rects;
        }
        let top = 0;
        for (const c of [...list].sort(DashGrid.byPosition)) {
            const height = rowsPx(c.h);
            rects.set(c.id, { left: 0, top, width: geo.width, height });
            top += height + GAP;
        }
        return rects;
    }

    function place(el, r) {
        el.style.transform = `translate(${r.left}px, ${r.top}px)`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    }

    /** While customizing, the least height that fills the visible page below the
     *  canvas's top, in whole grid rows, so the grid cells cover the whole area. */
    function gridFillHeight() {
        if (!ui.editing || ui.stacked) return 0;
        const view = dom.scroller.getBoundingClientRect();
        const top = dom.canvas.getBoundingClientRect().top - view.top;
        const rows = Math.ceil((dom.scroller.clientHeight - top) / PITCH);
        return Math.max(0, rows * PITCH - GAP);
    }

    /** Position every card but `skipId` (the one under the pointer) and size the
     *  canvas to hold them, with room underneath while customizing. */
    function applyLayout(list, skipId = null, minBottom = 0) {
        const rects = rectsFor(list);
        let bottom = 0;
        for (const c of list) {
            const r = rects.get(c.id);
            bottom = Math.max(bottom, r.top + r.height);
            if (c.id === skipId) continue;
            const rt = live.get(c.id);
            if (rt) place(rt.el, r);
        }
        const room = ui.editing && !ui.stacked ? PITCH * 3 : 0;
        dom.canvas.style.height = `${Math.max(list.length ? bottom + room : room, minBottom, gridFillHeight())}px`;
        return rects;
    }

    function showPlaceholder(r) {
        dom.placeholder.hidden = false;
        place(dom.placeholder, r);
    }
    const hidePlaceholder = () => { dom.placeholder.hidden = true; };

    // ─── Cards ───────────────────────────────────────────────────────────────
    // A card is Ant's small Card: the title (with the drag handle while
    // customizing, and the info tip otherwise) and the extra content (the gear,
    // an inline Segmented, the period control, and Remove while customizing)
    // over the body the widget draws into.
    function createCardEl(card) {
        const el = document.createElement('article');
        el.className = 'dash-card ant-card ant-card-small';
        el.dataset.id = card.id;
        el.dataset.type = card.type;
        el.innerHTML = `
            <header class="ant-card-head dash-card-head">
                <div class="ant-card-head-wrapper">
                    <div class="ant-card-head-title dash-card-title">
                        <span class="dash-grip" aria-hidden="true">${Ant.icon('holder')}</span>
                        <h2 class="dash-card-name"></h2>
                    </div>
                    <div class="ant-card-extra dash-card-controls">
                        <button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only dash-gear" data-act="gear"
                            aria-haspopup="dialog" aria-expanded="false" hidden>${Ant.icon('setting')}</button>
                        <div class="dash-inline"></div>
                        <div class="dash-period"></div>
                        <button type="button" class="ant-btn ant-btn-text ant-btn-dangerous ant-btn-sm ant-btn-icon-only dash-remove"
                            data-act="remove" data-tip="Remove from layout">${Ant.icon('close')}</button>
                    </div>
                </div>
            </header>
            <div class="ant-card-body dash-card-body"></div>
            <span class="dash-resize" aria-hidden="true"></span>`;
        return el;
    }

    /** The period control's markup for its kind: for a single month,
     *  DatePicker's trigger between a previous and a next month button
     *  (Space.Compact); for a range or a look-ahead, a small button reading the
     *  period with Dropdown's caret. Both open the period picker, and both
     *  carry the link colour as a dot before the period and their edge. On a
     *  narrow card the arrows go and a range reads by its short name (YTD, 6M)
     *  instead of its dates (dashboard.css). */
    function periodControlSkeleton(kind) {
        const trigger = 'data-act="period" aria-haspopup="dialog" aria-expanded="false"';
        const dot = '<span class="dash-link-dot" aria-hidden="true" hidden></span>';
        if (kind === 'month') {
            return `<div class="ant-space-compact dash-period-month" role="group">
                <button type="button" class="ant-btn ant-btn-default ant-btn-sm ant-btn-icon-only dash-step" data-act="month-prev"
                    aria-label="Previous month">${Ant.icon('left')}</button>
                <button type="button" class="ant-picker dash-period-btn" ${trigger}>${dot}<span class="ant-picker-input"></span>
                    <span class="ant-picker-suffix">${Ant.icon('calendar')}</span></button>
                <button type="button" class="ant-btn ant-btn-default ant-btn-sm ant-btn-icon-only dash-step" data-act="month-next"
                    aria-label="Next month">${Ant.icon('right')}</button>
            </div>`;
        }
        return `<button type="button" class="ant-btn ant-btn-default ant-btn-sm dash-period-btn" ${trigger}>${dot}<span class="dash-period-long"></span><span class="dash-period-short"></span>${Ant.icon('down')}</button>`;
    }

    /** Bring a card's period control in line with its period and colour. It
     *  is rebuilt only when its kind changes, so an open picker stays hung
     *  from the same trigger while its choices redraw it. */
    function syncPeriodControl(host, card, period, title) {
        const kind = period.kind === 'month' ? 'month' : 'menu';
        if (host.dataset.kind !== kind) {
            host.innerHTML = periodControlSkeleton(kind);
            host.dataset.kind = kind;
        }
        const btn = host.querySelector('[data-act="period"]');
        btn.title = period.label;
        btn.setAttribute('aria-label', `${title} period: ${period.label}${card.color ? `, ${COLORS[card.color]} link` : ''}`);
        const dot = btn.querySelector('.dash-link-dot');
        dot.hidden = !card.color;
        if (card.color) {
            btn.dataset.color = card.color;
            dot.dataset.color = card.color;
        } else {
            delete btn.dataset.color;
        }
        if (kind === 'month') {
            btn.querySelector('.ant-picker-input').textContent = period.short;
            host.firstElementChild.setAttribute('aria-label', `${title} month`);
            host.querySelector('[data-act="month-next"]').disabled = DashPeriod.formatMonth(period.first) >= thisMonth();
        } else {
            const compact = period.kind === 'range' ? DashPeriod.PRESETS[period.preset].short : period.short;
            btn.classList.toggle('has-short', compact !== period.short);
            btn.querySelector('.dash-period-long').textContent = period.short;
            btn.querySelector('.dash-period-short').textContent = compact;
        }
    }

    /** The header: title and info tip, the period control, and an inline field
     *  when the card has one. Rewritten only when what it shows has changed. */
    function syncChrome(rt, card) {
        const def = TYPES[card.type];
        const title = cardTitle(card);
        const period = resolvePeriod(card);
        const inline = def.fields.find((f) => f.inline);
        const sig = [title, period.short, period.label, card.color || '', inline ? card.settings[inline.key] : ''].join('\u0000');
        if (rt.chrome === sig) return;
        rt.chrome = sig;
        const name = rt.el.querySelector('.dash-card-name');
        name.textContent = title;
        rt.el.querySelector('.ant-info-tip')?.remove();
        if (def.info) {
            name.insertAdjacentHTML('afterend', `<span class="ant-info-tip" tabindex="0" role="img" aria-label="${escapeHtml(def.info)}"
                data-tip="${escapeHtml(def.info)}">${Ant.icon('info-circle-outlined')}</span>`);
        }
        rt.el.querySelector('.dash-remove').setAttribute('aria-label', `Remove ${title}`);

        // The inline field (Recent Transactions' Show): Ant's small Segmented.
        const inlineHost = rt.el.querySelector('.dash-inline');
        inlineHost.hidden = !inline;
        inlineHost.innerHTML = inline ? `<div class="ant-segmented ant-segmented-sm" role="group" aria-label="${escapeHtml(inline.label)}">${inline.options.map(([value, label, hint]) => {
            const on = String(card.settings[inline.key]) === value;
            return `<button type="button" class="ant-segmented-item" aria-pressed="${on}" data-field="${escapeHtml(inline.key)}"
                data-value="${escapeHtml(value)}" title="${escapeHtml(hint || label)}">${escapeHtml(label)}</button>`;
        }).join('')}</div>` : '';

        const periodHost = rt.el.querySelector('.dash-period');
        periodHost.hidden = !!def.noPeriod;
        if (def.noPeriod) {
            rt.el.setAttribute('aria-label', title);
            return;
        }
        syncPeriodControl(periodHost, card, period, title);
        rt.el.setAttribute('aria-label', `${title}, ${period.label}`);
    }

    /** The card's own checkbox list, once its data gives it one; else null. */
    function gearList(card, rt) {
        const gear = TYPES[card.type].gear;
        return gear && rt && rt.data !== undefined && !rt.error && gear.available({ card, data: rt.data }) ? gear : null;
    }

    /** The settings that live in the gear: every field that is not inline. */
    const gearFields = (def) => def.fields.filter((f) => !f.inline);

    /** The gear shows when the card has settings fields or a list to offer. */
    function syncGear(rt, card) {
        const def = TYPES[card.type];
        const list = gearList(card, rt);
        const btn = rt.el.querySelector('[data-act="gear"]');
        btn.hidden = !list && gearFields(def).length === 0;
        if (btn.hidden) return;
        const label = list ? list.label : `${def.name} settings`;
        btn.dataset.tip = list ? list.title : 'Settings';
        btn.setAttribute('aria-label', label);
    }

    /** What a card's data depends on: its type and its period. Settings change
     *  how a card is drawn, never what it loads. */
    const dataKey = (card) => `${card.type}|${card.period.preset}|${card.period.month || ''}`;

    function skeletonFor(card, rt) {
        const def = TYPES[card.type];
        const h = Math.max(48, rt.body.clientHeight - 8);
        return def.skeleton === 'rows' ? UI.skRows(Math.max(1, Math.min(6, Math.floor(h / 44)))) : UI.skChart(h);
    }

    /** Load a card's data for its period, unless it already has it. The paint
     *  that follows animates, unless `quiet` (a background refresh). */
    function loadCard(card, { force = false, quiet = false } = {}) {
        const rt = live.get(card.id);
        const key = dataKey(card);
        if (!force && rt.key === key) return;
        rt.key = key;
        const token = {};
        rt.loading = token;
        const def = TYPES[card.type];
        const period = resolvePeriod(card);
        const cancelSkeleton = quiet ? () => {} : UI.skeletonGuard(() => {
            if (rt.loading === token) rt.body.innerHTML = skeletonFor(card, rt);
        });
        Promise.resolve()
            .then(() => def.load({ card, period, hub }))
            .then((data) => {
                if (rt.loading !== token) return;
                rt.data = data;
                rt.error = null;
            }, (err) => {
                if (rt.loading !== token) return;
                console.error(`[dashboard] ${card.type} could not load`, err);
                rt.data = undefined;
                rt.error = err;
            })
            .finally(() => {
                if (rt.loading !== token) return;
                cancelSkeleton();
                rt.loading = null;
                paint(card.id, !quiet);
            });
    }

    function holdEntrance(el) {
        el.classList.add('chart-anim-hold');
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('chart-anim-hold')));
    }

    /** Draw one card's body for the box it has now. */
    function paint(id, animate = false) {
        const rt = live.get(id);
        const card = findCard(id);
        if (!rt || !card || rt.loading) return;
        if (rt.data === undefined && !rt.error) return;
        const w = rt.body.clientWidth;
        const h = rt.body.clientHeight;
        rt.size = `${w}x${h}`;
        rt.sig = JSON.stringify(card.settings);
        if (w < 24 || h < 24) return;
        if (hover.body === rt.body) hideChartTip();
        if (rt.error) {
            rt.body.innerHTML = Ant.empty({ compact: true, title: 'Could not load this card' });
        } else {
            const def = TYPES[card.type];
            try {
                def.render(rt.body, { card, period: resolvePeriod(card), data: rt.data, w, h, animate, hub });
                if (animate) holdEntrance(rt.body);
            } catch (err) {
                console.error(`[dashboard] ${card.type} could not draw`, err);
                rt.body.innerHTML = Ant.empty({ compact: true, title: 'Could not draw this card' });
            }
        }
        syncGear(rt, card);
    }

    // Redraws after a resize are batched into the next frame, without the
    // entrance, so dragging a card's corner or the window edge never strobes.
    const pendingPaints = new Set();
    let paintFrame = 0;
    function schedulePaint(id) {
        pendingPaints.add(id);
        if (!paintFrame) {
            paintFrame = requestAnimationFrame(() => {
                paintFrame = 0;
                const ids = [...pendingPaints];
                pendingPaints.clear();
                for (const pid of ids) paint(pid, false);
            });
        }
    }

    const bodyObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const id = entry.target.closest('.dash-card')?.dataset.id;
            const rt = id && live.get(id);
            if (rt && rt.size !== `${entry.target.clientWidth}x${entry.target.clientHeight}`) schedulePaint(id);
        }
    });

    function dropCard(id) {
        const rt = live.get(id);
        if (!rt) return;
        bodyObserver.unobserve(rt.body);
        if (hover.body === rt.body) hideChartTip();
        rt.el.remove();
        live.delete(id);
    }

    /** Bring the canvas in line with the active layout: drop the cards that
     *  left it, build the ones that joined, refresh the rest, and lay it out. */
    function renderCanvas({ enter = false } = {}) {
        const list = cards();
        const ids = new Set(list.map((c) => c.id));
        for (const id of [...live.keys()]) if (!ids.has(id)) dropCard(id);

        const rects = rectsFor(list);
        const ordered = [...list].sort(DashGrid.byPosition);
        let stagger = 0;
        for (const card of ordered) {
            let rt = live.get(card.id);
            if (!rt) {
                const el = createCardEl(card);
                place(el, rects.get(card.id));
                if (enter && !reduceMotion()) {
                    el.classList.add('is-entering');
                    el.style.animationDelay = `${Math.min(stagger++, 8) * 40}ms`;
                    el.addEventListener('animationend', () => {
                        el.classList.remove('is-entering');
                        el.style.animationDelay = '';
                    }, { once: true });
                }
                dom.canvas.appendChild(el);
                rt = { el, body: el.querySelector('.dash-card-body'), key: null, data: undefined, loading: null, error: null, size: '', sig: '', chrome: '' };
                live.set(card.id, rt);
                bodyObserver.observe(rt.body);
            }
            syncChrome(rt, card);
            syncGear(rt, card);
            rt.el.tabIndex = ui.editing ? 0 : -1;
            rt.el.setAttribute('aria-roledescription', ui.editing ? 'movable card' : 'card');
            if (rt.key !== dataKey(card)) loadCard(card);
            else if (rt.sig !== JSON.stringify(card.settings)) paint(card.id, true);
        }

        // Keep the document order the reading order, so Tab walks the cards the
        // way they are laid out. Only moved when it differs: moving a node
        // restarts its animations.
        const inDom = [...dom.canvas.querySelectorAll(':scope > .dash-card')];
        if (inDom.some((el, i) => el.dataset.id !== ordered[i]?.id)) {
            for (const card of ordered) dom.canvas.appendChild(live.get(card.id).el);
        }

        applyLayout(list);
        dom.canvas.setAttribute('aria-label', activeLayout().name);
        // While customizing, the empty grid is the prompt.
        dom.empty.hidden = list.length > 0 || ui.editing;
    }

    /** Redraw every card from the data in hand: a theme or palette change,
     *  whose colours the charts baked into their SVG. */
    function repaintAll() {
        if (!ui.loaded) return;
        for (const card of cards()) paint(card.id, false);
    }

    /** A Store dataset was refreshed in the background: reload, quietly, the
     *  cards that read it. */
    function refreshUsers(name) {
        for (const card of cards()) {
            if (TYPES[card.type].uses.includes(name) && live.has(card.id)) loadCard(card, { force: true, quiet: true });
        }
    }

    // ─── Toolbar ─────────────────────────────────────────────────────────────
    // The layouts are line Tabs; while customizing they are editable cards,
    // each with a × (when there is another layout to fall back on) and the +
    // after the last. The extra content is Customize, or while customizing the
    // open layout's name, Add widgets, Cancel and Save.
    function renderTabs() {
        const many = state.layouts.length > 1;
        const tabs = state.layouts.map((l) => {
            const on = l.id === state.active;
            const id = escapeHtml(l.id);
            const tab = `role="tab" data-layout="${id}" aria-selected="${on}" tabindex="${on ? 0 : -1}"`;
            if (!ui.editing) return `<button type="button" class="ant-tabs-tab dash-tab" ${tab}>${escapeHtml(l.name)}</button>`;
            return `<div class="ant-tabs-tab"><button type="button" class="ant-tabs-tab-btn dash-tab" ${tab}>${escapeHtml(l.name)}</button>${many
                ? `<button type="button" class="ant-tabs-tab-remove" data-act="delete-layout" data-layout="${id}"
                    aria-label="${escapeHtml(`Delete the ${l.name} layout`)}">${Ant.icon('close')}</button>` : ''}</div>`;
        }).join('');
        const full = state.layouts.length >= MAX_LAYOUTS;
        dom.tabs.innerHTML = `<div class="dash-tablist${ui.editing ? ' ant-tabs-card' : ''}" role="tablist" aria-label="Layouts">${tabs}</div>${ui.editing
            ? `<button type="button" class="ant-tabs-nav-add" data-act="new-layout" aria-label="New layout" aria-haspopup="menu"
                aria-expanded="false" data-tip="${full ? `Up to ${MAX_LAYOUTS} layouts` : 'New layout'}"${full ? ' disabled' : ''}>${Ant.icon('plus')}</button>` : ''}`;
    }

    /** The extra content, built once per mode and then kept in step by
     *  syncControls, so a click never replaces the control it landed on and
     *  the name being typed is never redrawn under the caret. */
    function buildControls() {
        if (!ui.editing) {
            dom.actions.innerHTML = `<button type="button" class="ant-btn ant-btn-default dash-customize" data-act="customize" disabled>
                ${Ant.icon('appstore-add')}<span>Customize</span></button>`;
            dom.customize = dom.actions.querySelector('[data-act="customize"]');
            dom.nameInput = null;
            return;
        }
        dom.actions.innerHTML = `
            <input type="text" class="ant-input dash-name-input" maxlength="${NAME_MAX}" aria-label="Layout name" spellcheck="false">
            <button type="button" class="ant-btn ant-btn-default" data-act="widgets" aria-haspopup="dialog">${Ant.icon('appstore-add')}<span>Add widgets</span></button>
            <button type="button" class="ant-btn ant-btn-default" data-act="cancel">Cancel</button>
            <button type="button" class="ant-btn ant-btn-primary" data-act="save">Save</button>`;
        dom.nameInput = dom.actions.querySelector('.dash-name-input');
        dom.nameInput.addEventListener('focus', () => { renaming = false; });
        dom.nameInput.addEventListener('input', onNameInput);
        dom.nameInput.addEventListener('blur', syncNameInput);
        dom.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.nameInput.blur(); });
        syncNameInput();
    }

    function syncControls() {
        if (dom.customize && !ui.editing) dom.customize.disabled = !ui.loaded;
        if (dom.nameInput && document.activeElement !== dom.nameInput) syncNameInput();
    }

    function renderAll(opts) {
        renderTabs();
        syncControls();
        renderCanvas(opts);
        if (drawer) renderWidgets();
    }

    // Renaming: the name box renames the open layout as it is typed, one undo
    // step per visit to the box. An emptied box names it Untitled.
    let renaming = false;

    function onNameInput() {
        if (!renaming) {
            checkpoint();
            renaming = true;
        }
        const layout = activeLayout();
        layout.name = dom.nameInput.value.trim().slice(0, NAME_MAX) || 'Untitled';
        const tab = dom.tabs.querySelector(`[data-layout="${CSS.escape(layout.id)}"][role="tab"]`);
        if (tab) tab.textContent = layout.name;
        dom.canvas.setAttribute('aria-label', layout.name);
    }

    function syncNameInput() {
        if (dom.nameInput && ui.loaded) dom.nameInput.value = activeLayout().name;
    }

    // ─── Pop-ups ─────────────────────────────────────────────────────────────
    // One at a time: the period picker or a card's gear (Ant.popover), the +
    // menu (Ant.dropdown), each fixed to the viewport by ant.js so no card or
    // scroll box clips it, and dismissed by Escape or a press outside it.
    let pop = null;   // { handle, anchor }

    function closePop() {
        if (!pop) return;
        const { handle } = pop;
        pop = null;
        handle.close();
    }

    /** Open an Ant.popover from `anchor`, unless pressing it again closed it. */
    function openPop(anchor, options) {
        if (pop && pop.anchor !== anchor) closePop();
        const handle = Ant.popover(anchor, {
            ...options,
            onClose: () => { if (pop && pop.handle === handle) pop = null; },
        });
        if (!handle) { pop = null; return null; }
        pop = { handle, anchor };
        return handle;
    }

    // ─── Layout commands ─────────────────────────────────────────────────────
    function switchLayout(id) {
        if (id === state.active || !state.layouts.some((l) => l.id === id)) return;
        closePop();
        state.active = id;
        dom.scroller.scrollTop = 0;
        renderAll({ enter: true });
        syncNameInput();
        saveSoon();
        announce(`${activeLayout().name} layout`);
    }

    /** A new tab: 'blank', or a 'copy' of the open one. */
    function createLayout(kind) {
        if (state.layouts.length >= MAX_LAYOUTS) return;
        if (!ui.editing) enterEdit();
        checkpoint();
        let layout;
        if (kind === 'blank') {
            layout = { id: uid('l'), name: uniqueName('New layout'), cards: [] };
        } else {
            const from = activeLayout();
            layout = {
                id: uid('l'),
                name: uniqueName(`${from.name} copy`),
                cards: from.cards.map((c) => ({ ...clone(c), id: uid('c') })),
            };
        }
        state.layouts.push(layout);
        state.active = layout.id;
        dom.scroller.scrollTop = 0;
        renderAll({ enter: true });
        syncNameInput();
        if (kind === 'blank') openDrawer();
        announce(`${layout.name} layout created`);
    }

    /** The + after the tabs: a blank layout, or a copy of the open one. */
    function openNewLayoutMenu(anchor) {
        if (pop && pop.anchor !== anchor) closePop();
        const handle = Ant.dropdown(anchor, {
            items: [
                { label: 'Blank layout', icon: 'plus' },
                { label: `Copy of ${activeLayout().name}`, icon: 'appstore' },
            ],
            onPick: (_item, i) => createLayout(i === 0 ? 'blank' : 'copy'),
        });
        if (handle) pop = { handle, anchor };
    }

    async function deleteLayout(id, anchor) {
        const layout = state.layouts.find((l) => l.id === id);
        if (!layout || state.layouts.length < 2) return;
        closePop();
        const ok = await Ant.popconfirm(anchor, {
            title: `Delete ${layout.name}?`,
            desc: 'The layout and its cards go. Cancel brings them back until you save.',
            okText: 'Delete',
            danger: true,
        });
        if (!ok || !ui.editing || !state.layouts.includes(layout)) return;
        checkpoint();
        const i = state.layouts.indexOf(layout);
        state.layouts.splice(i, 1);
        if (state.active === id) state.active = state.layouts[Math.max(0, i - 1)].id;
        renderAll({ enter: true });
        syncNameInput();
        dom.tabs.querySelector('[role="tab"][aria-selected="true"]')?.focus();
        Ant.message.success(`Deleted ${layout.name}`);
        announce(`${layout.name} layout deleted`);
    }

    // ─── Card commands ───────────────────────────────────────────────────────
    function flashCard(id) {
        const rt = live.get(id);
        if (!rt) return;
        rt.el.classList.remove('is-flash');
        void rt.el.offsetWidth;   // restart the animation
        rt.el.classList.add('is-flash');
        const r = rectsFor(cards()).get(id);
        if (!r) return;
        const view = dom.scroller;
        const top = r.top + dom.canvas.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
        if (top < view.scrollTop || top + r.height > view.scrollTop + view.clientHeight) {
            view.scrollTo({ top: Math.max(0, top - 24), behavior: reduceMotion() ? 'auto' : 'smooth' });
        }
    }

    /** Add a widget: at `at` when it was dropped on the grid, else in the
     *  highest free spot. Returns the new card's id. */
    function addWidget(type, at = null) {
        const def = TYPES[type];
        if (!def) return null;
        if (cards().length >= MAX_CARDS) {
            Ant.message.info(`A layout holds up to ${MAX_CARDS} cards`);
            return null;
        }
        if (!ui.editing) enterEdit();
        const layout = activeLayout();
        checkpoint();
        const [w, h] = defaultSize(def);
        const card = normaliseCard({ type, w, h, id: uid('c') });
        if (at) {
            layout.cards = DashGrid.arrangeMove(layout.cards, { ...card, x: at.x, y: at.y });
        } else {
            const spot = DashGrid.firstFit(layout.cards, card.w);
            layout.cards = DashGrid.stack([...DashGrid.pack(layout.cards), { ...card, ...spot }]);
        }
        renderCanvas();
        if (drawer) renderWidgets();
        flashCard(card.id);
        Ant.message.success(`Added ${def.name}`);
        announce(`${def.name} added`);
        return card.id;
    }

    function removeCard(id) {
        const card = findCard(id);
        if (!card) return;
        const title = cardTitle(card);
        checkpoint();
        const layout = activeLayout();
        layout.cards = DashGrid.pack(layout.cards.filter((c) => c.id !== id));
        renderCanvas();
        if (drawer) renderWidgets();
        Ant.message.success(`Removed ${title}`);
        announce(`${title} removed. Ctrl+Z puts it back.`);
    }

    /** Merge `patch` into a card's settings and redraw it. */
    function updateSettings(id, patch) {
        const card = findCard(id);
        if (!card) return;
        checkpoint();
        card.settings = { ...card.settings, ...patch };
        const rt = live.get(id);
        if (rt) {
            syncChrome(rt, card);
            paint(id, true);
        }
        saveSoon();
    }

    /** Give `card` the period `spec` if it offers that preset. True when it changed. */
    function adoptPeriod(card, spec) {
        const def = TYPES[card.type];
        if (!def.periods.includes(spec.preset)) return false;
        const next = DashPeriod.clean(spec, def.periods, def.period);
        if (samePeriod(next, card.period)) return false;
        card.period = next;
        return true;
    }

    /** Redraw a card's header and fetch its data after its period changed. */
    function refreshCard(card) {
        const rt = live.get(card.id);
        if (!rt) return;
        syncChrome(rt, card);
        loadCard(card);
    }

    /** Set a card's period, and the period of every card linked to it by colour.
     *  Outside Customize it saves like any other choice. */
    function setPeriod(id, spec) {
        const card = findCard(id);
        if (!card) return;
        const def = TYPES[card.type];
        const next = DashPeriod.clean(spec, def.periods, def.period);
        if (samePeriod(next, card.period)) return;
        checkpoint();
        card.period = next;
        const changed = [card];
        if (card.color) {
            for (const other of cards()) {
                if (other !== card && other.color === card.color && adoptPeriod(other, card.period)) changed.push(other);
            }
        }
        changed.forEach(refreshCard);
        saveSoon();
        announce(`${cardTitle(card)}: ${resolvePeriod(card).label}${changed.length > 1 ? `, and ${changed.length - 1} linked card${changed.length > 2 ? 's' : ''}` : ''}`);
    }

    /** A month card's month: the current month follows the calendar (null),
     *  any other is pinned. */
    const monthSpec = (ym) => ({ preset: 'month', month: ym >= thisMonth() ? null : ym });

    /** The previous or next month on a month card's arrows. */
    function stepMonth(id, dir) {
        const card = findCard(id);
        if (!card || card.period.preset !== 'month') return;
        const at = resolvePeriod(card).first;
        const t = at.year * 12 + at.monthIdx + dir;
        const next = DashPeriod.formatMonth({ year: Math.floor(t / 12), monthIdx: ((t % 12) + 12) % 12 });
        if (next > thisMonth()) return;
        setPeriod(id, monthSpec(next));
        // Reaching this month disables Next; the focus then moves to the picker.
        const el = live.get(id)?.el;
        const arrow = el?.querySelector(`[data-act="${dir < 0 ? 'month-prev' : 'month-next'}"]`);
        (arrow && !arrow.disabled ? arrow : el?.querySelector('[data-act="period"]'))?.focus();
    }

    /** Set (or clear, with null) a card's link colour. Joining a colour takes on
     *  the period of the cards already wearing it. */
    function setColor(id, color) {
        const card = findCard(id);
        const next = Object.hasOwn(COLORS, color) ? color : null;
        if (!card || TYPES[card.type].noLink || card.color === next) return;
        checkpoint();
        card.color = next;
        const mate = next && cards().find((c) => c !== card && c.color === next);
        if (mate) adoptPeriod(card, mate.period);
        const rt = live.get(id);
        if (rt) syncChrome(rt, card);
        if (mate) refreshCard(card);
        saveSoon();
        announce(next ? `${cardTitle(card)}: ${COLORS[next]} link${mate ? `, now ${resolvePeriod(card).label}` : ''}` : `${cardTitle(card)}: no link`);
    }

    // ─── Period picker ───────────────────────────────────────────────────────
    // DatePicker's dropdown, opened from the card's period control: the card's
    // ranges or look-aheads as the presets list down the left, the month panel
    // when the card offers single months, and a footer: Follow the current
    // month (a month card that follows moves on by itself when the month
    // turns), and the link colours. Picking a preset or a month closes it;
    // the footer's choices keep it open.
    function periodPickerHtml(card) {
        const def = TYPES[card.type];
        const spec = card.period;
        const presets = def.periods.filter((p) => DashPeriod.PRESETS[p].kind !== 'month');
        const offersMonth = def.periods.includes('month');
        let panels = '';
        if (presets.length) {
            panels += `<ul class="ant-picker-presets" role="group" aria-label="${offersMonth ? 'Ranges' : 'Periods'}">${presets.map((p) => {
                const resolved = DashPeriod.resolve({ preset: p });
                return `<li><button type="button" data-pp="preset:${p}" aria-pressed="${spec.preset === p}"
                    title="${escapeHtml(resolved.label)}">${escapeHtml(DashPeriod.PRESETS[p].name)}</button></li>`;
            }).join('')}</ul>`;
        }
        if (offersMonth) panels += '<div class="dash-period-panel"></div>';

        let footer = '';
        if (offersMonth) {
            const following = spec.preset === 'month' && !spec.month;
            footer += `<label class="ant-checkbox-wrapper dash-follow">
                <input type="checkbox" class="ant-checkbox" data-pp="follow"${following ? ' checked' : ''}>
                <span>Follow the current month</span></label>`;
        }
        if (!def.noLink) {
            const swatch = (key, name) => {
                const on = (card.color || '') === key;
                return `<button type="button" class="dash-swatch${key ? '' : ' is-none'}" data-pp="color:${key}"${key ? ` data-color="${key}"` : ''}
                    role="radio" aria-checked="${on}" aria-label="${name}" data-tip="${name}" tabindex="${on ? 0 : -1}"></button>`;
            };
            footer += `<div class="dash-link">
                <span class="dash-link-label">${Ant.icon('link')}<span>Link</span>
                    <span class="ant-info-tip" tabindex="0" role="img" aria-label="Cards in the same colour share their period"
                        data-tip="Cards in the same colour share their period: change it on one and the rest follow.">${Ant.icon('info-circle-outlined')}</span></span>
                <div class="dash-swatches" role="radiogroup" aria-label="Link colour">${
                    Object.entries(COLORS).map(([key, name]) => swatch(key, name)).join('')}${swatch('', 'No link')}</div>
            </div>`;
        }
        return `<div class="ant-picker-panel-container dash-period-panels">${panels}</div>${footer ? `<div class="ant-picker-footer dash-period-footer">${footer}</div>` : ''}`;
    }

    /** Fill the open picker for the card's current period and mount its month
     *  panel, then put the focus on `focusSelector` when given. */
    function renderPicker(body, id, focusSelector = null) {
        const card = findCard(id);
        if (!card) { closePop(); return; }
        // Following the month turned a range card into a month card, which
        // redrew the control the picker hangs from: open it from the new one.
        if (pop && !pop.anchor.isConnected) {
            closePop();
            const trigger = live.get(id)?.el.querySelector('[data-act="period"]');
            if (trigger) openPeriodPicker(trigger, id, focusSelector);
            return;
        }
        body.innerHTML = periodPickerHtml(card);
        const host = body.querySelector('.dash-period-panel');
        if (host) {
            const current = card.period.preset === 'month' ? DashPeriod.formatMonth(resolvePeriod(card).first) : null;
            const panel = Ant.monthPanel(host, {
                value: current,
                max: thisMonth(),
                onPick: (ym) => {
                    closePop();
                    setPeriod(id, monthSpec(ym));
                    live.get(id)?.el.querySelector('[data-act="period"]')?.focus();
                },
            });
            if (focusSelector === 'month') panel.focus();
        }
        if (focusSelector && focusSelector !== 'month') body.querySelector(focusSelector)?.focus();
        pop?.handle.reposition();
    }

    /** Run one picker action. Returns true when the picker stays open. */
    function periodAction(id, action) {
        const card = findCard(id);
        if (!card) return false;
        const [verb, arg] = action.split(':');
        switch (verb) {
            case 'follow': {
                // Ticked: follow the calendar. Unticked: pin the month on
                // screen, so it stays put when the month turns.
                const following = card.period.preset === 'month' && !card.period.month;
                setPeriod(id, { preset: 'month', month: following ? DashPeriod.formatMonth(resolvePeriod(card).first) : null });
                return true;
            }
            case 'preset': setPeriod(id, { preset: arg, month: null }); return false;
            case 'color': setColor(id, arg || null); return true;
            default: return false;
        }
    }

    function openPeriodPicker(anchor, id, focus = undefined) {
        const card = findCard(id);
        if (!card) return;
        const handle = openPop(anchor, { className: 'dash-period-pop', placement: 'bottom', align: 'start', gap: 4 });
        if (!handle) return;
        handle.el.setAttribute('aria-label', `${cardTitle(card)} period`);
        const body = handle.body;
        body.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-pp]');
            if (!btn) return;
            const action = btn.dataset.pp;
            if (!periodAction(id, action)) {
                closePop();
                live.get(id)?.el.querySelector('[data-act="period"]')?.focus();
                return;
            }
            renderPicker(body, id, `[data-pp="${CSS.escape(action)}"]`);
        });
        body.addEventListener('change', (e) => {
            if (!e.target.matches('[data-pp="follow"]')) return;
            periodAction(id, 'follow');
            renderPicker(body, id, '[data-pp="follow"]');
        });
        // The swatches are one radio group: the arrows move along it.
        body.addEventListener('keydown', (e) => {
            const swatch = e.target.closest('.dash-swatch');
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!swatch || !step) return;
            e.preventDefault();
            const all = [...body.querySelectorAll('.dash-swatch')];
            all[(all.indexOf(swatch) + step + all.length) % all.length].click();
        });
        const start = focus !== undefined ? focus
            : card.period.preset === 'month' ? 'month' : '[data-pp][aria-pressed="true"]';
        renderPicker(body, id, start);
    }

    // ─── Gear ────────────────────────────────────────────────────────────────
    // A card's settings, in a titled Popover from its header gear: the savings
    // goal as a number with a % addon, or a card's own checkbox list (Account
    // Balances: which accounts its chips offer).
    function percentFieldHtml(card, f) {
        return `<div class="ant-form-item dash-gear-field">
            <span class="ant-form-item-label">${escapeHtml(f.label)}</span>
            <div class="ant-space-compact dash-percent">
                <input type="number" class="ant-input" inputmode="decimal" min="${f.min}" max="${f.max}" step="any"
                    value="${escapeHtml(card.settings[f.key])}" data-percent="${escapeHtml(f.key)}" aria-label="${escapeHtml(f.label)}, percent of income">
                <span class="ant-input-addon">%</span>
            </div>
        </div>`;
    }

    function gearHtml(card) {
        const rt = live.get(card.id);
        const fields = gearFields(TYPES[card.type]).map((f) => percentFieldHtml(card, f)).join('');
        const list = gearList(card, rt);
        if (!list) return fields;
        const options = list.options({ card, data: rt.data });
        return `${fields}<div class="dash-gear-list" role="group" aria-label="${escapeHtml(list.heading)}">${options.map((o) =>
            `<label class="ant-checkbox-wrapper"><input type="checkbox" class="ant-checkbox" data-key="${escapeHtml(o.key)}"${o.on ? ' checked' : ''}>
                <span>${escapeHtml(o.label)}</span></label>`).join('')}</div>`;
    }

    function openGear(anchor, id) {
        const card = findCard(id);
        if (!card || !live.has(id) || anchor.hidden) return;
        const list = gearList(card, live.get(id));
        const handle = openPop(anchor, {
            title: list ? list.heading : `${cardTitle(card)} settings`,
            className: 'dash-gear-pop',
            placement: 'bottom',
            align: 'center',
        });
        if (!handle) return;
        const body = handle.body;
        body.innerHTML = gearHtml(card);
        body.addEventListener('change', (e) => {
            const now = findCard(id);
            if (!now) return;
            const box = e.target.closest('[data-key]');
            if (box) {
                const gear = gearList(now, live.get(id));
                if (!gear) return;
                updateSettings(id, gear.toggle({ card: now, data: live.get(id).data }, box.dataset.key));
                body.innerHTML = gearHtml(findCard(id));
                body.querySelector(`[data-key="${CSS.escape(box.dataset.key)}"]`)?.focus();
                return;
            }
            if (e.target.matches('[data-percent]')) commitPercent(id, e.target);
        });
        body.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('[data-percent]')) commitPercent(id, e.target);
        });
        body.querySelector('input')?.focus();
    }

    /** Save a percent box's value. A blank or out-of-range entry snaps to the
     *  nearest value the field allows (the saved one when blank) and the box
     *  shows what was kept. Tenths are the finest step. */
    function commitPercent(id, input) {
        const key = input.dataset.percent;
        const card = findCard(id);
        const field = card && TYPES[card.type].fields.find((f) => f.key === key);
        if (!field) return;
        const typed = input.valueAsNumber;
        const next = Number.isFinite(typed)
            ? clamp(Math.round(typed * 10) / 10, field.min, field.max)
            : card.settings[key];
        input.value = next;
        if (next !== card.settings[key]) updateSettings(id, { [key]: next });
    }

    /** A chip in a card body switched a series or an account on or off. */
    function toggleChip(id, key) {
        const card = findCard(id);
        const rt = live.get(id);
        const def = card && TYPES[card.type];
        if (!def || !def.chip || !rt || rt.data === undefined) return;
        updateSettings(id, def.chip({ card, data: rt.data }, key));
        live.get(id)?.el.querySelector(`[data-chip="${CSS.escape(key)}"]`)?.focus();
    }

    /** An inline Segmented in a card's header chose a value. */
    function setField(id, key, value) {
        const card = findCard(id);
        if (!card || String(card.settings[key]) === value) return;
        updateSettings(id, { [key]: value });
        live.get(id)?.el.querySelector(`[data-field="${CSS.escape(key)}"][data-value="${CSS.escape(value)}"]`)?.focus();
    }

    // ─── Widget Drawer ───────────────────────────────────────────────────────
    // Add widgets opens Ant's Drawer of every widget, in its groups: a card per
    // widget with its schematic, its name, whether the open layout already has
    // one, and Add, which puts it in the highest free spot. A widget can also be
    // dragged out of the Drawer: the Drawer slides away, a placeholder shows
    // where it would land and the cards make room, as they do for a moved card.
    let drawer = null;

    function openDrawer() {
        if (drawer) return;
        if (!ui.editing) enterEdit();
        closePop();
        drawer = Ant.drawer({
            title: 'Widgets',
            className: 'dash-drawer',
            width: 380,
            onClose: () => {
                drawer = null;
                endLibraryDrag(false);
            },
        });
        drawer.body.addEventListener('click', (e) => {
            const add = e.target.closest('[data-add]');
            if (add) addWidget(add.dataset.add);
        });
        drawer.body.addEventListener('pointerdown', onLibraryPointerDown);
        renderWidgets();
    }

    function closeDrawer() {
        drawer?.close();
        drawer = null;
    }

    /** The widget groups, each a caption over its widget cards. */
    function renderWidgets() {
        if (!drawer) return;
        const onLayout = new Set(cards().map((c) => c.type));
        const full = cards().length >= MAX_CARDS;
        const focused = document.activeElement?.closest?.('[data-add]')?.dataset.add;
        drawer.body.innerHTML = `<p class="dash-widgets-hint">Add a widget, or drag one onto the grid.</p>${GROUPS.map((group) => `
            <section class="dash-widget-group" aria-label="${escapeHtml(group.name)}">
                <h3 class="dash-widget-group-title">${escapeHtml(group.name)}</h3>
                <ul class="dash-widget-list">${group.types.map((t) => {
                    const def = TYPES[t];
                    return `<li class="ant-card ant-card-small dash-widget" data-type="${t}">
                        <div class="ant-card-body dash-widget-body">
                            <span class="dash-widget-thumb">${thumbHtml(t)}</span>
                            <span class="dash-widget-text">
                                <span class="dash-widget-name">${escapeHtml(def.name)}</span>
                                ${onLayout.has(t) ? `<span class="dash-widget-meta">${Ant.icon('check')}On this layout</span>` : ''}
                            </span>
                            <button type="button" class="ant-btn ant-btn-default" data-add="${t}" aria-label="Add ${escapeHtml(def.name)}"${full ? ' disabled' : ''}>
                                ${Ant.icon('plus')}<span>Add</span></button>
                        </div></li>`;
                }).join('')}</ul>
            </section>`).join('')}`;
        if (focused) drawer.body.querySelector(`[data-add="${CSS.escape(focused)}"]`)?.focus();
    }

    // ─── Dragging a widget onto the grid ─────────────────────────────────────
    let libDrag = null;

    function onLibraryPointerDown(e) {
        const item = e.target.closest('.dash-widget');
        if (!item || e.button !== 0 || gesture || libDrag || e.target.closest('button')) return;
        if (cards().length >= MAX_CARDS) return;
        e.preventDefault();
        libDrag = { type: item.dataset.type, item, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false };
        capturePointer(item, e.pointerId);
        item.addEventListener('pointermove', onLibraryMove);
        item.addEventListener('pointerup', onLibraryUp);
        item.addEventListener('pointercancel', onLibraryCancel);
    }

    function onLibraryMove(e) {
        const d = libDrag;
        if (!d || e.pointerId !== d.pointerId) return;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        if (!d.started) {
            if (ui.stacked || Math.hypot(d.lastX - d.startX, d.lastY - d.startY) < 5) return;
            d.started = true;
            const def = TYPES[d.type];
            const [w, h] = defaultSize(def);
            d.card = { id: '__new', type: d.type, x: 0, y: 0, w, h };
            d.base = cards().map((c) => ({ ...c }));
            d.ghost = document.createElement('div');
            d.ghost.className = 'dash-drag-ghost ant-scope';
            d.ghost.innerHTML = `<span class="dash-widget-thumb">${thumbHtml(d.type)}</span><span class="dash-widget-name">${escapeHtml(def.name)}</span>`;
            document.body.appendChild(d.ghost);
            drawer?.setAway(true);
            hideChartTip();
            startAutoScroll();
        }
        updateLibraryDrag();
    }

    function updateLibraryDrag() {
        const d = libDrag;
        d.ghost.style.transform = `translate(${d.lastX + 12}px, ${d.lastY + 12}px)`;
        const cr = dom.canvas.getBoundingClientRect();
        const sr = dom.scroller.getBoundingClientRect();
        const over = d.lastX >= cr.left && d.lastX <= cr.right && d.lastY >= sr.top && d.lastY <= sr.bottom;
        d.ghost.classList.toggle('is-over', over);
        if (!over) {
            if (d.preview) {
                d.preview = null;
                applyLayout(d.base);
                hidePlaceholder();
            }
            return;
        }
        const left = d.lastX - cr.left - spanPx(d.card.w) / 2;
        const top = Math.min(d.lastY - cr.top - 24, DashGrid.bottom(d.base) * PITCH + PITCH);
        const x = clamp(Math.round(left / (geo.colW + GAP)), 0, COLS - d.card.w);
        const y = Math.max(0, Math.round(top / PITCH));
        if (d.preview && d.at.x === x && d.at.y === y) return;
        d.at = { x, y };
        d.preview = DashGrid.arrangeMove(d.base, { ...d.card, x, y });
        const rects = applyLayout(d.preview, '__new', top + rowsPx(d.card.h) + PITCH);
        showPlaceholder(rects.get('__new'));
    }

    function endLibraryDrag(commit) {
        const d = libDrag;
        if (!d) return;
        libDrag = null;
        d.item.removeEventListener('pointermove', onLibraryMove);
        d.item.removeEventListener('pointerup', onLibraryUp);
        d.item.removeEventListener('pointercancel', onLibraryCancel);
        if (d.item.hasPointerCapture?.(d.pointerId)) d.item.releasePointerCapture(d.pointerId);
        stopAutoScroll();
        if (!d.started) return;
        d.ghost.remove();
        hidePlaceholder();
        if (commit && d.preview) {
            const placed = d.preview.find((c) => c.id === '__new');
            // Dropped: the Drawer stays out of the way so the new card shows.
            closeDrawer();
            addWidget(d.type, { x: placed.x, y: placed.y });
        } else {
            applyLayout(cards());
            drawer?.setAway(false);
        }
    }

    const onLibraryUp = (e) => { if (libDrag && e.pointerId === libDrag.pointerId) endLibraryDrag(true); };
    const onLibraryCancel = () => endLibraryDrag(false);

    // ─── Moving and resizing ─────────────────────────────────────────────────
    // The card under the pointer follows it exactly; a dashed placeholder and
    // the other cards show where everything will land, recomputed only when the
    // snapped cell changes. Letting go settles the card into the placeholder.
    let gesture = null;

    /** Capture keeps a drag alive when the pointer outruns the card. It can be
     *  refused (the button already lifted), and the drag still works without. */
    function capturePointer(el, pointerId) {
        try {
            el.setPointerCapture(pointerId);
        } catch (err) {
            console.warn('[dashboard] pointer capture refused; continuing without it', err);
        }
    }

    function onCardPointerDown(e) {
        if (!ui.editing || e.button !== 0 || gesture || libDrag) return;
        const el = e.target.closest('.dash-card');
        if (!el) return;
        if (e.target.closest('.dash-card-controls, .ant-info-tip')) return;
        const mode = e.target.closest('.dash-resize') ? 'resize' : 'move';
        e.preventDefault();
        el.focus({ preventScroll: true });
        gesture = { mode, id: el.dataset.id, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false };
        capturePointer(el, e.pointerId);
        el.addEventListener('pointermove', onGestureMove);
        el.addEventListener('pointerup', onGestureUp);
        el.addEventListener('pointercancel', onGestureCancel);
        el.addEventListener('lostpointercapture', onGestureCancel);
        if (mode === 'resize' && !ui.stacked) beginGesture();
    }

    function onGestureMove(e) {
        const g = gesture;
        if (!g || e.pointerId !== g.pointerId) return;
        g.lastX = e.clientX;
        g.lastY = e.clientY;
        if (!g.started) {
            if (ui.stacked || Math.hypot(g.lastX - g.startX, g.lastY - g.startY) < 5) return;
            beginGesture();
        }
        updateGesture();
    }

    function beginGesture() {
        const g = gesture;
        g.started = true;
        g.before = clone(state);
        g.base = cards().map((c) => ({ ...c }));
        g.card = g.base.find((c) => c.id === g.id);
        g.def = TYPES[g.card.type];
        g.rect = cellRect(g.card);
        // Never more than a row below the lowest card, so a drag cannot lengthen
        // the page under the pointer and keep auto-scroll running for ever.
        g.maxTop = DashGrid.bottom(g.base) * PITCH + PITCH;
        const cr = dom.canvas.getBoundingClientRect();
        g.grabX = g.startX - cr.left - g.rect.left;
        g.grabY = g.startY - cr.top - g.rect.top;
        g.target = { x: g.card.x, y: g.card.y, w: g.card.w, h: g.card.h };
        g.preview = g.base;
        g.el.classList.add(g.mode === 'move' ? 'is-dragging' : 'is-resizing');
        if (g.mode === 'resize') {
            g.badge = document.createElement('span');
            g.badge.className = 'dash-size-badge';
            g.badge.textContent = `${g.card.w} × ${g.card.h}`;
            g.el.appendChild(g.badge);
        }
        hideChartTip();
        closePop();
        showPlaceholder(g.rect);
        startAutoScroll();
    }

    function updateGesture() {
        const g = gesture;
        const cr = dom.canvas.getBoundingClientRect();
        if (g.mode === 'move') {
            const left = g.lastX - cr.left - g.grabX;
            const top = Math.min(g.lastY - cr.top - g.grabY, g.maxTop);
            g.el.style.transform = `translate(${left}px, ${top}px)`;
            const x = clamp(Math.round(left / (geo.colW + GAP)), 0, COLS - g.card.w);
            const y = Math.max(0, Math.round(top / PITCH));
            if (x !== g.target.x || y !== g.target.y) {
                g.target = { ...g.target, x, y };
                g.preview = DashGrid.arrangeMove(g.base, { ...g.card, x, y });
                showPreview(g, top + g.rect.height);
            }
        } else {
            const [minW, minH] = g.def.min;
            const pxW = clamp(g.rect.width + (g.lastX - g.startX), spanPx(minW), spanPx(COLS - g.card.x));
            const pxH = clamp(g.rect.height + (g.lastY - g.startY), rowsPx(minH), rowsPx(MAX_H));
            g.el.style.width = `${pxW}px`;
            g.el.style.height = `${pxH}px`;
            const w = clamp(Math.round((pxW + GAP) / (geo.colW + GAP)), minW, COLS - g.card.x);
            const h = clamp(Math.round((pxH + GAP) / PITCH), minH, MAX_H);
            if (w !== g.target.w || h !== g.target.h) {
                g.target = { ...g.target, w, h };
                g.badge.textContent = `${w} × ${h}`;
                g.preview = DashGrid.arrangeInPlace(g.base, { ...g.card, w, h });
                showPreview(g, g.rect.top + pxH);
            }
        }
    }

    function showPreview(g, pointerBottom) {
        const rects = applyLayout(g.preview, g.id, pointerBottom + PITCH);
        showPlaceholder(rects.get(g.id));
    }

    function endGesture(commit) {
        const g = gesture;
        if (!g) return;
        gesture = null;
        g.el.removeEventListener('pointermove', onGestureMove);
        g.el.removeEventListener('pointerup', onGestureUp);
        g.el.removeEventListener('pointercancel', onGestureCancel);
        g.el.removeEventListener('lostpointercapture', onGestureCancel);
        if (g.el.hasPointerCapture?.(g.pointerId)) g.el.releasePointerCapture(g.pointerId);
        stopAutoScroll();
        if (!g.started) return;
        g.el.classList.remove('is-dragging', 'is-resizing');
        g.badge?.remove();
        hidePlaceholder();
        const sig = (list) => list.map((c) => `${c.id}:${c.x},${c.y},${c.w},${c.h}`).sort().join('|');
        if (commit && sig(g.preview) !== sig(g.base)) {
            ui.undo.push(g.before);
            if (ui.undo.length > UNDO_DEPTH) ui.undo.shift();
            ui.redo = [];
            activeLayout().cards = g.preview;
            const card = findCard(g.id);
            announce(g.mode === 'move'
                ? `${cardTitle(card)} moved to column ${card.x + 1}, row ${card.y + 1}`
                : `${cardTitle(card)} resized to ${card.w} columns by ${card.h} rows`);
        }
        renderCanvas();
    }

    const onGestureUp = (e) => { if (gesture && e.pointerId === gesture.pointerId) endGesture(true); };
    const onGestureCancel = () => endGesture(false);

    // Scroll the page while a drag holds the pointer near its top or bottom.
    let scrollFrame = 0;
    function startAutoScroll() {
        if (scrollFrame) return;
        const tick = () => {
            const p = gesture || libDrag;
            if (!p || !p.started) { scrollFrame = 0; return; }
            const r = dom.scroller.getBoundingClientRect();
            // The toolbar stays pinned while customizing, so the top edge is
            // measured from under it.
            const topEdge = r.top + dom.toolbar.offsetHeight + 32;
            const bottomEdge = r.bottom - 48;
            let dy = 0;
            if (p.lastY < topEdge) dy = -Math.min(18, (topEdge - p.lastY) / 3 + 2);
            else if (p.lastY > bottomEdge) dy = Math.min(18, (p.lastY - bottomEdge) / 3 + 2);
            if (dy) {
                const before = dom.scroller.scrollTop;
                dom.scroller.scrollTop += dy;
                if (dom.scroller.scrollTop !== before) {
                    if (gesture) updateGesture();
                    else updateLibraryDrag();
                }
            }
            scrollFrame = requestAnimationFrame(tick);
        };
        scrollFrame = requestAnimationFrame(tick);
    }

    function stopAutoScroll() {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
    }

    /** Arrow keys move a focused card, Shift+arrows resize it and Delete
     *  removes it. */
    function onCardKeydown(e) {
        if (!ui.editing) return;
        const el = e.target.closest('.dash-card');
        if (!el || e.target !== el) return;
        const card = findCard(el.dataset.id);
        if (!card) return;
        const layout = activeLayout();
        const title = cardTitle(card);
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[e.key]) {
            e.preventDefault();
            const [dx, dy] = arrows[e.key];
            let next = null;
            if (e.shiftKey) {
                const [minW, minH] = TYPES[card.type].min;
                const w = clamp(card.w + dx, minW, COLS - card.x);
                const h = clamp(card.h + dy, minH, MAX_H);
                if (w !== card.w || h !== card.h) next = DashGrid.arrangeInPlace(layout.cards, { ...card, w, h });
            } else if (dx) {
                const x = clamp(card.x + dx, 0, COLS - card.w);
                if (x !== card.x) next = DashGrid.arrangeMove(layout.cards, { ...card, x });
            } else {
                next = DashGrid.moveVertical(layout.cards, card.id, dy);
            }
            if (!next) { announce(`${title} cannot go further that way`); return; }
            checkpoint();
            layout.cards = next;
            renderCanvas();
            live.get(card.id)?.el.focus({ preventScroll: true });
            flashCard(card.id);
            const moved = findCard(card.id);
            announce(e.shiftKey ? `${title}: ${moved.w} columns by ${moved.h} rows` : `${title}: column ${moved.x + 1}, row ${moved.y + 1}`);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            const order = [...layout.cards].sort(DashGrid.byPosition);
            const i = order.findIndex((c) => c.id === card.id);
            const nextId = (order[i + 1] || order[i - 1] || {}).id;
            removeCard(card.id);
            if (nextId) live.get(nextId)?.el.focus();
        }
    }

    // ─── Reading a line chart ────────────────────────────────────────────────
    // Moving across a line chart names the month under the pointer and prints
    // what every plotted series was worth in it, in G2's tooltip. The month
    // columns, the guide and the dots come out of FinanceChart.buildLine; this
    // half moves the guide, raises the hovered month's dots and fills the one
    // floating reading every card shares. Everything it prints is read back off
    // the dots (data-name, data-amount, fill), so there is no second copy of a
    // series here to fall out of step with the chart. One delegated listener on
    // the canvas covers every card, including cards added later.
    const hover = { tip: null, hit: null, dots: [], body: null };

    function chartTipEl() {
        if (!hover.tip) {
            hover.tip = document.createElement('div');
            hover.tip.className = 'chart-tip dash-chart-tip ant-scope';
            hover.tip.setAttribute('role', 'tooltip');
            document.body.appendChild(hover.tip);
        }
        return hover.tip;
    }

    /** The month, then a row per series: its colour, its name, its amount.
     *  Built with textContent: the names are user-controlled labels. */
    function fillChartTip(tip, when, dots) {
        const head = document.createElement('div');
        head.className = 'chart-tip-when';
        head.textContent = when;
        const rows = document.createElement('ul');
        rows.className = 'chart-tip-rows';
        for (const dot of dots) {
            const row = document.createElement('li');
            row.className = 'chart-tip-row';
            const swatch = document.createElement('span');
            swatch.className = 'chart-tip-swatch';
            swatch.style.background = dot.getAttribute('fill');
            const name = document.createElement('span');
            name.className = 'chart-tip-name';
            name.textContent = dot.dataset.name;
            const amount = document.createElement('span');
            amount.className = 'chart-tip-amount';
            amount.textContent = dot.dataset.amount;
            row.append(swatch, name, amount);
            rows.appendChild(row);
        }
        tip.replaceChildren(head, rows);
    }

    /** Over the hovered month, centred on the guide, sliding sideways only: its
     *  height comes from the chart's frame, so it holds one line across a sweep. */
    function positionChartTip() {
        const tip = chartTipEl();
        const frame = hover.hit.ownerSVGElement.getBoundingClientRect();
        const anchor = (hover.dots[0] || hover.hit).getBoundingClientRect();
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const x = anchor.left + anchor.width / 2 - w / 2;
        const above = frame.top - h - 12;
        tip.style.left = `${Math.round(clamp(x, 8, window.innerWidth - w - 8))}px`;
        tip.style.top = `${Math.round(above < 8 ? frame.top + 12 : above)}px`;
    }

    function clearChartMarks(svg) {
        if (!svg) return;
        for (const dot of svg.querySelectorAll('.chart-dot-active')) dot.classList.remove('chart-dot-active');
        svg.querySelector('.chart-guide')?.classList.remove('chart-guide-on');
    }

    function showChartTip(hit) {
        const svg = hit.ownerSVGElement;
        if (!svg) return;
        if (hover.hit) clearChartMarks(hover.hit.ownerSVGElement);
        hover.hit = hit;
        hover.body = hit.closest('.dash-card-body');
        hover.dots = [...svg.querySelectorAll(`.chart-dot[data-slot="${hit.dataset.slot}"]`)]
            .sort((a, b) => Number(a.getAttribute('cy')) - Number(b.getAttribute('cy')));
        for (const dot of hover.dots) dot.classList.add('chart-dot-active');
        const guide = svg.querySelector('.chart-guide');
        if (guide) {
            guide.setAttribute('x1', hit.dataset.x);
            guide.setAttribute('x2', hit.dataset.x);
            guide.classList.add('chart-guide-on');
        }
        const tip = chartTipEl();
        fillChartTip(tip, hit.dataset.when, hover.dots);
        positionChartTip();
        tip.classList.add('chart-tip-on');
    }

    function hideChartTip() {
        if (hover.hit) clearChartMarks(hover.hit.ownerSVGElement);
        hover.hit = null;
        hover.dots = [];
        hover.body = null;
        hover.tip?.classList.remove('chart-tip-on');
    }

    // ─── First run ───────────────────────────────────────────────────────────
    // On a database with no user data the dashboard has nothing to draw, so it
    // gives way to one invitation to import. The check is computed from data
    // (GET /api/onboarding), so it never appears for someone with real history,
    // and it stops appearing once any data exists or the user skips it. While it
    // shows, the toolbar and the grid are marked .is-preempted rather than
    // removed, so skipping brings them back without a reload.
    async function maybeOfferOnboarding() {
        const hero = document.getElementById('dashboard-firstrun');
        if (!hero || !window.Onboarding) return;
        let onboarding;
        try {
            const r = await apiFetch('/api/onboarding');
            if (!r.ok) return;
            onboarding = await r.json();
        } catch {
            return;   // a failed check must not hide a working dashboard
        }
        if (!onboarding.fresh || onboarding.dismissed) return;

        const setHero = (on) => {
            hero.hidden = !on;
            for (const el of dom.preemptable) el.classList.toggle('is-preempted', on);
        };
        setHero(true);

        // The grid was laid out while hidden, at no width: lay it out again once
        // it shows (the layouts may still be loading, and then they lay it out).
        const reveal = () => {
            measure();
            if (ui.loaded) renderCanvas();
        };

        document.getElementById('dashboard-firstrun-skip').addEventListener('click', async () => {
            setHero(false);
            reveal();
            try {
                await apiFetch('/api/app-settings/onboarding_dismissed', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ value: 'on' }),
                });
            } catch {
                // Worst case the invitation returns next launch; nothing breaks.
            }
        });

        document.getElementById('dashboard-firstrun-start').addEventListener('click', () => {
            Onboarding.start({
                onFinished: ({ imported }) => {
                    setHero(false);
                    if (!imported) {
                        reveal();
                        return;
                    }
                    // An import changes every dataset this page holds. Reload
                    // rather than redraw: the page's wiring is bound once per load.
                    Store.invalidate('balance');
                    Store.invalidate('ie');
                    location.reload();
                },
            });
        });
    }

    // ─── Wiring ──────────────────────────────────────────────────────────────
    const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    // The Settings and database modals live in the page hidden, so only an
    // overlay that is showing counts.
    const dialogOpen = () => !!document.querySelector(
        ':is(.confirm-overlay, .onb-overlay, .settings-modal-overlay, .db-modal-overlay):not([hidden])');

    function onCanvasClick(e) {
        const act = e.target.closest('[data-act]');
        const el = e.target.closest('.dash-card');
        const id = el && el.dataset.id;
        if (!id) return;
        if (act && !act.disabled) {
            switch (act.dataset.act) {
                case 'period': openPeriodPicker(act, id); return;
                case 'month-prev': stepMonth(id, -1); return;
                case 'month-next': stepMonth(id, 1); return;
                case 'gear': openGear(act, id); return;
                case 'remove': removeCard(id); return;
                default: break;
            }
        }
        const field = e.target.closest('.dash-inline [data-field]');
        if (field) { setField(id, field.dataset.field, field.dataset.value); return; }
        const chip = !ui.editing && e.target.closest('[data-chip]');
        if (chip) toggleChip(id, chip.dataset.chip);
    }

    function onToolbarClick(e) {
        const tab = e.target.closest('[role="tab"][data-layout]');
        if (tab) { switchLayout(tab.dataset.layout); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        switch (btn.dataset.act) {
            case 'customize': enterEdit(); break;
            case 'new-layout': openNewLayoutMenu(btn); break;
            case 'delete-layout': deleteLayout(btn.dataset.layout, btn); break;
            case 'widgets': openDrawer(); break;
            case 'cancel': cancelEdit(btn); break;
            case 'save': exitEdit(true); break;
            default: break;
        }
    }

    function onTabsKeydown(e) {
        if (!e.target.matches('[role="tab"]')) return;
        const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        let next = null;
        const i = state.layouts.findIndex((l) => l.id === state.active);
        if (step) next = state.layouts[(i + step + state.layouts.length) % state.layouts.length];
        else if (e.key === 'Home') next = state.layouts[0];
        else if (e.key === 'End') next = state.layouts[state.layouts.length - 1];
        else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.editing) {
            const remove = e.target.parentElement.querySelector('[data-act="delete-layout"]');
            if (remove) { e.preventDefault(); deleteLayout(remove.dataset.layout, remove); }
            return;
        }
        if (!next) return;
        e.preventDefault();
        switchLayout(next.id);
        dom.tabs.querySelector(`[role="tab"][data-layout="${CSS.escape(next.id)}"]`)?.focus();
    }

    function onKeydown(e) {
        if (dialogOpen()) return;
        if (e.key === 'Escape') {
            if (gesture) { endGesture(false); return; }
            if (libDrag) endLibraryDrag(false);
            return;
        }
        if (ui.editing && (e.ctrlKey || e.metaKey) && !isTyping(e.target)) {
            const key = e.key.toLowerCase();
            if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
            else if (key === 'y') { e.preventDefault(); redo(); }
        }
    }

    // The grid follows the canvas width (the window, the sidebar) without
    // animating every card into place.
    let resizeFrame = 0;
    let settleTimer = 0;
    function onCanvasResize() {
        resizeFrame = 0;
        const before = `${geo.width}|${ui.stacked}`;
        measure();
        if (!ui.loaded || `${geo.width}|${ui.stacked}` === before) return;
        dom.canvas.classList.add('no-anim');
        if (gesture && gesture.started) {
            gesture.rect = cellRect(gesture.card);
            updateGesture();
        } else {
            applyLayout(cards());
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => dom.canvas.classList.remove('no-anim'), 120);
    }

    function wire() {
        dom.canvas.addEventListener('pointerdown', onCardPointerDown);
        dom.canvas.addEventListener('keydown', onCardKeydown);
        dom.canvas.addEventListener('click', onCanvasClick);
        dom.canvas.addEventListener('pointerover', (e) => {
            if (ui.editing || gesture || libDrag) return;
            const hit = e.target.closest('.chart-hit');
            if (!hit) { if (hover.hit) hideChartTip(); return; }
            if (hit !== hover.hit) showChartTip(hit);
        });
        dom.canvas.addEventListener('pointerleave', hideChartTip);
        dom.empty.addEventListener('click', (e) => {
            if (e.target.closest('[data-empty-action="add-widgets"]')) openDrawer();
        });

        dom.toolbar.addEventListener('click', onToolbarClick);
        dom.tabs.addEventListener('keydown', onTabsKeydown);

        document.addEventListener('keydown', onKeydown);
        // .page scrolls, not the window; capture, because that scroll does not bubble.
        document.addEventListener('scroll', () => {
            if (pop) pop.handle.reposition?.();
            if (hover.hit) positionChartTip();
        }, { capture: true, passive: true });
        window.addEventListener('resize', () => {
            closePop();
            hideChartTip();
        });
        window.addEventListener('themechange', repaintAll);
        window.addEventListener('pagehide', () => { if (saveTimer) saveNow(); });

        new ResizeObserver(() => {
            if (!resizeFrame) resizeFrame = requestAnimationFrame(onCanvasResize);
        }).observe(dom.canvas);
    }

    // ─── Boot ────────────────────────────────────────────────────────────────
    async function init() {
        dom.root = document.querySelector('.dashboard-page');
        dom.scroller = dom.root.closest('.page') || document.scrollingElement;
        dom.toolbar = document.getElementById('dash-toolbar');
        dom.tabs = document.getElementById('dash-layouts');
        dom.actions = document.getElementById('dash-actions');
        dom.canvas = document.getElementById('dash-canvas');
        dom.placeholder = document.getElementById('dash-placeholder');
        dom.empty = document.getElementById('dash-empty');
        dom.live = document.getElementById('dash-live');
        dom.preemptable = document.querySelectorAll('.dash-shell');
        if (!dom.canvas) return;

        dom.empty.innerHTML = Ant.empty({
            title: 'This layout has no cards yet',
            desc: 'Add widgets to it from the widget list.',
            action: { label: 'Add widgets', name: 'add-widgets' },
        });
        buildControls();
        wire();
        measure();
        renderTabs();
        syncControls();
        // Runs alongside the layout load: the hero appears once the check
        // resolves, and a database with data never waits on it.
        maybeOfferOnboarding();

        state = await loadLayouts();
        ui.loaded = true;
        renderAll({ enter: true });

        // A background revalidation (store.js serves its snapshot first, then
        // refetches) redraws the cards that read that dataset, quietly.
        Store.subscribe('balance', () => refreshUsers('balance'));
        Store.subscribe('ie', () => refreshUsers('ie'));
    }

    document.addEventListener('DOMContentLoaded', init);
}());
