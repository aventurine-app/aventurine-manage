'use strict';

// ─── sankey.js ──────────────────────────────────────────────────────────────
// The outlook's Sankey: where a span's money came from and where it went,
// drawn after Aventurine Manage's Cash Flow report (widgets/cashflow-sankey.js
// in aventurine-manage). Four columns:
//
//   sources → Money in → groups (Spending, Accounts, …) → each module
//
// Every column shares one value scale. Within its column, each band is spread
// out evenly down the height (equal space above, between and below; a lone
// band is centred), so the diagram fans out rather than hanging from a flat
// top as Manage's does. A column too crowded for that falls back to filling
// the height edge to edge. Ribbons are gradients from the colour of
// the bar they leave to the colour of the bar they meet. Labels sit on the
// inner face of their bar, out over their own ribbon, so the ribbons get the
// whole width. A group's label shares the run between Money in and the
// groups with Money in's own label; when the run is too narrow for both side
// by side, they are spread apart vertically together.
//
// Manage draws this on a full page; here it lives in a short panel the user
// can resize. So when the box is too short to label every band, the smallest
// fold into "Other" (within their group on the right), and the gaps between
// bands shrink before the bands do (labels then spread apart on thin leader
// lines).
//
// Colours arrive as CSS custom-property names and are applied as
// `fill: var(--x)` / `stop-color: var(--x)`, so a theme switch recolours a
// drawn diagram with no redraw, as chart.js does.

(function () {
    const PAD = { t: 12, b: 16 };
    const LABEL_OFFSET = 10;   // gap between a bar's face and its label
    const EDGE_PAD = 10;       // gap between a side column and the box edge
    const NODE_W = 13;         // bar thickness
    const CAP_R = 4;           // rounding on a side bar's outer corners only
    const MIN_BAND = 1.5;      // floor so a tiny band is still visible
    const LABEL_GAP = 32;      // label block height (name over amount)
    const LABEL_MARGIN = 16;   // room above the first band and below the last for their labels
    const MIN_GAP = 6;         // bands never sit closer than this
    const GAP_SHARE = 0.5;     // the gaps may take at most this share of a column
    const OTHER_COLOR = '--chart-unassigned';

    const r1 = (v) => Math.round(v * 10) / 10;
    const sum = (items) => items.reduce((a, b) => a + b.value, 0);

    /** Horizontal ribbon between two equal-height slots. */
    function ribbon(sx, s0, tx, t0, h) {
        const mx = r1((sx + tx) / 2);
        return `M ${r1(sx)} ${r1(s0)} C ${mx} ${r1(s0)} ${mx} ${r1(t0)} ${r1(tx)} ${r1(t0)}`
             + ` L ${r1(tx)} ${r1(t0 + h)} C ${mx} ${r1(t0 + h)} ${mx} ${r1(s0 + h)} ${r1(sx)} ${r1(s0 + h)} Z`;
    }

    /** A side bar: the corners on the box-edge side are rounded, the ones the
     *  ribbon meets are square. outer -1 rounds the left, +1 the right. */
    function capPath(x, y, w, h, outer) {
        const r = Math.min(CAP_R, h / 2, w / 2);
        const x0 = r1(x), x1 = r1(x + w), y0 = r1(y), y1 = r1(y + h);
        if (outer < 0) {
            return `M ${x1} ${y0} L ${r1(x + r)} ${y0} Q ${x0} ${y0} ${x0} ${r1(y + r)}`
                 + ` L ${x0} ${r1(y + h - r)} Q ${x0} ${y1} ${r1(x + r)} ${y1} L ${x1} ${y1} Z`;
        }
        return `M ${x0} ${y0} L ${r1(x + w - r)} ${y0} Q ${x1} ${y0} ${x1} ${r1(y + r)}`
             + ` L ${x1} ${r1(y + h - r)} Q ${x1} ${y1} ${r1(x + w - r)} ${y1} L ${x0} ${y1} Z`;
    }

    // Label text is measured, not counted per character: the font and theme
    // both move it. One shared canvas context; none (no canvas) measures as 0.
    let measureCtx;
    function textWidth(text, size, weight) {
        if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
        if (!measureCtx) return 0;
        const family = getComputedStyle(document.documentElement).getPropertyValue('--font-family').trim() || 'sans-serif';
        measureCtx.font = `${weight} ${size}px ${family}`;
        return measureCtx.measureText(text).width;
    }
    // .sankey-label: 12px regular; .sankey-amount: 13px semibold (outlook.css).
    const nameWidth = (text) => textWidth(text, 12, 400);
    const amountWidth = (text) => textWidth(text, 13, 600);

    /** `text` cut with an ellipsis to fit `max` px as a band name. */
    function fitName(text, max) {
        if (nameWidth(text) <= max) return text;
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (nameWidth(`${text.slice(0, mid)}…`) <= max) lo = mid; else hi = mid - 1;
        }
        return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
    }

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

    /** Label centres, top to bottom: where they want to be where they fit,
     *  else pushed at least LABEL_GAP apart within the box. */
    function spread(wanted, H) {
        const top = PAD.t + 10;
        const bottom = H - PAD.b - 12;
        const ys = wanted.slice();
        for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + LABEL_GAP);
        if (ys.length && ys[ys.length - 1] > bottom) {
            ys[ys.length - 1] = bottom;
            for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - LABEL_GAP);
        }
        if (ys.length && ys[0] < top) {
            ys[0] = top;
            for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + LABEL_GAP);
        }
        return ys;
    }

    let drawSeq = 0;

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
        const entering = !box.querySelector('.sankey');
        box.querySelector('.chart-svg')?.remove();
        box.querySelector('.chart-tip')?.remove();
        const W = box.clientWidth;
        const H = box.clientHeight;
        if (W < 160 || H < 80) return;

        // As many bands per column as there is height to label without overlap.
        const maxBands = Math.max(2, Math.floor((H - PAD.t - PAD.b - 22) / LABEL_GAP) + 1);
        const left = foldSources(opts.left, maxBands, opts.otherLabel);
        const groups = foldGroups(opts.groups, maxBands, opts.otherLabel);
        const items = groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })));
        const seq = drawSeq++;

        if (!left.length && !groups.length) {
            box.insertAdjacentHTML('beforeend', `<svg class="chart-svg sankey" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(opts.label)}">`
                + `<text class="sankey-empty" x="${r1(W / 2)}" y="${r1(H / 2)}" text-anchor="middle">${escapeHtml(opts.empty)}</text></svg>`);
            return;
        }

        const totalIn = sum(left);
        const totalOut = sum(groups);
        const total = Math.max(totalIn, totalOut);
        const TOP = PAD.t + LABEL_MARGIN;
        const availH = H - TOP - PAD.b - LABEL_MARGIN;
        // Manage keeps bands a whole label apart; a short box gives up gap first.
        const gapFor = (n) => (n > 1 ? Math.max(MIN_GAP, Math.min(LABEL_GAP, (availH * GAP_SHARE) / (n - 1))) : 0);
        const fitScale = (n, value) => (availH - gapFor(n) * Math.max(0, n - 1)) / (value || 1);
        const scale = Math.max(0, Math.min(
            fitScale(left.length, totalIn),
            fitScale(groups.length, totalOut),
            fitScale(items.length, totalOut),
            fitScale(1, total),
        ));

        // Four columns, three equal ribbon runs between them.
        const sourceX = EDGE_PAD;
        const itemX = W - EDGE_PAD - NODE_W;
        const run = Math.max(0, (itemX - sourceX - NODE_W * 3) / 3);
        const hubX = sourceX + NODE_W + run;
        const groupX = hubX + NODE_W + run;
        const hubH = Math.max(total * scale, MIN_BAND);
        const hubTop = TOP + (availH - hubH) / 2;

        /** Spread bands down a column with equal space above, between and
         *  below them. When that leaves less between them than the column's
         *  planned gap, they fill the height edge to edge instead. */
        const stack = (list, x, colorOf) => {
            const n = list.length;
            const hs = list.map((b) => Math.max(b.value * scale, MIN_BAND));
            const free = Math.max(0, availH - hs.reduce((a, h) => a + h, 0));
            let gap = free / (n + 1);
            let y = TOP + gap;
            if (n > 1 && gap < gapFor(n)) {
                gap = free / (n - 1);
                y = TOP;
            }
            return list.map((b, i) => {
                const h = hs[i];
                const node = { ...b, x, y, h, color: colorOf(b, i) };
                y += h + gap;
                return node;
            });
        };
        const sourceNodes = stack(left, sourceX, (b, i) => b.color || opts.inRamp[i % opts.inRamp.length]);
        const groupNodes = stack(groups, groupX, (g) => g.color);
        const itemNodes = stack(items, itemX, (it) => it.color);

        let defs = '';
        let gradSeq = 0;
        const rampFill = (x1, x2, from, to) => {
            const id = `sankey-${seq}-${gradSeq++}`;
            defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r1(x1)}" y1="0" x2="${r1(x2)}" y2="0">`
                  + `<stop offset="0" style="stop-color: var(${from})"/><stop offset="1" style="stop-color: var(${to})"/></linearGradient>`;
            return `url(#${id})`;
        };

        const amountText = (n) => {
            const pct = share(n.value, total);
            return `${escapeHtml(opts.format(n.value))}${pct ? ` <tspan class="sankey-share">${escapeHtml(pct)}</tspan>` : ''}`;
        };
        const labelBlock = (x, y, anchor, name, amountHtml) =>
            `<text class="sankey-label" x="${r1(x)}" y="${r1(y - 3)}" text-anchor="${anchor}">${escapeHtml(name)}</text>`
            + `<text class="sankey-amount" x="${r1(x)}" y="${r1(y + 13)}" text-anchor="${anchor}">${amountHtml}</text>`;
        const leader = (fromX, fromY, toX, toY) => (Math.abs(toY - fromY) > 1
            ? `<path class="sankey-leader" d="M ${r1(fromX)} ${r1(fromY)} L ${r1(toX)} ${r1(toY)}"/>` : '');
        const labelRoom = Math.max(0, run - LABEL_OFFSET * 2);

        /** One band: its ribbon, leader and labels as one group (the hover and
         *  click target, when it stands for a module). */
        const band = (n, d, fill, tip, label) => {
            const pick = n.id
                ? ` class="sankey-cat is-pickable" data-id="${escapeHtml(n.id)}" tabindex="0" role="button" aria-label="${escapeHtml(`${n.label}: ${opts.format(n.value)}. Select module`)}"`
                : ' class="sankey-cat"';
            const note = [n.note, n.folded && n.folded.join(', ')].filter(Boolean).join('\n');
            return `<g${pick}><title>${escapeHtml(`${tip}: ${opts.format(n.value)}${note ? `\n${note}` : ''}`)}</title>`
                 + `<path class="sankey-link" d="${d}" fill="${fill}"/>${label}</g>`;
        };

        let waves = '';
        let bars = '';

        // Sources → Money in. Labels to the right of their bars.
        {
            const ys = spread(sourceNodes.map((n) => n.y + n.h / 2), H);
            let slot = hubTop;
            sourceNodes.forEach((n, i) => {
                const h = Math.max(n.value * scale, MIN_BAND);
                const edge = n.x + NODE_W;
                const lx = edge + LABEL_OFFSET;
                waves += band(n, ribbon(edge, n.y, hubX, slot, h), rampFill(edge, hubX, n.color, opts.hubColor), `${n.label} → ${opts.hubLabel}`,
                    leader(edge, n.y + n.h / 2, lx, ys[i]) + labelBlock(lx, ys[i], 'start', fitName(n.label, labelRoom), amountText(n)));
                bars += `<path class="sankey-node" d="${capPath(n.x, n.y, NODE_W, n.h, -1)}" style="fill: var(${n.color})"/>`;
                slot += n.value * scale;
            });
        }

        // Money in → groups, and each group → its modules. Group labels sit to
        // the left of their bars, in the run they share with Money in's label;
        // module labels to the left of theirs.
        const hubAmount = opts.format(total);
        const hubCy = hubTop + hubH / 2;
        const groupNames = groupNodes.map((g) => fitName(g.label, labelRoom));
        const blockW = (name, amount) => Math.max(nameWidth(name), amountWidth(amount));
        const widestGroup = Math.max(0, ...groupNodes.map((g, i) => blockW(groupNames[i], `${opts.format(g.value)} ${share(g.value, total)}`)));
        const sideBySide = blockW(opts.hubLabel, hubAmount) + widestGroup + LABEL_OFFSET * 3 <= run;
        let hubLy = hubCy;
        let groupLys;
        if (sideBySide) {
            groupLys = spread(groupNodes.map((g) => g.y + g.h / 2), H);
        } else {
            const wanted = [...groupNodes.map((g, i) => ({ y: g.y + g.h / 2, i })), { y: hubCy, hub: true }].sort((a, b) => a.y - b.y);
            const ys = spread(wanted.map((w) => w.y), H);
            groupLys = [];
            wanted.forEach((w, k) => { if (w.hub) hubLy = ys[k]; else groupLys[w.i] = ys[k]; });
        }

        const itemLys = spread(itemNodes.map((n) => n.y + n.h / 2), H);
        let hubSlot = hubTop;
        let itemIdx = 0;
        groupNodes.forEach((g, gi) => {
            const h = Math.max(g.value * scale, MIN_BAND);
            const lx = groupX - LABEL_OFFSET;
            waves += band(g, ribbon(hubX + NODE_W, hubSlot, groupX, g.y, h), rampFill(hubX + NODE_W, groupX, opts.hubColor, g.color), `${opts.hubLabel} → ${g.label}`,
                leader(groupX, g.y + g.h / 2, lx, groupLys[gi]) + labelBlock(lx, groupLys[gi], 'end', groupNames[gi], amountText(g)));
            bars += `<rect class="sankey-node" x="${r1(groupX)}" y="${r1(g.y)}" width="${NODE_W}" height="${r1(g.h)}" style="fill: var(${g.color})"/>`;
            hubSlot += g.value * scale;

            let slot = g.y;
            g.items.forEach(() => {
                const n = itemNodes[itemIdx];
                const ih = Math.max(n.value * scale, MIN_BAND);
                const lx2 = n.x - LABEL_OFFSET;
                waves += band(n, ribbon(groupX + NODE_W, slot, n.x, n.y, ih), rampFill(groupX + NODE_W, n.x, g.color, n.color), `${g.label} → ${n.label}`,
                    leader(n.x, n.y + n.h / 2, lx2, itemLys[itemIdx]) + labelBlock(lx2, itemLys[itemIdx], 'end', fitName(n.label, labelRoom), amountText(n)));
                bars += `<path class="sankey-node" d="${capPath(n.x, n.y, NODE_W, n.h, 1)}" style="fill: var(${n.color})"/>`;
                slot += n.value * scale;
                itemIdx++;
            });
        });

        const hubTip = `<title>${escapeHtml(`${opts.hubLabel}: ${hubAmount}`)}</title>`;
        bars += `<rect class="sankey-node" x="${r1(hubX)}" y="${r1(hubTop)}" width="${NODE_W}" height="${r1(hubH)}" style="fill: var(${opts.hubColor})">${hubTip}</rect>`
              + leader(hubX + NODE_W, hubCy, hubX + NODE_W + LABEL_OFFSET, hubLy)
              + labelBlock(hubX + NODE_W + LABEL_OFFSET, hubLy, 'start', opts.hubLabel, escapeHtml(hubAmount));

        box.insertAdjacentHTML('beforeend',
            `<svg class="chart-svg sankey${entering ? ' sankey-enter' : ''}" viewBox="0 0 ${W} ${H}" role="group" aria-label="${escapeHtml(opts.label)}">`
            + `<defs>${defs}</defs>${waves}${bars}</svg>`);

        const svg = box.lastElementChild;
        const select = (e) => {
            const g = e.target.closest('[data-id]');
            if (g && opts.onSelect) opts.onSelect(g.dataset.id);
        };
        svg.addEventListener('click', select);
        svg.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            select(e);
        });
    }

    window.PlanSankey = { draw };
}());
