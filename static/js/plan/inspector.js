'use strict';

// ─── inspector.js ───────────────────────────────────────────────────────────
// The right-hand panel. It edits the selection:
//
//   a module   its name, its settings (the fields its preset shows), where its
//              money goes and comes from, its outlook and its issues
//   a link     its rule, as a sentence and as controls: from what, how much,
//              when, and an optional window
//   nothing    the plan: name, start, age, issues
//
// It shows only in the plan builder (the Plans workspace); the others have
// the room to themselves.
//
// Controls are bound to the plan through `binds`: each has a get and a set,
// and every change goes through PlanStore.edit, so it is undoable and saved. The
// panel is rebuilt only when the selection (or a field that changes which
// fields exist) changes; otherwise values are synced in place, skipping the
// control being typed in.

(function () {
    const C = window.PlanCatalog;
    const P = window.PlanModel;
    const D = window.Describe;

    const root = document.getElementById('inspector');
    if (!root) return;

    const OPEN_KEY = 'inspector-open';
    let isOpenState = PlanPrefs.get(OPEN_KEY) !== '0';

    let built = null;           // what the panel shows: 'plan' | 'preset:<id>' | 'node:<id>' | 'link:<id>' | 'none'
    let builtSig = '';          // structureSig() of the built panel
    let binds = new Map();      // data-bind key → { type, get, set, ... }
    let statsEl = null;
    let issuesEl = null;

    // ── Helpers ────────────────────────────────────────────────────────────

    const esc = escapeHtml;
    const plan = () => PlanStore.state.plan;
    const results = () => PlanStore.state.results;

    function section(title, body) {
        return `<section class="insp-section"><p class="eyebrow">${esc(title)}</p>${body}</section>`;
    }

    // Foldable sections the user has opened or shut, by id ({ settings: false }),
    // kept across modules and visits; the rest show their default.
    const FOLD_KEY = 'inspector-folds';
    const folds = (() => {
        try {
            const v = JSON.parse(PlanPrefs.get(FOLD_KEY, '{}'));
            return v && typeof v === 'object' ? v : {};
        } catch {
            return {};
        }
    })();

    /** A section whose heading is a caret button that folds its body away. */
    function foldSection(id, title, body, { open: byDefault = false } = {}) {
        const open = typeof folds[id] === 'boolean' ? folds[id] : byDefault;
        return `<section class="insp-section insp-section--fold">
            <button class="insp-fold eyebrow" type="button" data-fold="${esc(id)}" aria-expanded="${open}">
                ${planIcon('caret-down', { cls: 'insp-fold-caret' })}<span>${esc(title)}</span></button>
            <div class="insp-fold-body"${open ? '' : ' hidden'}>${body}</div>
        </section>`;
    }

    function row(label, control, { id, wide = false } = {}) {
        const w = wide ? ' insp-label--wide' : '';
        return `<label class="insp-label${w}" ${id ? `for="${id}"` : ''}>${esc(label)}</label><div class="insp-control${wide ? ' insp-control--wide' : ''}">${control}</div>`;
    }

    let uid = 0;
    const nextId = () => `insp-${++uid}`;

    /** Register a binding and return its control's HTML. */
    function bind(key, spec) {
        binds.set(key, spec);
        const id = nextId();
        const sym = Fmt.symbolParts();
        const attrs = `id="${id}" data-bind="${esc(key)}" autocomplete="off" spellcheck="false"`;
        let html;
        switch (spec.type) {
            case 'money': {
                const input = `<input class="field-input" type="text" inputmode="decimal" ${attrs}
                    ${spec.optional ? 'placeholder="None"' : ''}>`;
                html = `<span class="field-affix">${sym.suffix ? input : `<span class="field-affix-text">${esc(sym.symbol)}</span>${input}`}${sym.suffix ? `<span class="field-affix-text">${esc(sym.symbol)}</span>` : ''}</span>`;
                break;
            }
            case 'percent':
                html = `<span class="field-affix"><input class="field-input" type="text" inputmode="decimal" ${attrs}>
                    <span class="field-affix-text">%${spec.suffix ? esc(spec.suffix) : ''}</span></span>`;
                break;
            case 'number': {
                const input = `<input class="field-input" type="text" inputmode="${spec.decimals ? 'decimal' : 'numeric'}" ${attrs}
                    ${spec.optional ? 'placeholder="None"' : ''}>`;
                html = spec.suffix ? `<span class="field-affix">${input}<span class="field-affix-text">${esc(spec.suffix)}</span></span>` : input;
                break;
            }
            case 'text':
                html = `<input class="${spec.className || 'field-input'}" type="text" maxlength="${P.LIMITS.name}" ${attrs}>`;
                break;
            case 'select':
                html = `<select class="field-select" ${attrs}>${spec.options.map(([v, l]) =>
                    `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
                break;
            case 'yearmonth':
                html = `<button class="field-input field-month" type="button" id="${id}" data-bind="${esc(key)}" data-month aria-haspopup="dialog">
                    <span></span>${planIcon('calendar-blank')}</button>`;
                break;
            default:
                throw new Error(`unknown bind type ${spec.type}`);
        }
        return { id, html };
    }

    function field(label, key, spec) {
        const b = bind(key, spec);
        return row(label, b.html, { id: b.id });
    }

    function display(spec, v) {
        if (spec.type === 'money') return v == null ? '' : Fmt.inputValue(v);
        if (spec.type === 'percent' || spec.type === 'number') return v == null ? '' : Fmt.number(v, 4);
        if (spec.type === 'select') return String(v);
        return v == null ? '' : String(v);
    }

    /** Push model values into every control except the one being edited. */
    function sync() {
        if (!plan()) return;
        for (const el of root.querySelectorAll('[data-bind]')) {
            const spec = binds.get(el.dataset.bind);
            if (!spec) continue;
            if (spec.type === 'yearmonth') {
                const v = spec.get();
                el.firstElementChild.textContent = v ? P.ymLabel(v) : (spec.empty || 'None');
                el.classList.toggle('is-empty', !v);
                continue;
            }
            if (el === document.activeElement) continue;
            const v = display(spec, spec.get());
            if (el.value !== v) el.value = v;
            el.removeAttribute('aria-invalid');
        }
        const iconTile = root.querySelector('[data-act="node-icon"]');
        const shown = iconTile && PlanStore.node(built.slice(5));
        if (shown && iconTile.dataset.icon !== P.iconOf(shown)) {
            iconTile.dataset.icon = P.iconOf(shown);
            iconTile.innerHTML = planIcon(P.iconOf(shown));
        }
        const sentence = root.querySelector('[data-sentence]');
        if (sentence) {
            const l = PlanStore.link(built.slice(5));
            if (l) sentence.innerHTML = D.linkSentence(l, PlanStore.node(l.from), PlanStore.node(l.to));
            for (const el of root.querySelectorAll('[data-cond-at]')) {
                const [which, key] = el.dataset.condAt.split(':');
                const side = l && (key === 'back' ? l.back : l);
                if (side) el.textContent = startsLabel(plan(), side[COND[which].prop]);
            }
        }
    }

    function commit(el, final) {
        const key = el.dataset.bind;
        const spec = binds.get(key);
        if (!spec) return;
        let v;
        if (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number') {
            const raw = el.value.trim();
            if (!raw && spec.optional) v = null;
            else {
                v = Fmt.parseNumber(raw);
                if (!Number.isFinite(v)) {
                    el.setAttribute('aria-invalid', 'true');
                    return;
                }
                v = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
                if (spec.type === 'number' && !spec.decimals) v = Math.round(v);
            }
        } else if (spec.type === 'text') {
            // eslint-disable-next-line no-control-regex
            v = el.value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, P.LIMITS.name);
            if (!v.trim()) {
                if (!final) return;
                v = spec.fallback();
            }
        } else if (spec.type === 'select') {
            v = spec.numeric ? Number(el.value) : el.value;
        } else {
            return;
        }
        el.removeAttribute('aria-invalid');
        const before = spec.get();
        if (before === v && !final) return;
        apply(spec, v, `${built}:${key}`);
        if (final) {
            const shown = display(spec, spec.get());
            if (el.value !== shown && spec.type !== 'text') el.value = shown;
        }
        if (spec.rebuild) rebuild();
    }

    /** Write a control's value into the plan. */
    function apply(spec, v, key = null) {
        PlanStore.edit((p) => spec.set(p, v), { key });
    }

    function rebuild() {
        const focusKey = document.activeElement && root.contains(document.activeElement)
            ? document.activeElement.dataset.bind : null;
        built = null;
        render();
        if (focusKey) root.querySelector(`[data-bind="${CSS.escape(focusKey)}"]`)?.focus();
    }

    /** A labelled figure. `dir` colours it: 'up', 'down' or 'warn'. A wide one
     *  takes the whole row. */
    function stat(label, value, dir = '', { wide = false } = {}) {
        return `<div${wide ? ' class="stat-wide"' : ''}><div class="stat-label">${esc(label)}</div><div class="stat-value${dir ? ` is-${dir}` : ''}">${esc(value)}</div></div>`;
    }

    const total = (arr) => (arr ? arr.reduce((a, b) => a + b, 0) : 0);
    const money = (v, o) => Fmt.money(v, o);

    const MAX_ISSUES = 8;

    function issuesHtml(all) {
        if (!all.length) return '';
        const list = all.slice(0, MAX_ISSUES);
        const more = all.length - list.length;
        return section('Issues', `<ul class="issues">${list.map((w) => {
            const d = D.warning(w, plan());
            const cls = d.level === 'warn' ? 'issue' : `issue issue--${d.level}`;
            const body = `${planIcon(d.level === 'warn' ? 'warning' : 'info')}<span>${esc(d.text)}</span>`;
            // One that points somewhere is a button that selects it.
            return d.select
                ? `<li><button type="button" class="${cls}" data-select="${d.select.kind}:${esc(d.select.id)}">${body}</button></li>`
                : `<li class="${cls}">${body}</li>`;
        }).join('')}${more > 0 ? `<li class="insp-none">${more} more</li>` : ''}</ul>`);
    }

    // ── Plan panel ─────────────────────────────────────────────────────────

    function planPanel() {
        const nameB = bind('plan.name', {
            type: 'text', className: 'insp-name insp-name--plan',
            get: () => plan().name,
            set: (pl, v) => { pl.name = v; },
            fallback: () => 'Untitled plan',
        });
        // The age is the person the plan is for, at its start: it dates a goal
        // that is due at an age and an income that stops at one, and labels
        // the charts. The retirement age is one age that incomes may stop
        // at and links may start at, so one edit moves them all.
        const settings = `<div class="insp-fields">
            ${field('Starts', 'plan.start', {
                type: 'yearmonth',
                get: () => plan().settings.start,
                set: (pl, v) => { if (v) pl.settings.start = v; },
            })}
            ${field('Your age', 'plan.age', {
                type: 'number', min: 0, max: P.GOAL_AGE.max, suffix: 'yrs', decimals: true, optional: true,
                get: () => plan().settings.age,
                set: (pl, v) => { pl.settings.age = v; },
            })}
            ${field('Retirement age', 'plan.retireAge', {
                type: 'number', min: P.GOAL_AGE.min, max: P.GOAL_AGE.max, suffix: 'yrs', decimals: true, optional: true,
                get: () => plan().settings.retireAge,
                set: (pl, v) => { pl.settings.retireAge = v; },
            })}
        </div>`;
        return `
            <div class="insp-header">
                <div class="insp-titles">${nameB.html}</div>
            </div>
            ${section('Timeline', settings)}
            <div data-stats></div>`;
    }

    function planStats() {
        const r = results();
        return r ? issuesHtml(r.warnings) : '';
    }

    // ── Node panel ─────────────────────────────────────────────────────────

    // What a blank date field means, shown in the field itself.
    const EMPTY_MONTH = {
        start: (p) => (p.role === 'debt' ? 'Already owed' : 'Plan start'),
        end: () => 'No end',
        lockUntil: () => 'Not locked',
    };

    function paramSpec(node, key) {
        const p = C.preset(node.type);
        const f = C.FIELDS[key];
        const id = node.id;
        const base = {
            get: () => (PlanStore.node(id) || node).params[key],
            set: (pl, v) => { pl.nodes.find((n) => n.id === id).params[key] = v; },
            optional: !!f.optional,
            min: f.min, max: f.max,
        };
        switch (f.type) {
            case 'money': return { ...base, type: 'money' };
            case 'percent': return { ...base, type: 'percent', suffix: f.suffix };
            case 'number': return { ...base, type: 'number', suffix: f.suffix, decimals: true };
            case 'choice': return { ...base, type: 'select', options: f.options, rebuild: true };
            case 'month': return {
                ...base, type: 'select', numeric: true,
                options: [['0', 'Spread monthly'], ...P.MONTHS.map((m, i) => [String(i + 1), m])],
            };
            case 'yearmonth': return { ...base, type: 'yearmonth', empty: EMPTY_MONTH[key](p) };
            case 'account': return {
                // A target that is gone reads as the default; the plan clears it on save.
                ...base, type: 'select',
                options: [['', 'Card balance'], ...plan().nodes.filter((n) => D.roleOf(n) === 'account').map((n) => [n.id, n.name])],
                get: () => {
                    const v = (PlanStore.node(id) || node).params[key];
                    const to = v && PlanStore.node(v);
                    return to && D.roleOf(to) === 'account' ? v : '';
                },
                set: (pl, v) => { pl.nodes.find((n) => n.id === id).params[key] = v || null; },
            };
            default: throw new Error(`unknown field ${key} on ${p.id}`);
        }
    }

    /** Which of a preset's fields apply right now (some depend on others). */
    function visibleFields(node) {
        const p = C.preset(node.type);
        const per = node.params.per;
        // An expense's schedule matters only once it has a cost; a one-off cost
        // does not inflate.
        const costless = p.role === 'expense' && node.params.cost == null;
        return C.fieldsFor(p).filter((k) => {
            if (costless) return k === 'cost';
            if ((k === 'growth' || k === 'end') && p.role === 'expense') return per !== 'once';
            if (k === 'payMonth') return per === 'year';
            if (k === 'cashBackTo') return node.params.cashBack > 0;
            // An income's stop shows the date or the age it asks for.
            if (k === 'end' && p.role === 'source') return node.params.stopBy === 'date';
            if (k === 'endAge') return node.params.stopBy === 'age';
            return true;
        });
    }

    function labelFor(node, key) {
        const p = C.preset(node.type);
        if (key === 'start' && node.params.per === 'once') return 'Date';
        return C.fieldLabel(p, key);
    }

    /** What a link moves a month: the plan's average, or the scrubbed month. */
    function flowText(linkId) {
        const r = results();
        const lr = r && r.links[linkId];
        if (!lr) return '';
        const scrub = PlanStore.state.scrub;
        const amount = scrub == null ? lr.avg : lr.flow[Math.max(0, scrub - 1)];
        return `${money(amount)}/mo`;
    }

    /** The Settings section: a control for each field the module shows now. */
    function settingsSection(node) {
        const keys = visibleFields(node);
        if (!keys.length) return '';
        const fields = keys.map((k) => field(labelFor(node, k), `param.${k}`, paramSpec(node, k))).join('');
        return foldSection('settings', 'Settings', `<div class="insp-fields">${fields}</div>`, { open: true });
    }

    /** One row in Outflows / Inflows: the module at the other end, the
     *  money moving along the link, and the link's rule. */
    function linkRow(l, other) {
        const r = results() && results().links[l.id];
        const short = r && r.short > 0.005;
        return `<li><button class="insp-link" type="button" data-select="link:${esc(l.id)}">
            <span class="role-tile role-tile--sm" data-role="${D.swatchOf(other)}">${planIcon(P.iconOf(other))}</span>
            <span class="insp-link-text">
                <span class="insp-link-name">${esc(other.name)}</span>
                <span class="insp-link-amount" data-flow="${esc(l.id)}">${esc(flowText(l.id))}</span>
            </span>
            <span class="chip${short ? ' chip--warn' : ''}">${esc(D.linkShort(l, PlanStore.node(l.from)))}</span>
            ${planIcon('caret-right', { cls: 'icon-caret' })}
        </button></li>`;
    }

    /** The tag under a module's name: the kind of module it is ('Bank account'). */
    function typeTag(p) {
        return `<div class="insp-tags"><span class="ant-tag plan-tag"><span>${esc(p.name)}</span></span></div>`;
    }

    function nodePanel(node) {
        const p = C.preset(node.type);
        const role = p.role;
        const swatch = C.swatchOf(p);
        const id = node.id;
        const nameB = bind('node.name', {
            type: 'text', className: 'insp-name',
            get: () => (PlanStore.node(id) || node).name,
            set: (pl, v) => { pl.nodes.find((n) => n.id === id).name = v; },
            fallback: () => p.name,
        });

        const outs = plan().links.filter((l) => l.from === id);
        const ins = plan().links.filter((l) => l.to === id);
        const sends = P.basesFor(node).length ? foldSection('outflows', 'Outflows',
            outs.length
                ? `<ul class="insp-links">${outs.map((l) => linkRow(l, PlanStore.node(l.to))).join('')}</ul>`
                : '<p class="insp-none">No links yet</p>') : '';
        const receives = C.ROLES[role].hasIn ? foldSection('inflows', 'Inflows',
            ins.length
                ? `<ul class="insp-links">${ins.map((l) => linkRow(l, PlanStore.node(l.from))).join('')}</ul>`
                : '<p class="insp-none">Nothing links here yet</p>') : '';

        return `
            <div class="insp-card" data-role="${swatch}">
            <div class="insp-header">
                <button class="role-tile role-tile--lg role-tile--button" type="button" data-act="node-icon" data-role="${swatch}"
                    data-icon="${esc(P.iconOf(node))}" aria-haspopup="dialog" aria-label="Change icon" title="Change icon">${planIcon(P.iconOf(node))}</button>
                <div class="insp-titles">${nameB.html}${typeTag(p)}</div>
            </div>
            ${settingsSection(node)}
            </div>
            <div data-issues></div>
            ${receives}${sends}
            <div data-stats></div>`;
    }

    /** A library module before it is added: its starting settings, read-only. */
    function presetPanel(presetId) {
        const p = C.preset(presetId);
        const swatch = C.swatchOf(p);
        const node = P.createNode(plan(), presetId, 0, 0);
        const icon = PlanStore.state.previewIcon || p.icon;
        return `
            <div class="insp-card" data-role="${swatch}">
            <div class="insp-header">
                <button class="role-tile role-tile--lg role-tile--button" type="button" data-act="preview-icon" data-role="${swatch}"
                    aria-haspopup="dialog" aria-label="Change icon" title="Change icon">${planIcon(icon)}</button>
                <div class="insp-titles"><div class="insp-name">${esc(p.name)}</div>${typeTag(p)}</div>
            </div>
            ${settingsSection(node)}
            </div>`;
    }

    function nodeStats(node) {
        const r = results();
        const nr = r && r.nodes[node.id];
        if (!nr) return '';
        const role = D.roleOf(node);
        const kind = C.preset(node.type).kind;
        const m = r.months;
        let stats = '';
        if (role === 'account') {
            const end = nr.balance[m];
            stats = stat('Balance at end', money(end), end < -0.005 ? 'down' : '')
                + stat('Change', money(end - nr.balance[0], { sign: true }), end >= nr.balance[0] ? 'up' : 'down')
                + stat('Deposits', money(nr.totals.in))
                + (nr.totals.matched > 0.5 ? stat('Employer match', money(nr.totals.matched), 'up') : '')
                + stat('Growth', money(nr.totals.earnings))
                + (nr.totals.out > 0.5 ? stat('Sent on', money(nr.totals.out)) : '');
        } else if (role === 'debt') {
            const paidOff = r.milestones.find((x) => x.code === 'paid-off' && x.nodeId === node.id);
            stats = stat('Owed at end', money(nr.balance[m]), nr.balance[m] > 0.5 ? 'down' : '')
                + stat('Paid off', paidOff ? D.monthLabel(plan(), paidOff.month) : 'Not in this plan')
                + stat('Paid', money(nr.totals.paid))
                + stat('Interest', money(nr.totals.interest));
            if (nr.assetValue) {
                const value = nr.assetValue[m];
                const equity = value - nr.balance[m];
                stats += stat('Asset value at end', money(value))
                    + stat(nr.totals.assetGrowth >= 0 ? 'Appreciation' : 'Depreciation', money(Math.abs(nr.totals.assetGrowth)),
                        nr.totals.assetGrowth >= 0 ? 'up' : 'down')
                    + stat('Equity at end', money(equity), equity < -0.5 ? 'down' : 'up');
            }
            if (kind === 'card') {
                const net = nr.totals.cashback - nr.totals.fees;
                stats += (node.params.limit > 0 ? stat('Credit limit', money(node.params.limit)) : '')
                    + stat('Spent on card', money(nr.totals.charged))
                    + stat('Cash back', money(nr.totals.cashback))
                    + (nr.totals.fees > 0.5 ? stat('Annual fees', money(nr.totals.fees)) : '')
                    + (nr.totals.cashback + nr.totals.fees > 0.5
                        ? stat(net >= 0 ? 'Rewards after fees' : 'Fees beyond rewards', money(Math.abs(net)), net >= 0 ? 'up' : 'down') : '');
            }
        } else if (role === 'source') {
            const gross = total(nr.gross);
            const pretax = nr.totals.pretax;
            const takeHome = nr.totals.produced - pretax;
            stats = stat('Earned', money(gross))
                + (pretax > 0.5 ? stat('Before tax', money(pretax)) : '')
                + (gross - nr.totals.produced > 0.5 ? stat('Withheld', money(gross - nr.totals.produced)) : '')
                + stat('Take-home', money(takeHome))
                + stat('Average', `${money(takeHome / m)}/mo`);
        } else if (role === 'expense') {
            stats = stat('Spent here', money(nr.totals.consumed))
                + stat('Average', `${money(nr.totals.in / m)}/mo`)
                + (nr.totals.out > 0.5 ? stat('Paid through links', money(nr.totals.out)) : '');
        } else {
            if (kind === 'group') stats = stat('Received', money(nr.totals.in)) + stat('Passed on', money(nr.totals.out))
                + (nr.totals.consumed > 0.5 ? stat('Spent in group', money(nr.totals.consumed)) : '');
            else stats = stat('Taken', money(nr.totals.consumed)) + stat('Passed on', money(nr.totals.out));
        }
        const unplaced = nr.totals.unplaced;
        if (unplaced > 0.5 && role !== 'account') stats += stat('Unassigned', money(unplaced));
        return foldSection('details', 'Details', `<div class="insp-stats">${stats}</div>`);
    }

    /** What the last run flagged on a module, shown right under its settings. */
    function nodeIssues(node) {
        const r = results();
        if (!r) return '';
        return issuesHtml(r.warnings.filter((w) => w.nodeId === node.id || (w.nodeIds && w.nodeIds.includes(node.id))));
    }

    // ── Link panel ─────────────────────────────────────────────────────────

    const MODE_LABEL = { percent: '%', fixed: null, rest: 'Rest', cost: 'Cost' };
    const WHEN_LABEL = { monthly: 'Every month', yearly: 'Every year', once: 'Once' };

    function linkPanel(link) {
        const from = PlanStore.node(link.from);
        const to = PlanStore.node(link.to);
        const id = link.id;
        const L = () => PlanStore.link(id) || link;
        const ends = (pl, l) => [pl.nodes.find((n) => n.id === l.from), pl.nodes.find((n) => n.id === l.to)];
        const setL = (fn) => (pl, v) => { const l = pl.links.find((x) => x.id === id); fn(l, v); P.fitRule(l, ...ends(pl, l)); };

        const bases = P.basesFor(from);
        let rule = '';
        // What the link carries (a card's purchases, a loan's proceeds...) is picked here;
        // the other links between this pair hold the bases they already use.
        const sources = bases.filter((b) => b === link.basis || P.basesBetween(plan(), from, to, link.id).includes(b));
        if (sources.length > 1) {
            rule += field('From', 'link.basis', {
                type: 'select', options: sources.map((b) => [b, D.portLabel(from, b)]), rebuild: true,
                get: () => L().basis,
                set: (pl, v) => P.changeBasis(pl, pl.links.find((x) => x.id === id), v),
            });
        } else if (bases.length > 1) {
            rule += row('From', `<span class="insp-static">${esc(D.portLabel(from, link.basis))}</span>`);
        }
        rule += ruleRows({
            r: link, R: L, setR: setL, key: 'link', modeAttr: 'data-mode', aria: 'Send',
            starts: link.basis !== 'proceeds',
            modes: P.modesFor(from, link.basis, to), timings: P.timingsFor(link.basis, link.mode),
            percentLabel: link.basis === 'charges' ? 'Of limit' : 'Percent',
            // The cost is the expense's own setting: shown here, edited there.
            costRow: row('Cost', `<span class="insp-static">${esc(D.nodeMeta(to) || 'None set')}</span>`),
        });

        // A link between two accounts may be two-way (plan.js, two-way links):
        // its way back has the same rows as the way out, its start included.
        const two = !!link.back;
        const canTwo = two || P.canTurn(plan(), link);
        const why = canTwo ? '' : ' title="Only a flow between two accounts can be two-way"';
        const direction = `<section class="insp-section">
            <div class="ant-segmented insp-direction" role="group" aria-label="Direction"${why}>
                <button class="ant-segmented-item" type="button" data-act="link-oneway" aria-pressed="${!two}">${planIcon('arrow-right')}One-way</button>
                <button class="ant-segmented-item" type="button" data-act="link-twoway" aria-pressed="${two}"${canTwo ? '' : ' disabled'}>${planIcon('arrows-left-right')}Two-way</button>
            </div></section>`;
        const backHtml = two ? section(`Back to ${from.name}`, `<div class="insp-fields">${backFields(link)}</div>`) : '';

        return `
            <div class="insp-card insp-card--link">
            <div class="insp-header">
                <div class="insp-titles">${linkEnds(from, to, two)}</div>
                <button class="ant-btn ant-btn-text ant-btn-icon-only" type="button" data-act="link-delete" aria-label="Delete flow" title="Delete flow">${planIcon('trash')}</button>
            </div>
            ${direction}
            ${section(`To ${to.name}`, `<div class="insp-fields">${rule}</div>`)}
            ${backHtml}
            <section class="insp-section"><p class="sentence" data-sentence>${D.linkSentence(link, from, to)}</p></section>
            </div>
            <div data-issues></div>
            <div data-stats></div>`;
    }

    /** A rule's rows, the same for a link's way out and a two-way link's way
     *  back: Send, its Percent or Amount, When (and On a date, sent once),
     *  Grows and Start. `r` is the rule as built, `R` reads it as it is now,
     *  `setR` wraps an edit of it, and `key` ('link' or 'back') names its
     *  bindings and its side. */
    function ruleRows({ r, R, setR, key, modes, timings, modeAttr, aria, percentLabel = 'Percent', costRow = '', starts = true }) {
        const sym = Fmt.symbolParts().symbol;
        let html = row('Send', `<div class="ant-segmented" role="group" aria-label="${esc(aria)}">${modes.map((m) =>
            `<button class="ant-segmented-item" type="button" ${modeAttr}="${m}" aria-pressed="${r.mode === m}">${esc(MODE_LABEL[m] || sym)}</button>`).join('')}</div>`,
        { wide: modes.length > 3 });
        if (r.mode === 'percent') {
            html += field(percentLabel, `${key}.value`, {
                type: 'percent', min: 0, max: 100,
                get: () => R().value,
                set: setR((x, v) => { x.value = v; }),
            });
        } else if (r.mode === 'cost') {
            html += costRow;
        } else if (r.mode === 'fixed') {
            html += field('Amount', `${key}.value`, {
                type: 'money', min: 0, max: P.LIMITS.money,
                get: () => R().value,
                set: setR((x, v) => { x.value = v; }),
            });
        }
        if (timings.length > 1) {
            html += field('When', `${key}.when`, {
                type: 'select', rebuild: true,
                options: timings.map((w) => [w, WHEN_LABEL[w]]),
                get: () => R().when,
                set: setR((x, v) => {
                    x.when = v;
                    if (v === 'once' && !x.date && !x.startWhen) x.date = P.ymAdd(plan().settings.start, 12);
                }),
            });
            // Every year is sent the month it starts and every twelfth after.
            if (r.when === 'once' && !(starts && r.startWhen)) {
                // With a start condition, once is the month it starts.
                html += field('On', `${key}.date`, {
                    type: 'yearmonth',
                    get: () => R().date,
                    set: setR((x, v) => { x.date = v; }),
                });
            }
        }
        if (r.mode === 'fixed') {
            html += field('Grows', `${key}.growth`, {
                type: 'percent', min: -100, max: 100, suffix: '/yr',
                get: () => R().growth,
                set: setR((x, v) => { x.growth = v; }),
            });
        }
        if (starts) {
            html += condRows(r, R, setR, key, 'start');
            // Sent once, it has nothing to stop.
            if (r.when !== 'once') html += condRows(r, R, setR, key, 'stop');
        }
        return html;
    }

    // A side's Start and Stop (plan.js, Starting): each Now/Never, or When a
    // condition is met, an age, the plan's retirement age or an account's size.
    const COND = {
        start: { prop: 'startWhen', label: 'Start', off: ['now', 'Now'], at: 'Starts' },
        stop:  { prop: 'stopWhen',  label: 'Stop',  off: ['never', 'Never'], at: 'Stops' },
    };

    function condRows(r, R, setR, key, which) {
        const { prop, label, off, at } = COND[which];
        const c = r[prop];
        const on = c ? 'when' : off[0];
        let html = row(label, `<div class="ant-segmented" role="group" aria-label="${label}">${[off, ['when', 'When']].map(([v, t]) =>
            `<button class="ant-segmented-item" type="button" data-cond="${which}:${key}:${v}" aria-pressed="${on === v}">${t}</button>`).join('')}</div>`);
        if (!c) return html;
        const C = () => R()[prop] || {};
        html += field('Condition', `${key}.${prop}.kind`, {
            type: 'select', rebuild: true,
            options: [['age', 'Age'], ['retire', 'Retirement age'], ['balance', 'Account size']],
            get: () => C().kind,
            // A new kind starts afresh (newCond), as Send's modes do.
            set: (pl, v) => {
                const l = pl.links.find((x) => x.id === built.slice(5));
                const side = l && (key === 'back' ? l.back : l);
                if (side && side[prop] && side[prop].kind !== v) side[prop] = newCond(pl, l, key, which, v);
            },
        });
        const setC = (fn) => setR((x, v) => { if (x[prop]) fn(x[prop], v); });
        if (c.kind === 'age') {
            html += field('Age', `${key}.${prop}.age`, {
                type: 'number', min: P.GOAL_AGE.min, max: P.GOAL_AGE.max, suffix: 'yrs', decimals: true,
                get: () => C().age,
                set: setC((x, v) => { x.age = v; }),
            });
        }
        if (c.kind === 'age' || c.kind === 'retire') {
            // The retirement age is the plan's (its Timeline), so it has no field here.
            html += row(at, `<span class="insp-static" data-cond-at="${which}:${key}">${esc(startsLabel(plan(), c))}</span>`);
        } else {
            const accounts = plan().nodes.filter((n) => D.roleOf(n) === 'account');
            html += field('Account', `${key}.${prop}.account`, {
                type: 'select', rebuild: true,
                options: [...(c.account ? [] : [['', 'Pick an account']]), ...accounts.map((n) => [n.id, n.name])],
                get: () => C().account || '',
                set: setC((x, v) => { x.account = v || null; }),
            });
            html += field('Reaches', `${key}.${prop}.amount`, {
                type: 'money', min: 0, max: P.LIMITS.money,
                get: () => C().amount,
                set: setC((x, v) => { x.amount = v; }),
            });
        }
        return html;
    }

    /** The month an age start or stop is met, for its Starts or Stops row:
     *  'Nov 2061', or 'Age 65 · Nov 2061' at the retirement age. */
    function startsLabel(p, c) {
        if (!c || (c.kind !== 'age' && c.kind !== 'retire')) return '';
        if (c.kind === 'retire' && p.settings.retireAge == null) return 'Needs a retirement age (plan Timeline)';
        const ym = P.startAgeMonth(p, c);
        if (!ym) return 'Needs your age (plan Timeline)';
        return c.kind === 'retire' ? `Age ${Fmt.number(p.settings.retireAge, 1)} · ${P.ymLabel(ym)}` : P.ymLabel(ym);
    }

    /** A new start or stop condition for a side of `l` in `pl`. With no kind
     *  given: the retirement age when the plan has one, else an age. An age
     *  is 65 (or the next birthday past it). A start's account size is the
     *  account the side draws from reaching $100,000; a stop's is the account
     *  it fills reaching $1,000,000 (else the first account). */
    function newCond(pl, l, key, which, kind = pl.settings.retireAge != null ? 'retire' : 'age') {
        if (kind === 'retire') return { kind: 'retire' };
        if (kind === 'age') {
            const age = pl.settings.age;
            return { kind: 'age', age: age != null && age >= 65 ? Math.floor(age) + 1 : 65 };
        }
        const isAcct = (id) => { const n = pl.nodes.find((x) => x.id === id); return n && D.roleOf(n) === 'account'; };
        const [own, other] = (key === 'back') === (which === 'stop') ? [l.from, l.to] : [l.to, l.from];
        const first = pl.nodes.find((n) => D.roleOf(n) === 'account');
        const account = isAcct(own) ? own : isAcct(other) ? other : first ? first.id : null;
        return { kind: 'balance', account, amount: which === 'stop' ? 1000000 : 100000 };
    }

    /** Reading and editing a two-way link's way back. */
    function backAccess(link) {
        const id = link.id;
        return {
            B: () => (PlanStore.link(id) || link).back,
            setB: (fn) => (pl, v) => {
                const l = pl.links.find((x) => x.id === id);
                if (l && l.back) fn(l.back, v);
            },
        };
    }

    /** The way back of a two-way link: the same rows as the way out (a
     *  balance link's between two accounts). */
    function backFields(link) {
        const { B, setB } = backAccess(link);
        return ruleRows({
            r: link.back, R: B, setR: setB, key: 'back', modeAttr: 'data-back-mode', aria: 'Send back',
            modes: P.BACK_MODES, timings: P.BACK_WHENS,
        });
    }

    /** The two ends of a link, each a button that selects its module. */
    function linkEnds(from, to, two = false) {
        const end = (n) => `<button class="link-end" type="button" data-select="node:${esc(n.id)}">
            <span class="role-tile" data-role="${D.swatchOf(n)}">${planIcon(P.iconOf(n))}</span><span>${esc(n.name)}</span></button>`;
        return `<div class="link-ends">${end(from)}
            <span class="link-ends-arrow" aria-hidden="true">${planIcon(two ? 'arrows-left-right' : 'arrow-right')}</span>${end(to)}</div>`;
    }

    function linkIssues(link) {
        const r = results();
        return r ? issuesHtml(r.warnings.filter((w) => w.linkId === link.id)) : '';
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function currentKey() {
        const s = PlanStore.state.selection;
        if (PlanStore.state.workspace !== 'plans') return 'none';
        if (PlanStore.state.preview) return `preset:${PlanStore.state.preview}`;
        if (s && s.kind === 'node' && PlanStore.node(s.id)) return `node:${s.id}`;
        if (s && s.kind === 'link' && PlanStore.link(s.id)) return `link:${s.id}`;
        return 'plan';
    }

    function renderStats() {
        // Nothing is built while the panel is closed (toggle clears `built`).
        if (!statsEl || !plan() || !built) return;
        const key = built;
        let html = '';
        if (key === 'plan') html = planStats();
        else if (key === 'none' || key.startsWith('preset:')) html = '';
        else if (key.startsWith('node:')) html = nodeStats(PlanStore.node(key.slice(5)));
        statsEl.innerHTML = html;
        if (issuesEl) {
            issuesEl.innerHTML = key.startsWith('node:') ? nodeIssues(PlanStore.node(key.slice(5)))
                : key.startsWith('link:') ? linkIssues(PlanStore.link(key.slice(5))) : '';
        }
        for (const el of root.querySelectorAll('[data-flow]')) el.textContent = flowText(el.dataset.flow);
    }

    function render() {
        root.dataset.collapsed = String(!isOpenState);
        const p = plan();
        if (!p || !isOpenState) return;
        const key = currentKey();
        if (key === built) {
            sync();
            renderStats();
            return;
        }
        built = key;
        binds = new Map();
        let html;
        if (key === 'none') html = '';
        else if (key === 'plan') html = planPanel();
        else if (key.startsWith('preset:')) html = presetPanel(key.slice(7));
        else if (key.startsWith('node:')) html = nodePanel(PlanStore.node(key.slice(5)));
        else html = linkPanel(PlanStore.link(key.slice(5)));
        // The plan's panel carries a notebook as a watermark, as a module's
        // card on the canvas carries its icon (canvas.css, .node-wm).
        const wm = key === 'plan' ? `<div class="insp-wm" aria-hidden="true">${planIcon('notebook')}</div>` : '';
        root.innerHTML = `${wm}<div class="insp-scroll scroll-y">${html}</div>`;
        if (key.startsWith('preset:')) {
            for (const el of root.querySelectorAll('[data-bind]')) el.disabled = true;
        }
        builtSig = structureSig();
        statsEl = root.querySelector('[data-stats]');
        issuesEl = root.querySelector('[data-issues]');
        sync();
        renderStats();
    }

    // ── Events ─────────────────────────────────────────────────────────────

    /** Group an amount field's digits as they are typed, keeping the caret
     *  after the same digit it was after. */
    function groupWhileTyping(el, spec) {
        const raw = el.value;
        const caret = el.selectionStart ?? raw.length;
        const next = Fmt.formatTyping(raw, {
            negative: (spec.min ?? -Infinity) < 0,
            decimals: spec.type !== 'number' || !!spec.decimals,
        });
        if (next === raw) return;
        const dec = currencyFormat().decimal;
        const significant = (t) => { let n = 0; let seen = false; for (const ch of t) { if (/\d|-|\u2212/.test(ch)) n++; else if (ch === dec && !seen) { seen = true; n++; } } return n; };
        let keep = significant(raw.slice(0, caret));
        el.value = next;
        let pos = 0;
        while (pos < next.length && keep > 0) { if (/[\d-]/.test(next[pos]) || next[pos] === dec) keep--; pos++; }
        el.setSelectionRange(pos, pos);
    }

    root.addEventListener('input', (e) => {
        const el = e.target.closest('[data-bind]');
        if (!el) return;
        const spec = binds.get(el.dataset.bind);
        if (spec && (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number')) groupWhileTyping(el, spec);
        if (spec && (spec.type === 'money' || spec.type === 'percent' || spec.type === 'number' || spec.type === 'text')) commit(el, false);
    });

    root.addEventListener('change', (e) => {
        const el = e.target.closest('[data-bind]');
        if (el) commit(el, true);
    });

    root.addEventListener('focusout', (e) => {
        const el = e.target.closest('[data-bind]');
        if (!el) return;
        const spec = binds.get(el.dataset.bind);
        if (spec && spec.type !== 'select' && spec.type !== 'yearmonth') commit(el, true);
    });

    root.addEventListener('keydown', (e) => {
        const el = e.target.closest('input[data-bind]');
        if (el && e.key === 'Enter') {
            e.preventDefault();
            el.blur();
        } else if (el && e.key === 'Escape') {
            const spec = binds.get(el.dataset.bind);
            if (spec) el.value = display(spec, spec.get());
            el.blur();
        }
        // Keep Delete/Backspace inside text fields from reaching the canvas.
        if (e.target.closest('input, select')) e.stopPropagation();
    });

    root.addEventListener('click', (e) => {
        const fold = e.target.closest('[data-fold]');
        if (fold) {
            const id = fold.dataset.fold;
            const open = fold.getAttribute('aria-expanded') !== 'true';
            fold.setAttribute('aria-expanded', String(open));
            fold.nextElementSibling.hidden = !open;
            folds[id] = open;
            PlanPrefs.set(FOLD_KEY, JSON.stringify(folds));
            return;
        }
        const sel = e.target.closest('[data-select]');
        if (sel) {
            const [kind, ...rest] = sel.dataset.select.split(':');
            PlanStore.select({ kind, id: rest.join(':') });
            return;
        }
        const month = e.target.closest('[data-month]');
        if (month) {
            const spec = binds.get(month.dataset.bind);
            if (!spec) return;
            Ant.monthPicker(month, {
                value: spec.get(),
                defaultPickerValue: plan().settings.start,
                clearText: spec.optional ? 'Clear' : null,
                onPick: (v) => {
                    apply(spec, v);
                    if (spec.rebuild) rebuild(); else sync();
                },
            });
            return;
        }
        const mode = e.target.closest('[data-mode]');
        if (mode) {
            const id = built.slice(5);
            PlanStore.edit((pl) => {
                const l = pl.links.find((x) => x.id === id);
                const next = mode.dataset.mode;
                if (l.mode === next) return false;
                // A rest link elsewhere on this basis cannot coexist with a second one.
                if (next === 'rest' && pl.links.some((x) => x.id !== id && x.from === l.from && x.basis === l.basis && x.mode === 'rest')) {
                    planNotice('Another link already takes the rest.');
                    return false;
                }
                // One link pays an expense's cost.
                if (next === 'cost' && P.costPayer(pl, l.to, id)) {
                    planNotice('Another link already pays its cost.');
                    return false;
                }
                if (next === 'percent') l.value = Math.min(l.value || 25, 100) || 25;
                if (next === 'fixed' && (l.mode === 'percent' || l.mode === 'cost')) l.value = 500;
                if (next === 'cost') l.value = 0;
                l.mode = next;
                P.fitRule(l, pl.nodes.find((n) => n.id === l.from), pl.nodes.find((n) => n.id === l.to));
                return true;
            });
            rebuild();
            return;
        }
        const backMode = e.target.closest('[data-back-mode]');
        if (backMode) {
            const id = built.slice(5);
            PlanStore.edit((pl) => {
                const l = pl.links.find((x) => x.id === id);
                const next = backMode.dataset.backMode;
                if (!l || !l.back || l.back.mode === next) return false;
                // As on the way out: one link takes the rest of an account's balance.
                const takesRest = (x) => x.id !== id && ((x.from === l.to && x.basis === 'balance' && x.mode === 'rest')
                    || (x.to === l.to && x.back && x.back.mode === 'rest'));
                if (next === 'rest' && pl.links.some(takesRest)) {
                    planNotice('Another link already takes the rest.');
                    return false;
                }
                // The amount means something else in the other mode: start it afresh.
                l.back.value = next === 'percent' ? 4 : next === 'fixed' ? 2000 : 0;
                l.back.mode = next;
                return true;
            });
            rebuild();
            return;
        }
        // A side's Start (Now) or Stop (Never), or When a condition is met
        // (the retirement age or an age, to begin with: newCond).
        const condBtn = e.target.closest('[data-cond]');
        if (condBtn) {
            const id = built.slice(5);
            const [which, key, v] = condBtn.dataset.cond.split(':');
            const prop = COND[which].prop;
            PlanStore.edit((pl) => {
                const l = pl.links.find((x) => x.id === id);
                const side = l && (key === 'back' ? l.back : l);
                if (!side || (v === 'when') === !!side[prop]) return false;
                if (v !== 'when') {
                    delete side[prop];
                    if (key === 'back') side[prop] = null;
                    // Sent once and starting now, it needs a date of its own.
                    if (which === 'start' && side.when === 'once' && !side.date) side.date = P.ymAdd(pl.settings.start, 12);
                } else {
                    side[prop] = newCond(pl, l, key, which);
                }
                return true;
            });
            rebuild();
            root.querySelector(`[data-cond="${condBtn.dataset.cond}"]`)?.focus();
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const key = built;
        if (act.dataset.act === 'node-icon') {
            const id = key.slice(5);
            const node = PlanStore.node(id);
            openIconPicker(act, C.preset(node.type), P.iconOf(node), (icon) => {
                PlanStore.edit((pl) => {
                    const n = pl.nodes.find((x) => x.id === id);
                    if (icon === C.preset(n.type).icon) delete n.icon; else n.icon = icon;
                });
            });
        } else if (act.dataset.act === 'preview-icon') {
            const p = C.preset(PlanStore.state.preview);
            openIconPicker(act, p, PlanStore.state.previewIcon || p.icon, (icon) => {
                PlanStore.setPreviewIcon(icon);
                refresh();
                root.querySelector('[data-act="preview-icon"]')?.focus();
            });
        } else if (act.dataset.act === 'link-delete') {
            PlanStore.removeLink(key.slice(5));
        } else if (act.dataset.act === 'link-twoway') {
            PlanStore.edit((pl) => P.makeTwoWay(pl, pl.links.find((x) => x.id === key.slice(5))));
            rebuild();
        } else if (act.dataset.act === 'link-oneway') {
            PlanStore.edit((pl) => {
                const l = pl.links.find((x) => x.id === key.slice(5));
                if (!l || !l.back) return false;
                delete l.back;
                return true;
            });
            rebuild();
        }
    });

    /** The icon grid for a module of preset `p`, in its role's colour. */
    function openIconPicker(anchor, p, value, onPick) {
        PlanPickers.icons(anchor, { icons: C.iconChoices(p), value, role: C.swatchOf(p), onPick });
    }

    function toggle() {
        isOpenState = !isOpenState;
        PlanPrefs.set(OPEN_KEY, isOpenState ? '1' : '0');
        built = null;
        render();
    }

    PlanStore.on((c) => {
        if (c.type === 'selection' || c.type === 'tabs' || c.type === 'workspace') { built = c.type === 'tabs' ? null : built; render(); }
        else if (c.type === 'plan') {
            // Structural changes (links added or removed) change the panel's lists.
            const key = currentKey();
            if (key !== built) render();
            else if (key !== 'plan' && listsChanged()) rebuild();
            else sync();
        } else if (c.type === 'results' || c.type === 'scrub') renderStats();
    });

    /** What the built panel's layout depends on beyond the selection: a
     *  module's links (its lists) and its schedule (which fields show), or a
     *  link's mode, basis and timing (which controls show). */
    function structureSig() {
        const p = plan();
        if (!p || !built) return '';
        if (built.startsWith('node:')) {
            const id = built.slice(5);
            const n = PlanStore.node(id);
            const links = p.links.filter((l) => l.from === id || l.to === id)
                .map((l) => `${l.id}:${l.mode}:${l.value}:${l.basis}:${l.when}:${l.date}:${PlanStore.node(l.from === id ? l.to : l.from)?.name}`);
            // A card's cash back setting lists the plan's accounts.
            const accounts = n && n.params.cashBack != null
                ? p.nodes.filter((a) => D.roleOf(a) === 'account').map((a) => `${a.id}:${a.name}`).join(',') : '';
            // Which fields show: the schedule, a card's cash back, an expense's cost (visibleFields).
            const shows = n ? `${n.params.per}#${n.params.cashBack > 0}#${n.params.cost != null}` : '';
            return `${links.join('|')}#${shows}#${accounts}`;
        }
        if (built.startsWith('link:')) {
            const l = PlanStore.link(built.slice(5));
            // A two-way link's way back has fields of its own (and none once it is one-way).
            const startSig = (c) => (c ? `${c.kind}:${c.account || ''}` : 'now');
            const back = l && l.back ? `${l.back.mode}|${l.back.when}|${startSig(l.back.startWhen)}|${startSig(l.back.stopWhen)}` : 'one-way';
            // An account-size start lists the plan's accounts.
            const accounts = p.nodes.filter((a) => D.roleOf(a) === 'account').map((a) => `${a.id}:${a.name}`).join(',');
            return l ? `${l.mode}|${l.basis}|${l.when}|${PlanStore.node(l.from)?.params.start}|${startSig(l.startWhen)}|${startSig(l.stopWhen)}|${back}|${accounts}` : '';
        }
        return '';
    }

    function listsChanged() {
        const sig = structureSig();
        const changed = sig !== builtSig;
        builtSig = sig;
        return changed;
    }

    /** Rebuild from scratch (number formats changed). */
    function refresh() {
        built = null;
        render();
    }

    window.Inspector = { refresh, toggle, isOpen: () => isOpenState };
}());
