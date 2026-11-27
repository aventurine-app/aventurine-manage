'use strict';

// ─── canvas.js ──────────────────────────────────────────────────────────────
// The sandbox. Draws the active plan's modules as cards and its links as
// curves, and turns pointer and keyboard input into PlanStore actions.
//
//   pan       middle-drag, Space+drag, or scroll
//   zoom      Ctrl+scroll (or pinch), the zoom island, Fit
//   add       drop a library tile, double-click empty space, or drag a link
//             out of a port onto empty space
//   link      drag from a module's right port onto another module
//   relink    drag a link's line (or a selected link's grip) and the end
//             nearer the press comes off its module onto another
//   select    click a module or a link; drag empty space to box-select several
//             modules, then drag any one of them to move the group together;
//             Escape clears; Delete removes
//
// The world layer carries one CSS transform (the camera); everything inside it
// is laid out in world units, so a camera move touches a single style. Cards
// are keyed DOM: built once, then only the parts whose text changed are
// written. Hovering the outlook chart sets PlanStore.state.scrub, and the cards
// and links then show that month instead of the whole run.

(function () {
    const C = window.PlanCatalog;
    const P = window.PlanModel;
    const D = window.Describe;

    const stage = document.getElementById('stage');
    const inspectorEl = document.getElementById('inspector');
    const libraryEl = document.getElementById('library');
    const scrubberEl = document.getElementById('scrubber');
    const world = document.getElementById('world');
    const svg = document.getElementById('links');
    const flowLayer = document.getElementById('flows');
    const labelLayer = document.getElementById('labels');
    const nodeLayer = document.getElementById('nodes');
    if (!stage) return;

    // The grips on the selected flow's two ends: drag one to another dot or module.
    const handles = {};
    for (const end of ['from', 'to']) {
        const h = document.createElement('div');
        h.className = 'link-handle';
        h.dataset.end = end;
        h.title = end === 'from' ? 'Drag to send this from another module' : 'Drag to send this to another module';
        h.hidden = true;
        nodeLayer.appendChild(h);   // with the cards, so it sits over their dots
        handles[end] = h;
    }

    // Mirrors .node in canvas.css; the dots sit at the middle of each side.
    const { NODE_W, NODE_H } = P.GEOM;
    const GRID = 24;
    const SNAP = 8;
    const ZOOM_MIN = 0.3;
    const ZOOM_MAX = 2;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    // Past this many links the flow dots run only on the links touching the
    // selection: each animated link repaints the whole SVG layer every frame,
    // and a 262-link plan measured 245 ms a frame animated against 34 ms still.
    const FLOW_LIMIT = 60;

    let cam = { x: 0, y: 0, zoom: 1 };
    // Modules picked by a box-select (two or more). A single pick is the
    // PlanStore selection instead, so the inspector keeps working as before.
    const group = new Set();
    const nodeViews = new Map();
    const linkViews = new Map();

    // ── Islands ────────────────────────────────────────────────────────────

    stage.insertAdjacentHTML('beforeend', `
        <div class="island island--tools" role="toolbar" aria-label="Canvas tools">
            <div class="ant-space-compact plan-toolbar">
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${planIcon('arrow-counter-clockwise')}</button>
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="redo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)">${planIcon('arrow-clockwise')}</button>
            </div>
            <div class="ant-space-compact plan-toolbar">
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="add" aria-label="Add module" title="Add module">${planIcon('plus')}</button>
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="fit" aria-label="Fit plan to view" title="Fit to view">${planIcon('corners-out')}</button>
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="inspector" aria-label="Show inspector" title="Inspector" aria-pressed="true">${planIcon('sidebar-simple')}</button>
            </div>
        </div>
        <div class="island island--zoom" role="toolbar" aria-label="Zoom">
            <div class="ant-space-compact plan-toolbar">
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="zoom-out" aria-label="Zoom out">${planIcon('minus')}</button>
                <button class="zoom-level" type="button" data-act="zoom-reset" title="Reset zoom">100%</button>
                <button class="ant-btn ant-btn-default ant-btn-icon-only" type="button" data-act="zoom-in" aria-label="Zoom in">${planIcon('plus')}</button>
            </div>
        </div>
        <div class="island island--time" hidden aria-live="polite">${planIcon('clock-counter-clockwise')}<span></span><span class="island-age" hidden>${planIcon('user')}<span class="ant-visually-hidden">Age</span><span></span></span></div>
        <div class="canvas-empty" hidden>
            <div class="plan-empty" role="dialog" aria-labelledby="plan-empty-title">
                <button class="ant-btn ant-btn-text ant-btn-icon-only plan-empty-close" type="button" data-act="dismiss-empty" aria-label="Close">${planIcon('x')}</button>
                <div class="plan-empty-art" aria-hidden="true">
                    ${[['source', 'briefcase'], ['account', 'piggy-bank'], ['expense', 'shopping-bag'],
                        ['debt', 'cardholder'], ['group', 'folder'], ['account', 'chart-line-up']].map(([role, icon]) =>
                        `<span class="role-tile role-tile--lg" data-role="${role}">${planIcon(icon)}</span>`).join('')}
                </div>
                <h2 class="plan-empty-title" id="plan-empty-title">Empty plan</h2>
                <p class="plan-empty-text">Add modules from the library above, or start from the example.</p>
                <div class="plan-empty-actions">
                    <button class="ant-btn ant-btn-primary" type="button" data-act="example">${planIcon('sparkle')}Load example</button>
                    <button class="ant-btn ant-btn-default" type="button" data-act="add">Add module</button>
                </div>
            </div>
        </div>`);

    const zoomLabel = stage.querySelector('.zoom-level');
    const undoBtn = stage.querySelector('[data-act="undo"]');
    const redoBtn = stage.querySelector('[data-act="redo"]');
    const inspectorBtn = stage.querySelector('[data-act="inspector"]');
    const timeIsland = stage.querySelector('.island--time');
    const timeLabel = timeIsland.querySelector('span');
    const timeAge = timeIsland.querySelector('.island-age');
    const timeAgeLabel = timeAge.querySelector('span:not(.ant-visually-hidden)');
    const emptyEl = stage.querySelector('.canvas-empty');
    // Plans whose empty card was closed with the ×; it stays closed for the session.
    const dismissedEmpty = new Set();

    // ── Camera ─────────────────────────────────────────────────────────────

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    function applyCamera() {
        world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
        // The dot grid is fixed: it neither scales with zoom nor follows
        // panning. Only the cards and links move.
        stage.style.setProperty('--grid', `${GRID}px`);
        zoomLabel.textContent = `${Math.round(cam.zoom * 100)}%`;
    }

    let viewTimer = null;
    function setCamera(next, { save = true } = {}) {
        cam = { x: next.x, y: next.y, zoom: clamp(next.zoom, ZOOM_MIN, ZOOM_MAX) };
        applyCamera();
        if (!save) return;
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => PlanStore.setView({ ...cam }), 400);
    }

    function zoomAt(factor, sx, sy) {
        const z = clamp(cam.zoom * factor, ZOOM_MIN, ZOOM_MAX);
        const k = z / cam.zoom;
        setCamera({ zoom: z, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k });
    }

    /** The part of the stage no floating card covers, in stage pixels: the
     *  inspector over its right side and, where the page floats them over the
     *  canvas too (Manage's Plan page, embed.css), the module bar over its top
     *  and the scrubber over its bottom. Here those two sit outside the stage,
     *  so they cover nothing. A hidden card covers nothing either. */
    function openArea() {
        const s = stage.getBoundingClientRect();
        const area = { left: 0, top: 0, right: s.width, bottom: s.height };
        if (inspectorEl && inspectorEl.offsetWidth) {
            area.right = clamp(inspectorEl.getBoundingClientRect().left - s.left, 0, s.width);
        }
        if (libraryEl && libraryEl.offsetHeight) {
            area.top = clamp(libraryEl.getBoundingClientRect().bottom - s.top, 0, s.height);
        }
        if (scrubberEl && scrubberEl.offsetHeight) {
            area.bottom = clamp(scrubberEl.getBoundingClientRect().top - s.top, area.top, s.height);
        }
        return area;
    }

    /** The middle of the open stage, in stage pixels. */
    function openCenter() {
        const a = openArea();
        return { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
    }

    /** Where an empty plan's camera starts: near the open stage's top left. */
    function homeCamera() {
        const a = openArea();
        return { x: a.left + 80, y: a.top + 60, zoom: 1 };
    }

    /** Hand the covered edges to CSS (--open-top, --open-right, --open-bottom),
     *  so the tool islands and the empty-plan card stay clear of the cards. */
    function syncOpenArea() {
        const s = stage.getBoundingClientRect();
        const a = openArea();
        stage.style.setProperty('--open-top', `${a.top}px`);
        stage.style.setProperty('--open-right', `${s.width - a.right}px`);
        stage.style.setProperty('--open-bottom', `${s.height - a.bottom}px`);
    }
    if (typeof ResizeObserver === 'function') {
        const watch = new ResizeObserver(syncOpenArea);
        for (const el of [stage, inspectorEl, libraryEl, scrubberEl]) if (el) watch.observe(el);
    }

    /** Zoom about the middle of the open stage, as the buttons and keys do. */
    const zoomCenter = (factor) => {
        const c = openCenter();
        zoomAt(factor, c.x, c.y);
    };

    function stagePoint(clientX, clientY) {
        const r = stage.getBoundingClientRect();
        return { x: clientX - r.left, y: clientY - r.top };
    }

    function toWorld(clientX, clientY) {
        const s = stagePoint(clientX, clientY);
        return { x: (s.x - cam.x) / cam.zoom, y: (s.y - cam.y) / cam.zoom };
    }

    function fit() {
        const plan = PlanStore.state.plan;
        if (!plan || !plan.nodes.length) {
            setCamera(homeCamera());
            return;
        }
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (const n of plan.nodes) {
            x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
            x1 = Math.max(x1, n.x + NODE_W); y1 = Math.max(y1, n.y + NODE_H);
        }
        const pad = 48;
        const a = openArea();
        const w = a.right - a.left - pad * 2;
        const h = a.bottom - a.top - pad * 2;
        const zoom = clamp(Math.min(w / (x1 - x0), h / (y1 - y0), 1.1), ZOOM_MIN, ZOOM_MAX);
        setCamera({
            zoom,
            x: a.left + pad + (w - (x1 - x0) * zoom) / 2 - x0 * zoom,
            y: a.top + pad + (h - (y1 - y0) * zoom) / 2 - y0 * zoom,
        });
    }

    // ── Geometry ───────────────────────────────────────────────────────────

    /** Parallel links between one pair (money from the balance and from the
     *  earnings, say) sit this far apart so none hides another. */
    const PARALLEL_GAP = 20;

    // Every card has a dot on each side. A link is drawn from the dot it was
    // dragged out of to the dot it was dropped on, and either end can be dragged
    // (by the line itself, or by the selected link's grips) to another dot or
    // module. Nothing re-routes it afterwards.
    const SIDES = ['t', 'r', 'b', 'l'];
    const DIR = { t: { x: 0, y: -1 }, r: { x: 1, y: 0 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 } };

    function portAt(n, side) {
        switch (side) {
            case 't': return { x: n.x + NODE_W / 2, y: n.y - 1 };
            case 'b': return { x: n.x + NODE_W / 2, y: n.y + NODE_H + 1 };
            case 'l': return { x: n.x - 1, y: n.y + NODE_H / 2 };
            default:  return { x: n.x + NODE_W + 1, y: n.y + NODE_H / 2 };
        }
    }

    /** The side of a card that faces a point (a vector from the card's centre),
     *  measured against the card's own proportions. */
    function sideToward(vx, vy) {
        if (Math.abs(vx) * NODE_H >= Math.abs(vy) * NODE_W) return vx >= 0 ? 'r' : 'l';
        return vy >= 0 ? 'b' : 't';
    }

    /** The sides a link uses: [leaves from, lands on]. Exactly the ones it was
     *  given, wherever the cards move. A link made with none chosen (from the
     *  picker, the "Pay from" menu, an older plan) leaves the right and lands
     *  on the left until the user moves its ends. */
    function linkSides(link) {
        return [link.fromSide || 'r', link.toSide || 'l'];
    }

    /** A cubic from one port to another, leaving and arriving along the sides'
     *  outward directions. Forward links bow gently; a link whose ends point
     *  away from each other loops out past both cards so it never cuts through them. */
    function curve(a, sa, b, sb) {
        const da = DIR[sa];
        const db = DIR[sb];
        const reach = (b.x - a.x) * da.x + (b.y - a.y) * da.y;
        const c = reach > 40 ? Math.max(40, reach * 0.45) : Math.max(90, Math.abs(reach) * 0.5 + 60);
        const p1 = { x: a.x + da.x * c, y: a.y + da.y * c };
        const p2 = { x: b.x + db.x * c, y: b.y + db.y * c };
        const mid = {
            x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8,
            y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8,
        };
        return { d: `M${a.x},${a.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${b.x},${b.y}`, mid };
    }

    // ── Figures for the cards ──────────────────────────────────────────────
    // The point being shown: the scrubbed month, or the end of the plan.

    function viewPoint() {
        const r = PlanStore.state.results;
        if (!r) return null;
        const k = PlanStore.state.scrub;
        return k == null ? { k: r.months, month: null, all: true } : { k, month: Math.max(0, Math.min(r.months - 1, k - 1)), all: false };
    }

    const avg = (arr) => (arr ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const NONE = [];
    // How serious each issue level is, for a module's flag (describe.js warningLevel).
    const LEVEL_RANK = { info: 0, notice: 1, warn: 2 };

    /** What a source pays per period, from its settings (for the resting card). */
    function sourcePeriod(node) {
        const p = node.params;
        const net = p.amount * (1 - (p.tax || 0) / 100);
        if (p.per === 'once') return { value: net, unit: p.start ? P.ymLabel(p.start) : 'once' };
        if (p.per === 'year') return p.payMonth ? { value: net, unit: '/yr' } : { value: net / 12, unit: '/mo' };
        return { value: net * (C.PER_MONTH[p.per] || 1), unit: '/mo' };
    }

    function figure(node, role, nr, vp) {
        const out = { value: '', unit: '', delta: '', deltaDir: '', negative: false, done: false };
        if (!nr || !vp) return out;
        if (role === 'account') {
            const v = nr.balance[vp.k];
            out.value = Fmt.money(v, { compact: v >= 1e6 });
            out.negative = v < -0.005;     // overdrawn
            // Only what the account has earned, not what flowed in or out of it.
            let d = 0;
            for (let i = 0; i < vp.k && i < nr.earnings.length; i++) d += nr.earnings[i];
            if (Math.abs(d) >= 0.5) {
                out.delta = Fmt.money(d, { sign: true, compact: Math.abs(d) >= 1e4 });
                out.deltaDir = d > 0 ? 'up' : 'down';
            }
        } else if (role === 'debt') {
            const v = nr.balance[vp.k];
            let owedBefore = false;
            for (let i = 0; i < vp.k && !owedBefore; i++) owedBefore = nr.balance[i] > 0.005;
            if (v <= 0.005 && owedBefore) {
                out.value = 'Paid off';
                out.done = true;
            } else if (v <= 0.005 && node.params.start) {
                // Borrowed later in the plan: nothing owed yet.
                out.value = Fmt.money(0);
                out.unit = `until ${P.ymLabel(node.params.start)}`;
            } else {
                out.value = Fmt.money(v, { compact: v >= 1e6 });
                out.unit = 'owed';
                out.negative = v > 0.005;
            }
        } else if (role === 'source') {
            if (vp.all) {
                const s = sourcePeriod(node);
                out.value = Fmt.money(s.value);
                out.unit = s.unit;
            } else {
                // Past the last month an income pays, it has stopped.
                const end = P.incomeEnd(PlanStore.state.plan, node);
                const endIdx = end ? P.ymDiff(PlanStore.state.plan.settings.start, end) : Infinity;
                if (vp.month > endIdx) {
                    out.value = 'Stopped';
                    out.done = true;
                } else {
                    out.value = Fmt.money(nr.produced[vp.month]);
                    out.unit = '/mo';
                }
            }
        } else {
            // Spending and a budget group show what reaches them; a tax or fee
            // shows what it takes.
            const kind = C.preset(node.type).kind;
            const series = role === 'expense' || kind === 'group' ? nr.inflow : nr.consumed;
            const v = vp.all ? avg(series) : series[vp.month];
            out.value = Fmt.money(v);
            out.unit = '/mo';
        }
        return out;
    }

    /** Segments for the bar under a card's figure. */
    function barSegments(node, role, nr, frame) {
        const { res, vp } = frame;
        // Spending and income carry no balance, so they get no bar (see .node-bar in canvas.css).
        if (!nr || !vp || role === 'expense' || role === 'source') return [];
        const upto = vp.all ? res.months : Math.max(1, vp.k);
        const sumTo = (arr) => { let s = 0; for (let i = 0; i < upto && i < arr.length; i++) s += arr[i]; return s; };
        if (role === 'account') {
            const balance = nr.balance[vp.k];
            const growth = Math.max(0, sumTo(nr.earnings));
            const principal = Math.max(0, balance - growth);
            return [{ role: 'account', w: principal, label: 'Saved' }, { role: 'growth', w: Math.min(growth, balance), label: 'Growth' }];
        }
        if (role === 'debt') {
            const peak = Math.max(...nr.balance);
            if (peak <= 0) return [];
            const paid = Math.max(0, peak - nr.balance[vp.k]);
            return [{ role: 'growth', w: paid, label: 'Paid off' }, { role: 'owed', w: peak - paid, label: 'Owed' }];
        }
        const segs = [];
        if (nr.consumed) {
            const spent = sumTo(nr.consumed);
            if (spent > 0) segs.push({ role, w: spent, label: 'Used' });
        }
        for (const l of frame.outs.get(node.id) || NONE) {
            const target = frame.byId.get(l.to);
            const lr = res.links[l.id];
            if (!target || !lr) continue;
            const w = sumTo(lr.flow);
            if (w > 0) segs.push({ role: D.roleOf(target), w, label: target.name });
        }
        if (nr.unplaced) {
            const u = sumTo(nr.unplaced);
            if (u > 0.005) segs.push({ role: 'none', w: u, label: 'Unassigned' });
        }
        return segs;
    }

    /** What one render reads for every card and link: the state, plus lookups
     *  built once per render so that drawing stays linear in the size of the
     *  plan (a lookup per card or link would make it quadratic). */
    function frameFor(plan, res, sel) {
        const byId = new Map(plan.nodes.map((n) => [n.id, n]));
        const outs = new Map();
        const ins = new Set();
        for (const l of plan.links) {
            const list = outs.get(l.from);
            if (list) list.push(l); else outs.set(l.from, [l]);
            ins.add(l.to);
        }
        // A card flags its own warnings and its links'. Money left in
        // Unassigned shows on its bar instead.
        const warns = new Map();
        for (const w of res ? res.warnings : NONE) {
            if (w.code === 'unassigned') continue;
            for (const id of w.nodeIds || (w.nodeId ? [w.nodeId] : NONE)) {
                const list = warns.get(id);
                if (list) list.push(w); else warns.set(id, [w]);
            }
        }
        // Which side of each card its links use, and which dots they therefore fill.
        const linkSide = new Map();
        const used = new Map();
        const use = (id, side) => {
            const set = used.get(id);
            if (set) set.add(side); else used.set(id, new Set([side]));
        };
        for (const l of plan.links) {
            const from = byId.get(l.from);
            const to = byId.get(l.to);
            if (!from || !to) continue;
            const sides = linkSides(l);
            linkSide.set(l.id, sides);
            use(l.from, sides[0]);
            use(l.to, sides[1]);
        }
        return { plan, res, sel, vp: viewPoint(), byId, outs, ins, warns, linkSide, used };
    }

    // ── Cards ──────────────────────────────────────────────────────────────

    function buildNode(node) {
        const el = document.createElement('div');
        el.className = 'node';
        el.tabIndex = 0;
        el.dataset.id = node.id;
        el.innerHTML = `
            ${SIDES.map((side) => `<span class="node-port" data-side="${side}" aria-hidden="true"></span>`).join('')}
            <div class="node-wm" aria-hidden="true"></div>
            <div class="node-cat"><span class="node-cat-name"></span></div>
            <div class="node-titles"><span class="node-name"></span><span class="node-meta"></span></div>
            <div class="node-figure"><span class="node-value"></span><span class="node-unit"></span><span class="node-delta"></span></div>
            <div class="node-bar" aria-hidden="true"></div>`;
        const view = {
            el,
            wm: el.querySelector('.node-wm'),
            cat: el.querySelector('.node-cat-name'),
            name: el.querySelector('.node-name'),
            meta: el.querySelector('.node-meta'),
            value: el.querySelector('.node-value'),
            unit: el.querySelector('.node-unit'),
            delta: el.querySelector('.node-delta'),
            bar: el.querySelector('.node-bar'),
            ports: [...el.querySelectorAll('.node-port')],
            sig: {},
            flag: null,
        };
        nodeLayer.appendChild(el);
        return view;
    }

    /** Write `value` into `key` of the view only if it changed. */
    function put(view, key, value, write) {
        if (view.sig[key] === value) return;
        view.sig[key] = value;
        write(value);
    }

    function renderNode(node, view, frame) {
        const { plan, res, vp, sel } = frame;
        const p = C.preset(node.type);
        const role = p.role;
        put(view, 'pos', `${node.x},${node.y}`, () => {
            view.el.style.transform = `translate(${node.x}px, ${node.y}px)`;
        });
        put(view, 'role', C.swatchOf(p), (r) => {
            view.el.dataset.role = r;
        });
        // A dot starts a link when the module sends money on. A debt's left dot is
        // the exception: it asks who pays the debt. The rest only receive.
        const sends = P.basesFor(node).length > 0;
        put(view, 'ports', `${role}|${sends}`, () => {
            for (const port of view.ports) {
                const asks = role === 'debt' && port.dataset.side === 'l';
                const out = sends && !asks;
                port.className = `node-port ${out ? 'node-port--out' : 'node-port--in'}`;
                if (out) port.title = 'Drag to link'; else port.removeAttribute('title');
            }
        });
        // A dot is filled once a link is attached to it.
        const used = frame.used.get(node.id);
        put(view, 'linked', SIDES.filter((side) => used && used.has(side)).join(''), (sig) => {
            for (const port of view.ports) port.classList.toggle('is-linked', sig.includes(port.dataset.side));
        });
        put(view, 'icon', P.iconOf(node), (icon) => { view.wm.innerHTML = planIcon(icon); });
        put(view, 'cat', D.CATEGORY_NAME[p.cat] || C.ROLES[role].label, (t) => { view.cat.textContent = t; });
        put(view, 'name', node.name, (t) => { view.name.textContent = t; });
        put(view, 'meta', D.nodeMeta(node), (t) => { view.meta.textContent = t; });

        const nr = res && res.nodes[node.id];
        const f = figure(node, role, nr, vp);
        put(view, 'value', f.value, (t) => { view.value.textContent = t; });
        put(view, 'neg', f.negative, (v) => view.value.classList.toggle('is-negative', v));
        put(view, 'unit', f.unit, (t) => { view.unit.textContent = t; });
        put(view, 'delta', `${f.delta}|${f.deltaDir}`, () => {
            view.delta.textContent = f.delta;
            view.delta.className = `node-delta${f.deltaDir ? ` is-${f.deltaDir}` : ''}`;
        });

        const segs = barSegments(node, role, nr, frame);
        const total = segs.reduce((a, s) => a + s.w, 0);
        const barSig = segs.map((s) => `${s.role}:${(s.w / (total || 1)).toFixed(3)}`).join('|');
        put(view, 'bar', barSig, () => {
            view.bar.innerHTML = segs.filter((s) => s.w > 0).map((s) => {
                const title = `${s.label}: ${Fmt.money(s.w, { compact: true })}`;
                return `<span data-role="${s.role}" style="flex: ${s.w} 1 0" title="${escapeHtml(title)}"></span>`;
            }).join('');
        });

        const warns = frame.warns.get(node.id) || NONE;
        const done = f.done;
        // A module's flag is its most serious issue (a warning, else a notice such
        // as a card's high utilization), in the colour and icon that issue's
        // callout has in the inspector.
        const level = warns.reduce((top, w) => {
            const l = D.warningLevel(w);
            return LEVEL_RANK[l] > LEVEL_RANK[top] ? l : top;
        }, 'info');
        const flagSig = warns.length ? `${level}:${warns.map((w) => w.code).join(',')}` : done ? 'done' : '';
        put(view, 'flag', flagSig, () => {
            if (view.flag) { view.flag.remove(); view.flag = null; }
            if (warns.length) {
                view.flag = document.createElement('span');
                view.flag.className = level === 'warn' ? 'node-flag' : `node-flag node-flag--${level}`;
                view.flag.title = warns.map((w) => D.warning(w, plan).text).join('\n');
                view.flag.innerHTML = planIcon(level === 'warn' ? 'warning' : 'info');
            } else if (done) {
                view.flag = document.createElement('span');
                view.flag.className = 'node-check';
                view.flag.innerHTML = planIcon('check');
            }
            if (view.flag) view.el.appendChild(view.flag);
        });

        put(view, 'sel', group.has(node.id) || !!(sel && sel.kind === 'node' && sel.id === node.id), (on) => view.el.classList.toggle('is-selected', on));
        const label = `${node.name}, ${C.ROLES[role].label}, ${f.value} ${f.unit}`.trim();
        put(view, 'aria', label, (t) => view.el.setAttribute('aria-label', t));
    }

    // ── Links ──────────────────────────────────────────────────────────────

    function buildLink(link) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.classList.add('link');
        const path = document.createElementNS(SVG_NS, 'path');
        path.classList.add('link-path');
        const flow = document.createElementNS(SVG_NS, 'path');
        flow.classList.add('link-flow');
        const hit = document.createElementNS(SVG_NS, 'path');
        hit.classList.add('link-hit');
        hit.dataset.link = link.id;
        g.append(path, hit);
        svg.appendChild(g);
        flowLayer.appendChild(flow);
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'link-label';
        label.dataset.link = link.id;
        // The dollars, then the rule behind them in parentheses: '$1,200/mo (20%)'.
        // A two-way link has a second half for its way back, each led by an arrow.
        const half = () => {
            const el = document.createElement('span');
            el.className = 'link-half';
            const arrow = document.createElement('span');
            arrow.className = 'link-arrow';
            arrow.setAttribute('aria-hidden', 'true');
            const amount = document.createElement('span');
            const rule = document.createElement('span');
            rule.className = 'link-rule';
            el.append(arrow, amount, rule);
            return { el, arrow, amount, rule };
        };
        const front = half();
        const back = half();
        back.el.hidden = true;
        label.append(front.el, back.el);
        labelLayer.appendChild(label);
        return { g, path, flow, hit, label, amount: front.amount, rule: front.rule, front, back, sig: {} };
    }

    // The arrow along a line from `a` to `b`, by its main direction.
    const OPPOSITE = { '→': '←', '←': '→', '↓': '↑', '↑': '↓' };
    function arrowAlong(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? '→' : '←') : (dy >= 0 ? '↓' : '↑');
    }

    /** How far each link moves off the port's centre: nothing for a pair's
     *  only link, else spread evenly about it in plan order. */
    function parallelLifts(plan) {
        const pairs = new Map();
        for (const l of plan.links) {
            // Either direction: two links the opposite way round share their sides too.
            const key = l.from < l.to ? `${l.from}>${l.to}` : `${l.to}>${l.from}`;
            if (pairs.has(key)) pairs.get(key).push(l.id); else pairs.set(key, [l.id]);
        }
        const lifts = new Map();
        for (const ids of pairs.values()) {
            if (ids.length > 1) ids.forEach((id, i) => lifts.set(id, (i - (ids.length - 1) / 2) * PARALLEL_GAP));
        }
        return lifts;
    }

    // ── A link side's figure ───────────────────────────────────────────────
    // `e` is a side's results (engine.js): its flow, and the month it started
    // and stopped when it waits on a condition.

    /** How many months of the plan a side runs: from its start to its stop. */
    function sideActiveMonths(e, res) {
        if (!e || e.started === null) return 0;
        const from = e.started || 0;
        const to = e.stopped == null ? res.months : Math.min(e.stopped, res.months);
        return Math.max(0, to - from);
    }

    /** Whether a side is sent once a year, shown as a scrubbed month. */
    const yearly = (when, vp) => when === 'yearly' && !!vp && !vp.all;

    /** The dollars a side shows. Over the whole plan, its monthly average
     *  over the months it runs (not the years it waits). In a month, what it
     *  sends then, or sent once a year, the year's amount (the last 12 months). */
    function sideAmount(e, when, vp, res) {
        if (!e || !vp) return 0;
        if (vp.all) {
            const n = sideActiveMonths(e, res);
            return n ? e.total / n : 0;
        }
        if (!yearly(when, vp)) return e.flow[vp.month];
        let sum = 0;
        for (let i = Math.max(0, vp.month - 11); i <= vp.month; i++) sum += e.flow[i];
        return sum;
    }

    function renderLink(link, view, lift, frame) {
        const { res, vp, sel } = frame;
        const from = frame.byId.get(link.from);
        const to = frame.byId.get(link.to);
        if (!from || !to) return;
        // The curve is worked out again only when one of its ends moves.
        const [sa, sb] = frame.linkSide.get(link.id);
        const a = portAt(from, sa);
        const b = portAt(to, sb);
        // Parallel links spread across the sides they share.
        const lx = sa === 't' || sa === 'b' ? lift : 0;
        const ly = lx ? 0 : lift;
        put(view, 'ends', `${a.x},${a.y},${sa},${b.x},${b.y},${sb},${lift}`, () => {
            const c = curve({ x: a.x + lx, y: a.y + ly }, sa, { x: b.x + lx, y: b.y + ly }, sb);
            view.path.setAttribute('d', c.d);
            view.flow.setAttribute('d', c.d);
            view.hit.setAttribute('d', c.d);
            view.label.style.left = `${c.mid.x}px`;
            view.label.style.top = `${c.mid.y}px`;
        });

        const lr = res && res.links[link.id];
        const two = !!link.back;
        const lb = two && lr ? lr.back : null;
        // A monthly payment to a debt shows what is actually being paid: over the
        // whole plan, its last month's payment ($0 once the debt is cleared);
        // scrubbing, that month's. Never what it is set to.
        const paysDebt = D.roleOf(to) === 'debt' && link.when === 'monthly';
        const amount = paysDebt && vp && vp.all && lr ? lr.flow[res.months - 1] : sideAmount(lr, link.when, vp, res);
        const idle = !lr || (lr.total < 0.005 && !(lb && lb.total >= 0.005));
        put(view, 'idle', idle, () => {
            view.g.classList.toggle('is-idle', idle);
            view.flow.classList.toggle('is-idle', idle);
        });

        // A two-way link: which of its sides have started by the month shown
        // (none over the whole plan), its dots turning round when only the
        // way back runs. A side without a start condition has no `started`.
        // A side that has stopped (stopWhen) by then no longer runs.
        const begun = (e) => !!e && (e.started === undefined || (e.started != null && vp.month >= e.started))
            && (e.stopped == null || vp.month < e.stopped);
        const phase = !two || !vp || vp.all || !lr ? null
            : begun(lr) && begun(lb) ? 'both' : begun(lr) ? 'out' : begun(lb) ? 'back' : 'none';
        put(view, 'two', two, (v) => {
            view.g.classList.toggle('is-twoway', v);
            view.flow.classList.toggle('is-twoway', v);
            view.label.classList.toggle('is-twoway', v);
            view.back.el.hidden = !v;
        });
        put(view, 'phase', phase, (ph) => {
            view.flow.classList.toggle('is-back', ph === 'back');
            view.front.el.classList.toggle('is-live', ph === 'out' || ph === 'both');
            view.back.el.classList.toggle('is-live', ph === 'back' || ph === 'both');
        });

        // Before the first run there are no dollars yet, only the rule. The
        // half of a two-way link not running this month shows its rule.
        const setHalf = (h, key, f) => {
            put(view, `${key}-amount`, f.amount, (t) => { h.amount.textContent = t; });
            put(view, `${key}-rule`, f.rule, (t) => {
                h.rule.textContent = t ? `(${t})` : '';
                h.rule.hidden = !t;
            });
        };
        // A side that does not run in the range shown (or this month) shows its rule.
        const runs = (e) => !!e && !!vp && (vp.all ? sideActiveMonths(e, res) > 0 : begun(e));
        const figure = runs(lr) ? D.linkFigure(link, from, amount, vp.all, yearly(link.when, vp), paysDebt) : { amount: D.linkShort(link, from), rule: null };
        setHalf(view.front, 'front', figure);
        let backFig = null;
        if (two) {
            const backAmount = sideAmount(lb, link.back.when, vp, res);
            backFig = runs(lb) ? D.backFigure(link, to, backAmount, vp.all, yearly(link.back.when, vp)) : { amount: D.backShort(link, to), rule: null };
            setHalf(view.back, 'back', backFig);
            const out = arrowAlong(a, b);
            put(view, 'arrows', out, (o) => {
                view.front.arrow.textContent = o;
                view.back.arrow.textContent = OPPOSITE[o];
            });
        }
        put(view, 'short', !!(lr && (lr.short > 0.005 || (lb && lb.short > 0.005))), (v) => view.label.classList.toggle('is-short', v));
        const words = (f) => `${f.amount}${f.rule ? ` (${f.rule})` : ''}`;
        const said = two
            ? `${from.name} to ${to.name}: ${words(figure)}; and back to ${from.name}: ${words(backFig)}`
            : `${from.name} to ${to.name}: ${words(figure)}`;
        put(view, 'title', said, (t) => view.label.setAttribute('aria-label', t));

        const selected = sel && sel.kind === 'link' && sel.id === link.id;
        const related = selected || (sel && sel.kind === 'node' && (link.from === sel.id || link.to === sel.id));
        const dim = sel && sel.kind === 'node' && !related;
        put(view, 'state', `${selected}|${dim}|${related}`, () => {
            view.g.classList.toggle('is-selected', selected);
            view.label.classList.toggle('is-selected', selected);
            view.g.classList.toggle('is-dim', !!dim);
            view.label.classList.toggle('is-dim', !!dim);
            view.flow.classList.toggle('is-dim', !!dim);
            view.flow.classList.toggle('is-related', !!related);
            view.g.classList.toggle('is-active', !!related);
            view.flow.classList.toggle('is-active', !!related);
        });
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function render() {
        const { plan, results: res, selection: sel } = PlanStore.state;
        if (!plan) return;
        const frame = frameFor(plan, res, sel);

        for (const id of group) if (!frame.byId.has(id)) group.delete(id);
        const seenNodes = new Set();
        for (const node of plan.nodes) {
            seenNodes.add(node.id);
            let view = nodeViews.get(node.id);
            if (!view) {
                view = buildNode(node);
                nodeViews.set(node.id, view);
            }
            renderNode(node, view, frame);
        }
        for (const [id, view] of nodeViews) {
            if (!seenNodes.has(id)) {
                view.el.remove();
                nodeViews.delete(id);
            }
        }

        const seenLinks = new Set();
        const lifts = parallelLifts(plan);
        for (const link of plan.links) {
            seenLinks.add(link.id);
            let view = linkViews.get(link.id);
            if (!view) {
                view = buildLink(link);
                linkViews.set(link.id, view);
            }
            renderLink(link, view, lifts.get(link.id) || 0, frame);
        }
        for (const [id, view] of linkViews) {
            if (!seenLinks.has(id)) {
                view.g.remove();
                view.flow.remove();
                view.label.remove();
                linkViews.delete(id);
            }
        }

        const picked = frame.sel && frame.sel.kind === 'link' ? plan.links.find((l) => l.id === frame.sel.id) : null;
        ['from', 'to'].forEach((end, i) => {
            const h = handles[end];
            const node = picked && frame.byId.get(picked[end]);
            h.hidden = !node;
            if (!node) return;
            const at = portAt(node, frame.linkSide.get(picked.id)[i]);
            h.style.left = `${at.x}px`;
            h.style.top = `${at.y}px`;
            h.dataset.id = picked.id;
        });

        stage.classList.toggle('flow-limited', plan.links.length > FLOW_LIMIT);
        emptyEl.hidden = plan.nodes.length > 0 || dismissedEmpty.has(plan.id);
        undoBtn.disabled = !PlanStore.canUndo();
        redoBtn.disabled = !PlanStore.canRedo();

        const vp = frame.vp;
        if (vp && !vp.all) {
            timeIsland.hidden = false;
            // The month the cards show, as the issues and the pins name it.
            timeLabel.textContent = D.monthLabel(plan, vp.month);
            // The person's age that month, when the plan has one.
            const age = P.ageAt(plan, P.ymAdd(plan.settings.start, vp.month));
            timeAge.hidden = age == null;
            timeAgeLabel.textContent = age == null ? '' : String(age);
        } else {
            timeIsland.hidden = true;
        }
    }

    /** Clear every view: a different plan is about to be drawn. */
    function reset() {
        for (const v of nodeViews.values()) v.el.remove();
        for (const v of linkViews.values()) { v.g.remove(); v.flow.remove(); v.label.remove(); }
        nodeViews.clear();
        linkViews.clear();
        group.clear();
        const plan = PlanStore.state.plan;
        if (!plan) return;
        const v = plan.view;
        const untouched = !v || (v.x === 0 && v.y === 0 && v.zoom === 1);
        if (!untouched) {
            setCamera(v, { save: false });
        } else if (plan.nodes.length) {
            // A plan never panned (a fresh example, an import): frame it once
            // the stage has its size.
            requestAnimationFrame(fit);
        } else {
            setCamera(homeCamera(), { save: false });
        }
    }

    // ── Adding modules ─────────────────────────────────────────────────────

    const snap = (v) => Math.round(v / SNAP) * SNAP;

    /** A free spot near (x, y): step down-right past any card already there. */
    function freeSpot(x, y) {
        const plan = PlanStore.state.plan;
        let px = snap(x);
        let py = snap(y);
        for (let i = 0; i < 40; i++) {
            const hit = plan.nodes.some((n) => Math.abs(n.x - px) < NODE_W * 0.6 && Math.abs(n.y - py) < NODE_H * 0.6);
            if (!hit) break;
            px += 32;
            py += 32;
        }
        return { x: px, y: py };
    }

    function addAt(presetId, wx, wy) {
        const spot = freeSpot(wx - NODE_W / 2, wy - NODE_H / 2);
        const node = PlanStore.addNode(presetId, spot.x, spot.y);
        if (node) focusNode(node.id);
        return node;
    }

    function addAtCenter(presetId) {
        const r = stage.getBoundingClientRect();
        const o = openCenter();
        const c = toWorld(r.left + o.x, r.top + o.y);
        return addAt(presetId, c.x, c.y);
    }

    /** Picker of presets, optionally limited to roles a link may run into. */
    function presetGroups(roles = null) {
        return C.CATEGORIES.map((cat) => ({
            label: cat.name,
            items: C.PRESETS
                .filter((p) => p.cat === cat.id && (!roles || roles.includes(p.role)))
                .map((p) => ({ id: p.id, label: p.name, icon: p.icon, role: C.swatchOf(p), keywords: p.keywords })),
        })).filter((g) => g.items.length);
    }

    function openAddPicker(clientX, clientY, { from = null } = {}) {
        const wpt = toWorld(clientX, clientY);
        const roles = from ? P.targetRoles(from) : null;
        PlanPickers.modules({ x: clientX, y: clientY }, presetGroups(roles), {
            placeholder: from ? `Link ${from.name} to…` : 'Add a module',
            onPick: (item) => {
                const node = addAt(item.id, wpt.x + NODE_W / 2, wpt.y);
                if (node && from) PlanStore.connect(from.id, node.id);
            },
        });
    }

    function focusNode(id) {
        requestAnimationFrame(() => {
            const v = nodeViews.get(id);
            if (v) v.el.focus({ preventScroll: true });
        });
    }

    // ── Pointer input ──────────────────────────────────────────────────────

    let action = null;      // the gesture in progress
    let spaceDown = false;
    let ghost = null;

    /** Pointer capture keeps a drag alive outside the stage. It throws for a
     *  pointer that is no longer active, which is harmless here. */
    function capture(e) {
        try { stage.setPointerCapture(e.pointerId); } catch { /* inactive pointer */ }
    }

    /** The element under a point, looking through the selected flow's grip: it
     *  sits on a card's dot, and a drop there is meant for the card. */
    function elementAt(clientX, clientY) {
        return document.elementsFromPoint(clientX, clientY).find((el) => !el.closest('.link-handle')) || null;
    }

    function nodeAt(clientX, clientY) {
        const el = elementAt(clientX, clientY);
        const card = el && el.closest('.node');
        return card ? PlanStore.node(card.dataset.id) : null;
    }

    function startPan(e) {
        action = { type: 'pan', x0: e.clientX, y0: e.clientY, cam0: { ...cam }, moved: false };
        stage.classList.add('is-panning');
    }

    // The box drawn while box-selecting, in stage pixels.
    const marqueeEl = document.createElement('div');
    marqueeEl.className = 'marquee';
    marqueeEl.hidden = true;
    stage.appendChild(marqueeEl);

    function startMarquee(e) {
        const p = stagePoint(e.clientX, e.clientY);
        action = { type: 'marquee', x0: p.x, y0: p.y, moved: false, hits: [], key: '' };
    }

    /** Ids of the modules the box touches. */
    function nodesInBox(a, b) {
        const p0 = { x: (Math.min(a.x, b.x) - cam.x) / cam.zoom, y: (Math.min(a.y, b.y) - cam.y) / cam.zoom };
        const p1 = { x: (Math.max(a.x, b.x) - cam.x) / cam.zoom, y: (Math.max(a.y, b.y) - cam.y) / cam.zoom };
        return PlanStore.state.plan.nodes
            .filter((n) => n.x < p1.x && n.x + NODE_W > p0.x && n.y < p1.y && n.y + NODE_H > p0.y)
            .map((n) => n.id);
    }

    function moveMarquee(e) {
        const p = stagePoint(e.clientX, e.clientY);
        if (!action.moved && Math.abs(p.x - action.x0) + Math.abs(p.y - action.y0) < 4) return;
        action.moved = true;
        const left = Math.min(p.x, action.x0);
        const top = Math.min(p.y, action.y0);
        marqueeEl.hidden = false;
        marqueeEl.style.transform = `translate(${left}px, ${top}px)`;
        marqueeEl.style.width = `${Math.abs(p.x - action.x0)}px`;
        marqueeEl.style.height = `${Math.abs(p.y - action.y0)}px`;
        // Preview the picks on the cards; only touch them when the set changes.
        action.hits = nodesInBox({ x: action.x0, y: action.y0 }, p);
        const key = action.hits.join(',');
        if (key === action.key) return;
        action.key = key;
        const hit = new Set(action.hits);
        for (const [id, v] of nodeViews) v.el.classList.toggle('is-selected', hit.has(id));
    }

    /** One module becomes the normal selection; two or more become the group. */
    function commitMarquee(hits) {
        group.clear();
        if (hits.length === 1) {
            PlanStore.select({ kind: 'node', id: hits[0] });
        } else {
            PlanStore.select(null);
            for (const id of hits) group.add(id);
        }
        render();
    }

    // Nothing on the plane is a native drag source (no text, images or links
    // to carry off); a native drag would swallow the pointer gesture.
    stage.addEventListener('dragstart', (e) => {
        if (!e.target.closest?.('.island, .canvas-empty .plan-empty')) e.preventDefault();
    });

    stage.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.island, .canvas-empty .plan-empty')) return;
        // An open pop-up closes itself on this press (Ant's dismissal).
        stage.focus({ preventScroll: true });

        if (e.button === 1 || (e.button === 0 && spaceDown)) {
            e.preventDefault();
            startPan(e);
            capture(e);
            return;
        }
        if (e.button !== 0) return;
        // Every left-press on the plane is ours (drag, connect, box-select):
        // keep the browser from starting a text selection or a native drag of
        // one, and drop any selection left over from elsewhere.
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        // A debt's input dot is a button (who pays this?), not a drag handle.
        if (e.target.closest('.node-port--in') && e.target.closest('.node')?.dataset.role === 'debt') return;

        const port = e.target.closest('.node-port--out');
        const card = e.target.closest('.node');
        const grip = e.target.closest('.link-handle');
        const linkEl = grip ? null : e.target.closest('[data-link]');

        if (grip) {
            const link = PlanStore.link(grip.dataset.id);
            if (link && startReconnect(e, link, grip.dataset.end)) capture(e);
            return;
        }

        if (port && card) {
            const anchor = PlanStore.node(card.dataset.id);
            action = { type: 'connect', anchor, side: port.dataset.side };
            startGhost(e);
            capture(e);
            return;
        }
        if (card) {
            const node = PlanStore.node(card.dataset.id);
            // A card inside the group drags the whole group and keeps it.
            const inGroup = group.has(node.id);
            if (!inGroup) {
                group.clear();
                PlanStore.select({ kind: 'node', id: node.id });
            }
            const members = inGroup ? [...group].map(PlanStore.node).filter(Boolean) : [node];
            const w = toWorld(e.clientX, e.clientY);
            action = {
                type: 'drag', node, dx: w.x - node.x, dy: w.y - node.y, x0: e.clientX, y0: e.clientY, moved: false,
                starts: members.map((n) => ({ id: n.id, x: n.x, y: n.y })),
            };
            capture(e);
            return;
        }
        if (linkEl) {
            PlanStore.select({ kind: 'link', id: linkEl.dataset.link });
            // The line itself (not its label) can be pulled off a module: once
            // the press moves, the end nearer to it comes away.
            if (linkEl.classList.contains('link-hit')) {
                action = { type: 'grab', id: linkEl.dataset.link, x0: e.clientX, y0: e.clientY };
                capture(e);
            }
            return;
        }
        startMarquee(e);
        capture(e);
    });

    /** The end of `link` ('from' or 'to') nearer to a point on the stage. */
    function nearerEnd(link, clientX, clientY) {
        const from = PlanStore.node(link.from);
        const to = PlanStore.node(link.to);
        const [sa, sb] = linkSides(link);
        const p = toWorld(clientX, clientY);
        const a = portAt(from, sa);
        const b = portAt(to, sb);
        return Math.hypot(p.x - a.x, p.y - a.y) <= Math.hypot(p.x - b.x, p.y - b.y) ? 'from' : 'to';
    }

    /** Begin moving one end of `link`: the other end stays put and the ghost
     *  runs from it to the pointer. Returns false if the link is gone. */
    function startReconnect(e, link, end) {
        const from = PlanStore.node(link.from);
        const to = PlanStore.node(link.to);
        if (!from || !to) return false;
        const [sa, sb] = linkSides(link);
        action = end === 'from'
            ? { type: 'reconnect', link, end, anchor: to, side: sb }
            : { type: 'reconnect', link, end, anchor: from, side: sa };
        // The flow lifts off its old module while it is carried.
        const view = linkViews.get(link.id);
        if (view) for (const el of [view.g, view.flow, view.label]) el.classList.add('is-moving');
        startGhost(e);
        return true;
    }

    function startGhost(e) {
        ghost = document.createElementNS(SVG_NS, 'path');
        ghost.classList.add('link-ghost');
        svg.appendChild(ghost);
        stage.classList.add('is-linking');
        markTargets();
        moveGhost(e);
    }

    stage.addEventListener('pointermove', (e) => {
        if (!action) return;
        if (action.type === 'pan') {
            const dx = e.clientX - action.x0;
            const dy = e.clientY - action.y0;
            if (Math.abs(dx) + Math.abs(dy) > 3) action.moved = true;
            setCamera({ zoom: cam.zoom, x: action.cam0.x + dx, y: action.cam0.y + dy });
        } else if (action.type === 'drag') {
            if (!action.moved && Math.abs(e.clientX - action.x0) + Math.abs(e.clientY - action.y0) < 4) return;
            if (!action.moved) {
                action.moved = true;
                PlanStore.beginGesture();
                for (const s of action.starts) nodeViews.get(s.id)?.el.classList.add('is-dragging');
            }
            // Snap the grabbed card, then move the rest by the same distance.
            const w = toWorld(e.clientX, e.clientY);
            const lead = action.starts.find((s) => s.id === action.node.id);
            const mx = snap(w.x - action.dx) - lead.x;
            const my = snap(w.y - action.dy) - lead.y;
            PlanStore.gestureMove(() => {
                for (const s of action.starts) {
                    const n = PlanStore.node(s.id);
                    if (n) { n.x = s.x + mx; n.y = s.y + my; }
                }
            });
        } else if (action.type === 'marquee') {
            moveMarquee(e);
        } else if (action.type === 'grab') {
            if (Math.abs(e.clientX - action.x0) + Math.abs(e.clientY - action.y0) < 4) return;
            const link = PlanStore.link(action.id);
            const end = link && nearerEnd(link, action.x0, action.y0);
            action = null;
            if (link) startReconnect(e, link, end);
        } else if (action.type === 'connect' || action.type === 'reconnect') {
            moveGhost(e);
        }
    });

    function endAction(e) {
        if (!action) return;
        const a = action;
        action = null;
        stage.classList.remove('is-panning');
        if (a.type === 'marquee') {
            marqueeEl.hidden = true;
            if (!a.moved) {
                group.clear();
                PlanStore.select(null);
                render();
            } else if (e.type === 'pointerup') {
                commitMarquee(a.hits);
            } else {
                render();
            }
        }
        if (a.type === 'drag') {
            for (const s of a.starts) nodeViews.get(s.id)?.el.classList.remove('is-dragging');
            if (a.moved) PlanStore.endGesture();
        }
        if (a.type === 'connect' || a.type === 'reconnect') {
            // Read the drop before the drag's look is taken down: the enlarged dots
            // (which reach past the card's edge) are part of the card being shown
            // as the target, so a release on one lands on that card.
            const drop = e.type === 'pointerup' ? readDrop(e, a) : null;
            clearTargets();
            stage.classList.remove('is-linking');
            if (ghost) { ghost.remove(); ghost = null; }
            if (a.type === 'reconnect') {
                const view = linkViews.get(a.link.id);
                if (view) for (const el of [view.g, view.flow, view.label]) el.classList.remove('is-moving');
            }
            if (drop) (a.type === 'connect' ? dropLink : dropMovedLink)(e, a, drop);
        }
    }

    /** What a link drag was released over: the module (if any), the dot of it,
     *  and the element under the pointer. */
    function readDrop(e, a) {
        const target = nodeAt(e.clientX, e.clientY);
        const valid = target && target.id !== a.anchor.id;
        return {
            target: valid ? target : null,
            onSelf: !!target && !valid,
            side: valid ? dropSide(e, target, portAt(a.anchor, a.side)) : null,
            under: elementAt(e.clientX, e.clientY),
        };
    }

    function dropLink(e, a, { target, onSelf, side, under }) {
        if (target) {
            const ok = P.canConnect(PlanStore.state.plan, a.anchor.id, target.id);
            if (ok.ok) PlanStore.connect(a.anchor.id, target.id, null, { fromSide: a.side, toSide: side });
            else refuse(ok.reason, a.anchor, target);
        } else if (!onSelf && under && stage.contains(under) && !under.closest('.island')) {
            openAddPicker(e.clientX, e.clientY, { from: a.anchor });
        }
    }

    /** Dropped on a module: that end moves onto it, at the dot it was dropped
     *  on. Dropped on nothing, the flow stays as it was. */
    function dropMovedLink(e, a, { target, side }) {
        if (!target) return;
        const { link, end } = a;
        if (target.id === link[end] && side === linkSides(link)[end === 'from' ? 0 : 1]) return;   // put back where it was
        const r = PlanStore.reconnect(link.id, target.id, side, end);
        if (r.ok) return;
        // Moving the sending end, the module dropped on is the one that would send.
        if (end === 'from') refuse(r.reason, target, a.anchor);
        else refuse(r.reason, a.anchor, target);
    }
    stage.addEventListener('pointerup', endAction);
    stage.addEventListener('pointercancel', endAction);

    /** Tell the user why a link was refused. */
    function refuse(reason, from, target) {
        if (!P.basesFor(from).length) planNotice(`${from.name} sends no money on.`);
        else if (reason === 'duplicate') planNotice('Those modules are already linked every way they can be.');
        else if (reason === 'role') planNotice(linkRuleText(D.roleOf(from), D.roleOf(target)));
        else if (reason === 'basis') planNotice(targetRuleText(from));
    }

    /** The dot of `target` a drop lands on: the one under the pointer, else the
     *  side of the card that faces `origin` (the dot the flow comes from). */
    function dropSide(e, target, origin) {
        const under = elementAt(e.clientX, e.clientY);
        const dot = under && under.closest('.node-port');
        if (dot) return dot.dataset.side;
        return sideToward(origin.x - (target.x + NODE_W / 2), origin.y - (target.y + NODE_H / 2));
    }

    const PLURAL = { source: 'income', account: 'accounts', expense: 'spending', debt: 'debts', modifier: 'modifiers' };

    /** Roles as a list in words: 'debts', 'accounts and debts', 'a, b and c'. */
    function rolesInWords(roles) {
        const words = roles.map((r) => PLURAL[r]);
        return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
    }

    /** Why a link was refused, as what IS allowed. */
    function linkRuleText(fromRole, toRole) {
        if (toRole === 'source') return 'Income has no input.';
        return `${C.ROLES[fromRole].label} links only to ${rolesInWords(C.LINK_TARGETS[fromRole])}.`;
    }

    /** Why a module refused a link, as what it can reach. */
    function targetRuleText(from) {
        return `${from.name} sends only to ${rolesInWords(P.targetRoles(from))}.`;
    }

    /** Whether the link drag in progress may land on module `id`. A flow being
     *  moved may stay on the module it already touches (to change dot). */
    function canLand(id) {
        const plan = PlanStore.state.plan;
        if (action.type === 'connect') return P.canConnect(plan, action.anchor.id, id).ok;
        const { link, end } = action;
        if (id === link[end]) return true;
        return end === 'from' ? P.canConnect(plan, id, link.to).ok : P.canConnect(plan, link.from, id).ok;
    }

    function moveGhost(e) {
        const a = portAt(action.anchor, action.side);
        const target = nodeAt(e.clientX, e.clientY);
        const valid = target && target.id !== action.anchor.id && canLand(target.id);
        let b;
        let sb;
        if (valid) {
            // Lands on the dot it would be dropped on.
            sb = dropSide(e, target, a);
            b = portAt(target, sb);
        } else {
            b = toWorld(e.clientX, e.clientY);
            sb = sideToward(a.x - b.x, a.y - b.y);
        }
        ghost.setAttribute('d', curve(a, action.side, b, sb).d);
        for (const [id, v] of nodeViews) v.el.classList.toggle('is-target', !!valid && id === target.id);
    }

    /** Dim every module the link drag in progress cannot land on. */
    function markTargets() {
        for (const [id, v] of nodeViews) {
            if (id === action.anchor.id) continue;
            v.el.classList.toggle('is-dim', !canLand(id));
        }
    }

    function clearTargets() {
        for (const v of nodeViews.values()) v.el.classList.remove('is-dim', 'is-target');
    }

    stage.addEventListener('dblclick', (e) => {
        if (e.target.closest('.node, [data-link], .island, .canvas-empty')) return;
        openAddPicker(e.clientX, e.clientY);
    });

    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const s = stagePoint(e.clientX, e.clientY);
        if (e.ctrlKey || e.metaKey) {
            zoomAt(Math.exp(-e.deltaY * 0.0025), s.x, s.y);
        } else {
            const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
            const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
            setCamera({ zoom: cam.zoom, x: cam.x - dx, y: cam.y - dy });
        }
    }, { passive: false });

    // The dot a debt is paid through.
    stage.addEventListener('click', (e) => {
        const card = e.target.closest('.node');
        if (!card) return;
        const node = PlanStore.node(card.dataset.id);
        if (!node) return;
        const plan = PlanStore.state.plan;
        if (e.target.closest('.node-port--in') && D.roleOf(node) === 'debt') {
            const payers = plan.nodes.filter((n) => ['source', 'account'].includes(D.roleOf(n)) && P.canConnect(plan, n.id, node.id).ok);
            Ant.dropdown(e.target.closest('.node-port--in'), {
                items: payers.length
                    ? payers.map((n) => ({ label: `Pay from ${n.name}`, iconHtml: planIcon(P.iconOf(n)), onClick: () => PlanStore.connect(n.id, node.id) }))
                    : [{ label: 'No account to pay from yet', disabled: true }],
            });
        }
    });

    stage.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const card = e.target.closest('.node');
        const linkEl = e.target.closest('[data-link]');
        const at = { x: e.clientX, y: e.clientY };
        if (card) {
            const id = card.dataset.id;
            PlanStore.select({ kind: 'node', id });
            Ant.dropdown(at, { items: [
                { label: 'Link to…', iconHtml: planIcon('flow-arrow'), onClick: () => openAddPicker(e.clientX + 24, e.clientY, { from: PlanStore.node(id) }) },
                { label: 'Duplicate', iconHtml: planIcon('copy'), onClick: () => PlanStore.duplicateNode(id) },
                { type: 'divider' },
                { label: 'Delete', iconHtml: planIcon('trash'), danger: true, onClick: () => removeNode(id) },
            ] });
        } else if (linkEl) {
            const id = linkEl.dataset.link;
            PlanStore.select({ kind: 'link', id });
            Ant.dropdown(at, { items: [{ label: 'Delete flow', iconHtml: planIcon('trash'), danger: true, onClick: () => PlanStore.removeLink(id) }] });
        } else if (!e.target.closest('.island')) {
            Ant.dropdown(at, { items: [
                { label: 'Add module here…', iconHtml: planIcon('plus'), onClick: () => openAddPicker(e.clientX, e.clientY) },
                { label: 'Fit to view', iconHtml: planIcon('corners-out'), onClick: fit },
            ] });
        }
    });

    // ── Library drops ──────────────────────────────────────────────────────

    const PRESET_TYPE = 'application/x-citrine-preset';
    stage.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes(PRESET_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        stage.classList.add('is-drop-target');
    });
    stage.addEventListener('dragleave', (e) => {
        if (!stage.contains(e.relatedTarget)) stage.classList.remove('is-drop-target');
    });
    stage.addEventListener('drop', (e) => {
        stage.classList.remove('is-drop-target');
        const id = e.dataTransfer.getData(PRESET_TYPE);
        if (!id || !C.preset(id)) return;
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        const node = PlanStore.addNode(id, snap(w.x - NODE_W / 2), snap(w.y - NODE_H / 2));
        if (node) focusNode(node.id);
    });

    // ── Keyboard ───────────────────────────────────────────────────────────

    function removeNode(id) {
        const node = PlanStore.node(id);
        if (!node) return;
        const name = node.name;
        PlanStore.removeNode(id);
        planNotice(`Deleted ${name}.`, { action: { label: 'Undo', onClick: () => PlanStore.undo() } });
        stage.focus({ preventScroll: true });
    }

    function removeGroup() {
        const ids = [...group];
        group.clear();
        PlanStore.removeNodes(ids);
        planNotice(`Deleted ${ids.length} modules.`, { action: { label: 'Undo', onClick: () => PlanStore.undo() } });
        stage.focus({ preventScroll: true });
    }

    function deleteSelection() {
        if (group.size) { removeGroup(); return; }
        const s = PlanStore.state.selection;
        if (!s) return;
        if (s.kind === 'node') removeNode(s.id);
        else if (s.kind === 'link') PlanStore.removeLink(s.id);
    }

    // Copied modules live here, so they paste into any open plan.
    let clipboard = null;
    let pasteCount = 0;

    function selectedNodeIds() {
        if (group.size) return [...group];
        const s = PlanStore.state.selection;
        return s && s.kind === 'node' ? [s.id] : [];
    }

    function copySelection() {
        const copied = PlanStore.copyNodes(selectedNodeIds());
        if (!copied) return false;
        clipboard = copied;
        pasteCount = 0;
        planNotice(copied.nodes.length === 1 ? `Copied ${copied.nodes[0].name}.` : `Copied ${copied.nodes.length} modules.`);
        return true;
    }

    function pasteClipboard() {
        if (!clipboard) return;
        const made = PlanStore.pasteNodes(clipboard, 32 * ++pasteCount);
        if (!made.length) return;
        group.clear();
        if (made.length === 1) {
            PlanStore.select({ kind: 'node', id: made[0] });
        } else {
            PlanStore.select(null);
            for (const id of made) group.add(id);
        }
        render();
        stage.focus({ preventScroll: true });
    }

    stage.addEventListener('keydown', (e) => {
        if (e.target.closest('input, select, textarea')) return;
        const s = PlanStore.state.selection;
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'c' || k === 'x') {
                e.preventDefault();
                if (copySelection() && k === 'x') deleteSelection();
                return;
            }
            if (k === 'v') {
                e.preventDefault();
                pasteClipboard();
                return;
            }
        }
        if (e.key === ' ' && !e.repeat) {
            spaceDown = true;
            stage.classList.add('is-space');
            e.preventDefault();
            return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteSelection();
        } else if (e.key === 'Escape') {
            group.clear();
            PlanStore.select(null);
            render();
        } else if (e.key === 'Enter' && e.target.classList.contains('node')) {
            PlanStore.select({ kind: 'node', id: e.target.dataset.id });
        } else if (s && s.kind === 'node' && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const step = e.shiftKey ? 32 : SNAP;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            PlanStore.edit((plan) => {
                const n = plan.nodes.find((x) => x.id === s.id);
                n.x += d[0];
                n.y += d[1];
            }, { key: `nudge:${s.id}` });
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && s && s.kind === 'node') {
            e.preventDefault();
            PlanStore.duplicateNode(s.id);
        } else if (e.key === '+' || e.key === '=') {
            zoomCenter(1.2);
        } else if (e.key === '-') {
            zoomCenter(1 / 1.2);
        }
    });
    stage.addEventListener('keyup', (e) => {
        if (e.key === ' ') {
            spaceDown = false;
            stage.classList.remove('is-space');
        }
    });
    stage.addEventListener('focusin', (e) => {
        const card = e.target.closest && e.target.closest('.node');
        if (card && e.target === card && !action) PlanStore.select({ kind: 'node', id: card.dataset.id });
    });

    // ── Islands ────────────────────────────────────────────────────────────

    stage.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const r = stage.getBoundingClientRect();
        switch (btn.dataset.act) {
            case 'undo': PlanStore.undo(); break;
            case 'redo': PlanStore.redo(); break;
            case 'fit': fit(); break;
            case 'zoom-in': zoomCenter(1.2); break;
            case 'zoom-out': zoomCenter(1 / 1.2); break;
            case 'zoom-reset': zoomCenter(1 / cam.zoom); break;
            case 'add': openAddPicker(r.left + openCenter().x - 140, r.top + openArea().top + 80); break;
            case 'inspector': Inspector.toggle(); btn.setAttribute('aria-pressed', String(Inspector.isOpen())); break;
            case 'example': loadExample(); break;
            case 'dismiss-empty': {
                const plan = PlanStore.state.plan;
                if (plan) dismissedEmpty.add(plan.id);
                emptyEl.hidden = true;
                break;
            }
            default: break;
        }
    });

    function loadExample() {
        PlanStore.edit((plan) => { PlanExample.fill(plan); });
        requestAnimationFrame(fit);
    }

    // ── PlanStore wiring ───────────────────────────────────────────────────────

    let lastPlanId = null;
    PlanStore.on((c) => {
        if (c.type === 'plan' || c.type === 'tabs') {
            const plan = PlanStore.state.plan;
            if (plan && plan.id !== lastPlanId) {
                lastPlanId = plan.id;
                reset();
            }
            render();
        } else if (c.type === 'results' || c.type === 'selection' || c.type === 'scrub') {
            // Picking anything else (a card, a link, the inspector) ends the group.
            if (c.type === 'selection' && PlanStore.state.selection) group.clear();
            // Picking a goal opens the inspector from outside this toolbar.
            if (c.type === 'selection') inspectorBtn.setAttribute('aria-pressed', String(Inspector.isOpen()));
            render();
        }
    });

    window.Canvas = { addAtCenter, fit, render };
}());
