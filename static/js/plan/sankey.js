'use strict';

// ─── sankey.js ──────────────────────────────────────────────────────────────
// The outlook's Sankey: where a span's money came from and where it went,
// drawn after Aventurine Manage's Cash Flow report (widgets/cashflow-sankey.js
// in aventurine-manage). Four columns:
//
//   sources → Money in → groups (Spending, Accounts, …) → each module
//
// Drawn by Apache ECharts' Sankey through the app's chart kit
// (widgets/echart-kit.js). Every column shares one value scale, each column
// keeps the order given (largest first), and ribbons are gradients from the
// colour of the bar they leave to the colour of the bar they meet. Labels sit
// on the inner face of their bar, out over their own ribbon, cut to fit the
// run between two columns.
//
// Manage draws this on a full page; here it lives in a short panel the user
// can resize. So when the box is too short to label every band, the smallest
// fold into "Other" (within their group on the right).
//
// Colours arrive as CSS custom-property names and are resolved by the kit,
// which rebuilds the diagram when the theme changes. A canvas has no focusable
// parts, so the modules a click can select are also listed as visually hidden
// buttons beside it.

(function () {
    const PAD = { t: 12, b: 16 };
    const LABEL_OFFSET = 10;   // gap between a bar's face and its label
    const EDGE_PAD = 10;       // gap between a side column and the box edge
    const NODE_W = 13;         // bar thickness
    const LABEL_GAP = 32;      // label block height (name over amount)
    const LABEL_MARGIN = 16;   // room above the first band and below the last for their labels
    const MIN_GAP = 6;         // bands never sit closer than this
    const OTHER_COLOR = '--chart-unassigned';

    const sum = (items) => items.reduce((a, b) => a + b.value, 0);

    const otherBand = (label, rest) => ({ label, value: sum(rest), color: OTHER_COLOR, folded: rest.map((b) => b.label) });

    /** The sources largest first, then the pinned ones (kept last, never
     *  folded). Past `max` bands the smallest fold into one "Other". */
    function foldSources(items, max, otherLabel) {
        const pinned = items.filter((b) => b.pinned && b.value > 0.5);
        const free = items.filter((b) => !b.pinned && b.value > 0.5).sort((a, b) => b.value - a.value);
        const room = Math.max(1, max - pinned.length);
        if (free.length > room) free.push(otherBand(otherLabel, free.splice(room - 1)));
        return [...free, ...pinned];
    }

    /** Groups in the order given, empty ones dropped, each one's modules
     *  largest first in its own ramp. While the module column holds more than
     *  `max` bands, the group with the most folds its smallest into "Other"
     *  (a group always keeps at least one band of its own). If that is still
     *  too many, the smallest groups close: their pipe ends at the group
     *  column, with its modules listed in the tooltip. */
    function foldGroups(groups, max, otherLabel) {
        const list = groups
            .map((g) => ({ ...g, kept: g.items.filter((b) => b.value > 0.5).sort((a, b) => b.value - a.value), rest: [] }))
            .filter((g) => g.kept.length);
        const bands = (g) => (g.closed ? 0 : g.kept.length + (g.rest.length ? 1 : 0));
        let count = list.reduce((a, g) => a + bands(g), 0);
        while (count > max) {
            const g = list
                .filter((x) => x.kept.length >= (x.rest.length ? 2 : 3))
                .sort((a, b) => bands(b) - bands(a))[0];
            if (!g) break;
            if (!g.rest.length) g.rest.push(g.kept.pop());
            g.rest.push(g.kept.pop());
            count--;
        }
        const bySize = list.slice().sort((a, b) => sum(a.kept) + sum(a.rest) - sum(b.kept) - sum(b.rest));
        for (const g of bySize) {
            if (count <= max) break;
            count -= bands(g);
            g.closed = true;
        }
        return list.map((g) => {
            const items = g.kept.map((b, i) => ({ ...b, color: b.color || g.ramp[i % g.ramp.length] }));
            if (g.rest.length) items.push(otherBand(otherLabel, g.rest));
            return g.closed
                ? { label: g.label, color: g.color, value: sum(items), items: [], folded: [...g.kept, ...g.rest].map((b) => b.label) }
                : { label: g.label, color: g.color, value: sum(items), items };
        });
    }

    /** A share of the whole. Under 10% keeps a decimal. */
    function share(value, total) {
        if (!(total > 0)) return '';
        const pct = (value / total) * 100;
        if (pct > 0 && pct < 0.1) return '(<0.1%)';
        return `(${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%)`;
    }

    /**
     * Draw into `box` (a positioned element), replacing whatever chart is there.
     *   opts.left        [{ label, value, id?, color?, pinned?, note? }] the sources
     *   opts.groups      [{ label, color, ramp, items: [{ label, value, id?, color?, note? }] }]
     *                    where the money went, in display order; each item
     *                    is one module's band. A band with an id can be
     *                    clicked (onSelect); a note is added to its tooltip.
     *   opts.inRamp      colour names for the sources, largest first
     *   opts.hubLabel    the middle bar's name
     *   opts.hubColor    the middle bar's colour name
     *   opts.otherLabel  a folded band's name
     *   opts.format      value → amount text
     *   opts.label       the diagram's accessible name
     *   opts.empty       text shown when there is no money to draw
     *   opts.onSelect    id → void
     */
    function draw(box, opts) {
        const canvas = PlanChart.canvasOf(box);
        const H = box.clientHeight;
        const W = box.clientWidth;
        // As many bands per column as there is height to label without overlap.
        const maxBands = Math.max(2, Math.floor((H - PAD.t - PAD.b - 22) / LABEL_GAP) + 1);
        const left = foldSources(opts.left, maxBands, opts.otherLabel);
        const groups = foldGroups(opts.groups, maxBands, opts.otherLabel);
        const total = Math.max(sum(left), sum(groups));
        // A label sits in the run between two columns, so it is cut to fit it.
        const labelRoom = Math.max(40, (W - EDGE_PAD * 2 - NODE_W * 4) / 3 - LABEL_OFFSET * 2);

        // Nodes and links by name. Names are ids, not labels: two modules may
        // share a label.
        const nodes = [];
        const links = [];
        const HUB = 'hub';
        left.forEach((b, i) => {
            const name = `src:${i}`;
            nodes.push({ name, band: b, depth: 0, color: b.color || opts.inRamp[i % opts.inRamp.length], side: 'right' });
            links.push({ source: name, target: HUB, value: b.value, band: b, tip: `${b.label} → ${opts.hubLabel}` });
        });
        nodes.push({ name: HUB, band: { label: opts.hubLabel, value: total }, depth: 1, color: opts.hubColor, side: 'right' });
        groups.forEach((g, gi) => {
            const gname = `grp:${gi}`;
            nodes.push({ name: gname, band: g, depth: 2, color: g.color, side: 'left' });
            links.push({ source: HUB, target: gname, value: g.value, band: g, tip: `${opts.hubLabel} → ${g.label}` });
            g.items.forEach((it, ii) => {
                const name = `${gname}:${ii}`;
                nodes.push({ name, band: it, depth: 3, color: it.color, side: 'left' });
                links.push({ source: gname, target: name, value: it.value, band: it, tip: `${g.label} → ${it.label}` });
            });
        });
        const empty = !left.length && !groups.length;

        EChartKit.mount(canvas, (t) => {
            if (empty) {
                return {
                    title: {
                        text: opts.empty, left: 'center', top: 'middle',
                        textStyle: { color: t.textTertiary, fontFamily: t.font, fontSize: 13, fontWeight: 400 },
                    },
                };
            }
            const amount = (b) => {
                const pct = share(b.value, total);
                return `{amount|${opts.format(b.value)}}${pct ? ` {share|${pct}}` : ''}`;
            };
            const tipFor = (b, tip) => {
                const note = [b.note, b.folded && b.folded.join(', ')].filter(Boolean).join(' · ');
                return EChartKit.tipHtml({ rows: [{ name: tip, value: opts.format(b.value) }], note });
            };
            return {
                tooltip: EChartKit.tooltip(t, {
                    trigger: 'item',
                    formatter: (p) => (p.dataType === 'edge'
                        ? tipFor(p.data.band, p.data.tip)
                        : tipFor(p.data.band, p.data.band.label)),
                }),
                series: [{
                    type: 'sankey',
                    left: EDGE_PAD,
                    right: EDGE_PAD,
                    top: PAD.t + LABEL_MARGIN,
                    bottom: PAD.b + LABEL_MARGIN,
                    nodeWidth: NODE_W,
                    nodeGap: Math.max(MIN_GAP, Math.min(LABEL_GAP, H / 12)),
                    nodeAlign: 'justify',
                    layoutIterations: 0,
                    draggable: false,
                    emphasis: { focus: 'adjacency' },
                    lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.4 },
                    label: {
                        distance: LABEL_OFFSET,
                        width: labelRoom,
                        overflow: 'truncate',
                        rich: {
                            // Name and amount take the full text colour: they
                            // float over the ribbons, where a muted tone reads poorly.
                            name: { color: t.text, fontFamily: t.font, fontSize: 12, lineHeight: 16 },
                            amount: { color: t.text, fontFamily: t.font, fontSize: 13, fontWeight: 600, lineHeight: 18 },
                            share: { color: t.textSecondary, fontFamily: t.font, fontSize: 11, lineHeight: 18 },
                        },
                    },
                    data: nodes.map((n) => ({
                        name: n.name,
                        depth: n.depth,
                        band: n.band,
                        itemStyle: { color: PlanChart.colorOf(box, n.color, t.textTertiary), borderWidth: 0 },
                        cursor: n.band.id ? 'pointer' : 'default',
                        label: {
                            position: n.side,
                            formatter: () => `{name|${String(n.band.label).replace(/[{}|]/g, ' ')}}\n${amount(n.band)}`,
                        },
                    })),
                    links,
                }],
            };
        }, {
            label: opts.label,
            animate: !box.querySelector(':scope > .chart-canvas canvas'),
            on: {
                click: (p) => {
                    const id = p.data && p.data.band && p.data.band.id;
                    if (id && opts.onSelect) opts.onSelect(id);
                },
            },
        });
        renderKeys(box, empty ? [] : nodes.filter((n) => n.band.id), opts);
    }

    /** The modules the diagram can select, as buttons for the keyboard and
     *  screen readers: a canvas has no focusable parts. Visually hidden. */
    function renderKeys(box, pickable, opts) {
        let keys = box.querySelector(':scope > .sankey-keys');
        if (!keys) {
            keys = document.createElement('div');
            keys.className = 'sankey-keys ant-visually-hidden';
            keys.setAttribute('role', 'group');
            keys.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-id]');
                if (btn && keys.onSelect) keys.onSelect(btn.dataset.id);
            });
            box.appendChild(keys);
        }
        keys.onSelect = opts.onSelect;
        keys.setAttribute('aria-label', opts.label || 'Diagram');
        keys.innerHTML = pickable.map((n) => `<button type="button" data-id="${escapeHtml(n.band.id)}">${escapeHtml(`${n.band.label}: ${opts.format(n.band.value)}. Select module`)}</button>`).join('');
    }

    window.PlanSankey = { draw };
}());
