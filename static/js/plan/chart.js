'use strict';

// ─── chart.js ───────────────────────────────────────────────────────────────
// The charts of Analyze and Compare, drawn as SVG in Ant Design's chart style:
//
//   area   stacked bands over time (accounts above zero, debts below) with
//          lines on top (net worth; or Compare's plans, with no bands)
//   bars   stacked bars per period, ups above zero and downs below, with a
//          line on top (cash flow)
//
// Both share the same frame (recessive dashed grid, compact currency ticks,
// year ticks along the bottom) and the same hover layer: a crosshair, a
// tooltip listing every series at that point, and onHover(index) so the rest
// of the app can follow the cursor through time.
//
// Colours arrive as CSS custom-property names and are applied as
// `fill: var(--x)`, so a theme switch recolours a drawn chart with no redraw.

(function () {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const M = { top: 10, right: 16, bottom: 26, left: 60 };
    // Height of the marker label strip above the plot.
    const MARKER_STRIP = 18;
    // A marker's badge: its height (and the side of the square that holds the
    // target), the target's size, its corner radius, and the padding after
    // its label.
    const BADGE_H = 18;
    const BADGE_ICON = 12;
    const BADGE_R = 4;
    const BADGE_PAD = 6;

    /** Round tick steps (1, 2, 2.5, 5 × 10^n) covering [lo, hi] in ~5 steps. */
    function niceTicks(lo, hi, count = 5) {
        if (hi - lo < 1e-9) hi = lo + 1;
        const raw = (hi - lo) / count;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
        const start = Math.floor(lo / step) * step;
        const end = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = start; v <= end + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-6 ? 0 : v);
        return ticks;
    }

    /** The width of a marker label (12px semibold, as .chart-marker-label
     *  sets it) in the chart's font, measured on a canvas since the chart is
     *  drawn before it joins the page. */
    let measurer = null;
    function labelWidth(box, text) {
        if (!measurer) measurer = document.createElement('canvas').getContext('2d');
        const weight = getComputedStyle(document.documentElement).getPropertyValue('--font-weight-strong').trim() || '600';
        measurer.font = `${weight} 12px ${getComputedStyle(box).fontFamily}`;
        return measurer.measureText(text).width;
    }

    function el(tag, attrs = {}, parent = null) {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        if (parent) parent.appendChild(n);
        return n;
    }

    /**
     * Draw into `box` (a positioned element).
     *   opts.kind       'area' | 'bars'
     *   opts.count      number of x positions
     *   opts.xTicks     [{ i, label }]
     *   opts.bands      area: [{ label, color, values, sign }]   sign -1 stacks below zero
     *   opts.bars       bars: [{ label, color, values, sign }]   sign -1 stacks below zero
     *                   (a negative value flips its side too: an overdrawn
     *                   account stacks below zero with the debts)
     *   opts.gap        bars: px of surface between stacked segments (default 2;
     *                   0 butts them together with no seam)
     *   opts.line       { label, color, values }
     *   opts.lines      [{ label, color, values }], drawn in order, for more than
     *                   one line (opts.line is the one-line form)
     *   opts.between    shade the gap between the first two lines (Compare)
     *   opts.markers    optional [{ i, label, color, fill }]: a dated event at
     *                   index i (a goal met), drawn as a dashed rule topped with
     *                   a rounded badge in a strip above the plot: a white target
     *                   and label on `fill`. `color` and `fill` are custom
     *                   property names for the rule and the badge (default: the
     *                   primary colour; `fill` defaults to `color`). A label that would
     *                   overlap another badge is left off, leaving the target's
     *                   square; the tooltip still names every marker.
     *   opts.format     value → axis label
     *   opts.tooltip    index → { people, title, rows: [{ label, color, value, total }] }
     *                   people: optional [{ name, age }] shown above the title;
     *                   age is text ('Age 42') or '' when it is not known
     *   opts.onHover    index | null
     */
    function draw(box, opts) {
        box.querySelector('.chart-svg')?.remove();
        box.querySelector('.chart-tip')?.remove();
        const W = box.clientWidth;
        const H = box.clientHeight;
        if (W < 60 || H < 60 || opts.count < 2) return;
        const markers = opts.markers || [];
        const lines = opts.lines || (opts.line ? [opts.line] : []);
        // Markers get a strip of their own above the plot for their labels.
        const top = M.top + (markers.length ? MARKER_STRIP : 0);
        const pw = W - M.left - M.right;
        const ph = H - top - M.bottom;

        // ── Domain ─────────────────────────────────────────────────────────
        let lo = 0;
        let hi = 0;
        const n = opts.count;
        const up = new Float64Array(n);
        const down = new Float64Array(n);
        const layers = (opts.kind === 'area' ? opts.bands : opts.bars) || [];
        // Where a layer's value at i sits: above zero (positive) or below.
        // Less than half a cent is nothing, so float dust picks no side.
        const signed = (s, i) => {
            const v = (s.sign < 0 ? -1 : 1) * (s.values[i] || 0);
            return Math.abs(v) < 0.005 ? 0 : v;
        };
        for (const s of layers) {
            for (let i = 0; i < n; i++) {
                const v = signed(s, i);
                if (v < 0) down[i] -= v; else up[i] += v;
            }
        }
        for (let i = 0; i < n; i++) { hi = Math.max(hi, up[i]); lo = Math.min(lo, -down[i]); }
        for (const ln of lines) for (let i = 0; i < n; i++) { hi = Math.max(hi, ln.values[i]); lo = Math.min(lo, ln.values[i]); }
        // A flat-zero plan still gets a readable axis rather than $0..$1.
        if (hi - lo < 1) hi = lo + 1000;
        const ticks = niceTicks(lo, hi);
        const y0 = ticks[0];
        const y1 = ticks[ticks.length - 1];
        const Y = (v) => top + ph - ((v - y0) / (y1 - y0)) * ph;

        const bars = opts.kind === 'bars';
        const slot = bars ? pw / n : 0;
        const X = bars ? (i) => M.left + slot * (i + 0.5) : (i) => M.left + (i / (n - 1)) * pw;

        const svg = el('svg', { class: 'chart-svg', role: 'img', 'aria-label': opts.label || 'Chart' });

        // ── Frame ──────────────────────────────────────────────────────────
        for (const t of ticks) {
            el('line', { class: t === 0 ? 'chart-zero' : 'chart-grid', x1: M.left, x2: M.left + pw, y1: Y(t), y2: Y(t) }, svg);
            const label = el('text', { class: 'chart-tick', x: M.left - 10, y: Y(t) + 4, 'text-anchor': 'end' }, svg);
            label.textContent = opts.format(t);
        }
        for (const t of opts.xTicks || []) {
            const label = el('text', { class: 'chart-tick', x: X(t.i), y: H - 6, 'text-anchor': 'middle' }, svg);
            label.textContent = t.label;
        }

        // ── Marks ──────────────────────────────────────────────────────────
        // The gap between two lines, shaded under them (Compare's plans).
        if (opts.between && lines.length >= 2) {
            const [a, b] = lines;
            let d = '';
            for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(a.values[i]).toFixed(1)}`;
            for (let i = n - 1; i >= 0; i--) d += `L${X(i).toFixed(1)},${Y(b.values[i]).toFixed(1)}`;
            el('path', { class: 'chart-between', d: `${d}Z` }, svg);
        }
        if (!bars) {
            const accUp = new Float64Array(n);
            const accDown = new Float64Array(n);
            for (const s of layers) {
                let top = '';
                let bottom = '';
                for (let i = 0; i < n; i++) {
                    const sv = signed(s, i);
                    const below = sv < 0;
                    const acc = below ? accDown : accUp;
                    const v = Math.abs(sv);
                    const a = acc[i];
                    const b = a + v;
                    acc[i] = b;
                    const ya = Y(below ? -a : a);
                    const yb = Y(below ? -b : b);
                    top += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${yb.toFixed(1)}`;
                    bottom = `L${X(i).toFixed(1)},${ya.toFixed(1)}${bottom}`;
                }
                el('path', { class: 'chart-band', d: `${top}${bottom}Z`, style: `fill: var(${s.color})` }, svg);
            }
        } else {
            // Series stack away from zero: ups upward, downs downward. Only the
            // outermost segment of each stack gets the rounded data end; the
            // others are square, separated by opts.gap of surface. With no gap,
            // each segment tucks 0.5px under the next so antialiasing leaves
            // no hairline between them.
            const bw = Math.max(2, Math.min(36, slot * 0.62));
            const r = Math.min(4, bw / 2);
            const gap = opts.gap ?? 2;
            const accUp = new Float64Array(n);
            const accDown = new Float64Array(n);
            layers.forEach((s, li) => {
                for (let i = 0; i < n; i++) {
                    const sv = signed(s, i);
                    const below = sv < 0;
                    const v = Math.abs(sv);
                    const acc = below ? accDown : accUp;
                    const a = acc[i];
                    const b = a + v;
                    acc[i] = b;
                    if (v <= 0) continue;
                    const ya = Y(below ? -a : a);
                    const yb = Y(below ? -b : b);
                    const join = a > 0 ? (gap || -0.5) : 0;
                    const h = Math.abs(yb - ya) - join;
                    if (h < 0.5) continue;
                    const x = X(i) - bw / 2;
                    const start = below ? ya + join : ya - join;
                    // Is anything stacked beyond this segment at this index?
                    let outer = true;
                    for (let k = li + 1; k < layers.length; k++) {
                        const other = signed(layers[k], i);
                        if (other !== 0 && (other < 0) === below) { outer = false; break; }
                    }
                    const rr = outer ? Math.min(r, h) : 0;
                    const d = below
                        ? `M${x},${start}h${bw}v${h - rr}q0,${rr} ${-rr},${rr}h${-(bw - 2 * rr)}q${-rr},0 ${-rr},${-rr}Z`
                        : `M${x},${start}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${bw - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}Z`;
                    el('path', { class: 'chart-bar', d, style: `fill: var(${s.color})` }, svg);
                }
            });
        }

        // Marker rules sit under the headline line, so the line stays readable.
        // Each hangs from a rounded badge in the marker's colour: a square
        // holding a white target centred on the rule, and the white label
        // after it, or before it where that would cover another badge or run
        // off the plot. With room on neither side the label is left off,
        // leaving the square.
        const placed = [...markers].sort((a, b) => a.i - b.i).map((mk) => ({ mk, x: X(mk.i) }));
        const markY = M.top + 4;
        const half = BADGE_H / 2;
        let badgeEnd = -Infinity;
        for (const { mk, x } of placed) {
            const rule = `color: var(${mk.color || '--color-primary'})`;
            const fill = `fill: var(${mk.fill || mk.color || '--color-primary'})`;
            el('line', { class: 'chart-marker', x1: x, x2: x, y1: markY + half, y2: top + ph, style: rule }, svg);
            const width = labelWidth(box, mk.label) + BADGE_PAD;
            // A label that fits right of its square, else left of it.
            const fits = (from) => {
                const to = from + BADGE_H + width;
                return from >= 0 && to <= W && from >= badgeEnd + 4
                    && !placed.some((o) => o.mk !== mk && Math.abs(o.x - x) > 0.5 && o.x + half + 4 > from && o.x - half - 4 < to);
            };
            const side = fits(x - half) ? 'right' : fits(x - half - width) ? 'left' : null;
            const flip = side === 'left';
            const labelled = side !== null;
            const badge = labelled ? { x: flip ? x - half - width : x - half, w: BADGE_H + width } : { x: x - half, w: BADGE_H };
            badgeEnd = badge.x + badge.w;
            el('rect', { class: 'chart-marker-badge', x: badge.x, y: markY - half, width: badge.w, height: BADGE_H, rx: BADGE_R, style: fill }, svg);
            const target = el('svg', {
                class: 'chart-marker-icon', x: x - BADGE_ICON / 2, y: markY - BADGE_ICON / 2,
                width: BADGE_ICON, height: BADGE_ICON, viewBox: '0 0 256 256',
            }, svg);
            target.innerHTML = window.PLAN_ICON_DATA.regular.target;
            if (!labelled) continue;
            const text = el('text', { class: 'chart-marker-label', x: flip ? x - half : x + half, y: markY + 4, 'text-anchor': flip ? 'end' : 'start' }, svg);
            text.textContent = mk.label;
        }

        for (const ln of lines) {
            let d = '';
            for (let i = 0; i < n; i++) d += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(ln.values[i]).toFixed(1)}`;
            el('path', { class: 'chart-line', d, style: `stroke: var(${ln.color})` }, svg);
        }

        // ── Hover ──────────────────────────────────────────────────────────
        const cross = el('line', { class: 'chart-cross', x1: 0, x2: 0, y1: top, y2: top + ph, visibility: 'hidden' }, svg);
        const dots = lines.map((ln) => el('circle', { class: 'chart-dot', r: 4.5, cx: 0, cy: 0, visibility: 'hidden', style: `fill: var(${ln.color})` }, svg));
        const hit = el('rect', { class: 'chart-hit', x: M.left, y: top, width: pw, height: ph }, svg);
        box.appendChild(svg);

        const tip = document.createElement('div');
        tip.className = 'chart-tip';
        tip.hidden = true;
        box.appendChild(tip);

        let last = -1;
        function show(i) {
            if (i === last) return;
            last = i;
            const x = X(i);
            cross.setAttribute('x1', x);
            cross.setAttribute('x2', x);
            cross.setAttribute('visibility', 'visible');
            dots.forEach((dot, j) => {
                dot.setAttribute('cx', x);
                dot.setAttribute('cy', Y(lines[j].values[i]));
                dot.setAttribute('visibility', 'visible');
            });
            const t = opts.tooltip(i);
            const people = (t.people || []).map((p) => `
                <div class="chart-tip-person"><span>${escapeHtml(p.name)}</span>${p.age ? `<b>${escapeHtml(p.age)}</b>` : ''}</div>`).join('');
            tip.innerHTML = `${people ? `<div class="chart-tip-people">${people}</div>` : ''}<div class="chart-tip-title">${escapeHtml(t.title)}</div>${t.rows.map((r) => `
                <div class="chart-tip-row${r.total ? ' is-total' : ''}"><i style="--swatch: var(${r.color || '--chart-grid'})"></i>
                    <span>${escapeHtml(r.label)}</span><b>${escapeHtml(r.value)}</b></div>`).join('')}`;
            tip.hidden = false;
            const tw = tip.offsetWidth;
            const left = x + 16 + tw > W ? x - 16 - tw : x + 16;
            tip.style.left = `${Math.max(0, left)}px`;
            // A tall tooltip grows upward rather than off the bottom.
            tip.style.top = `${Math.min(M.top, H - tip.offsetHeight - 4)}px`;
            if (opts.onHover) opts.onHover(i);
        }
        function hide() {
            last = -1;
            cross.setAttribute('visibility', 'hidden');
            for (const dot of dots) dot.setAttribute('visibility', 'hidden');
            tip.hidden = true;
            if (opts.onHover) opts.onHover(null);
        }
        hit.addEventListener('pointermove', (e) => {
            const r = svg.getBoundingClientRect();
            const px = e.clientX - r.left - M.left;
            const i = bars ? Math.floor(px / slot) : Math.round((px / pw) * (n - 1));
            show(Math.max(0, Math.min(n - 1, i)));
        });
        hit.addEventListener('pointerleave', hide);
    }

    /** Ticks for a monthly series of `count` points from `plan`'s start:
     *  each point that starts a calendar year (the first only if it is a
     *  January), thinned to at most ~8 labels. */
    function yearTicks(plan, count) {
        const P = window.PlanModel;
        const ticks = [];
        let prev = null;
        for (let i = 0; i < count; i++) {
            const { y, m } = P.ymParse(P.ymAdd(plan.settings.start, i));
            if (i === 0 ? m === 1 : y !== prev) ticks.push({ i, label: String(y) });
            prev = y;
        }
        const step = Math.ceil(ticks.length / 8);
        return ticks.filter((_, i) => i % step === 0);
    }

    window.PlanChart = { draw, yearTicks };
}());
