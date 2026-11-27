'use strict';

// ─── scrubber.js ────────────────────────────────────────────────────────────
// The slim bar under the plan builder's canvas: the plan's net worth over its
// whole run, drawn small (Apache ECharts, through widgets/echart-kit.js). Moving along it (pointer, or arrow keys once
// focused) scrubs the plan to that month (PlanStore.setScrub), and the module
// cards follow; the canvas's time island names the month. Leaving it goes
// back to the plan's end. The full charts are in Analyze.
//
// Pins mark where the plan's issues start and where its debts are paid off:
// one per month, a dot on the line coloured as its worst issue (green when it
// holds only payoffs), under a button the pointer and keyboard reach. Pointing at one lists what happens then, while the scrub follows
// the pointer; focusing one scrubs to its month; pressing it selects what the
// first item is about. Issues that
// belong to no month (a loop, money with no link) have no pin: the inspector
// lists every issue. On the bar's right, the length every plan runs over
// (PlanStore.setYears), as the chips Analyze shows.

(function () {
    const root = document.getElementById('scrubber');
    if (!root) return;

    const LENGTHS = PlanStore.LENGTHS;

    root.innerHTML = `
        <div class="scrub-lane">
            <div class="scrub-track" role="slider" tabindex="0" aria-label="Net worth over time" aria-valuemin="0">
                <div class="scrub-plot" aria-hidden="true">
                    <div class="scrub-canvas"></div>
                    <span class="scrub-cursor"></span>
                    <span class="scrub-dot"></span>
                </div>
                <span class="scrub-edge scrub-edge--start" aria-hidden="true"></span>
                <span class="scrub-edge scrub-edge--end" aria-hidden="true"></span>
            </div>
            <div class="scrub-pins" role="group" aria-label="Issues and payoffs by month"></div>
            <div class="scrub-tip" aria-hidden="true" hidden></div>
        </div>
        <div class="scrub-length">
            <div class="ant-segmented ant-segmented-sm plan-chips" role="group" aria-label="Plan length">
                ${LENGTHS.map((y) => `<button class="ant-segmented-item" type="button" data-years="${y}">${y}Y</button>`).join('')}
            </div>
        </div>`;

    const track = root.querySelector('.scrub-track');
    const canvas = root.querySelector('.scrub-canvas');
    const cursor = root.querySelector('.scrub-cursor');
    const dot = root.querySelector('.scrub-dot');
    const startEl = root.querySelector('.scrub-edge--start');
    const endEl = root.querySelector('.scrub-edge--end');
    const lengthBtns = root.querySelectorAll('[data-years]');
    const pinsEl = root.querySelector('.scrub-pins');
    const tip = root.querySelector('.scrub-tip');

    // The drawn run: its net worth series and the value range drawn.
    let drawn = null;
    let dragging = false;

    /** Draw the net worth line with Apache ECharts (widgets/echart-kit.js),
     *  edge to edge in the plot, with the pins as marks on it. The value range
     *  is fixed here (not left to the chart), so the cursor's dot can be placed
     *  over the line by percentage. */
    function draw() {
        const plan = PlanStore.state.plan;
        const res = PlanStore.state.results;
        if (!plan || !res) return;
        const worth = res.netWorth;
        const n = res.months;
        let lo = 0;
        let hi = 0;
        for (let k = 0; k <= n; k++) { lo = Math.min(lo, worth[k]); hi = Math.max(hi, worth[k]); }
        if (hi - lo < 1) hi = lo + 1;
        const pad = (hi - lo) * 0.08;
        lo -= lo < 0 ? pad : 0;
        hi += pad;
        drawn = { worth, n, lo, hi };
        // The first and last months, as the cards name them at either end.
        startEl.textContent = window.Describe.monthLabel(plan, 0);
        endEl.textContent = window.Describe.monthLabel(plan, n - 1);
        track.setAttribute('aria-valuemax', String(n));
        lengthBtns.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.years) === PlanStore.state.years)));
        drawPins(plan, res);
        drawLine();
        place();
    }

    /** A pin's colour: its worst issue's level. */
    const PIN_TOKEN = { warn: '--color-warning', notice: '--color-info', info: '--color-text-tertiary', done: '--color-success' };

    function drawLine() {
        const { worth, n, lo, hi } = drawn;
        const values = Array.from({ length: n + 1 }, (_, k) => worth[k]);
        EChartKit.mount(canvas, (t) => {
            const color = EChartKit.color('--color-primary', root) || t.primary;
            return {
                grid: { left: 0, right: 0, top: 0, bottom: 0 },
                xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, k) => k) },
                yAxis: { type: 'value', show: false, min: lo, max: hi },
                series: [{
                    type: 'line',
                    silent: true,
                    symbol: 'none',
                    color,
                    lineStyle: { width: 1.5 },
                    // The area fills down to zero, or to the bottom when
                    // nothing is negative.
                    areaStyle: { color: EChartKit.alpha(color, 0.1), origin: lo < 0 ? 0 : 'start' },
                    data: values,
                    markLine: lo < 0 ? {
                        silent: true,
                        symbol: 'none',
                        label: { show: false },
                        lineStyle: { color: EChartKit.color('--color-border', root) || t.border, type: [3, 3], width: 1 },
                        data: [{ yAxis: 0 }],
                    } : undefined,
                    // The pins: a dot on the line at each month an issue starts
                    // or a debt is paid off. The buttons over them (.scrub-pin)
                    // are what the pointer and the keyboard reach.
                    markPoint: {
                        silent: true,
                        symbol: 'circle',
                        symbolSize: 10,
                        label: { show: false },
                        animation: false,
                        data: pins.map((p) => ({
                            coord: [p.k, worth[p.k]],
                            itemStyle: {
                                color: EChartKit.color(PIN_TOKEN[p.level] || PIN_TOKEN.warn, root) || t.warning,
                                borderColor: t.bgContainer,
                                borderWidth: 2,
                            },
                        })),
                    },
                }],
            };
        }, { animate: false, label: 'Net worth over time' });
    }

    // ── Pins ───────────────────────────────────────────────────────────────

    // A payoff ('done') is good news, so any issue in its month outranks it.
    const LEVEL_RANK = { warn: 2, notice: 1, info: 0, done: -1 };
    const TIP_ICON = { warn: 'warning', notice: 'info', info: 'info', done: 'check' };
    let pins = [];      // [{ k, month, level, items: [{ level, text, select }] }], by k

    /** One pin per balance point that an issue starts or a debt is paid off
     *  at. A month's money lands at its end, so what happens in month m shows
     *  at point m + 1, where the cards show that month. A month's issues are
     *  listed before its payoffs. */
    function drawPins(plan, res) {
        const D = window.Describe;
        const byK = new Map();
        const add = (month, d) => {
            const k = Math.min(res.months, month + 1);
            if (!byK.has(k)) byK.set(k, { k, month, level: d.level, items: [] });
            const pin = byK.get(k);
            pin.items.push(d);
            if (LEVEL_RANK[d.level] > LEVEL_RANK[pin.level]) pin.level = d.level;
        };
        for (const w of res.warnings) {
            if (w.month != null && w.month >= 0) add(w.month, D.warning(w, plan));
        }
        // Only a debt owed going into its payoff month: a card paid in full as
        // it is charged clears in its first month but was never carried.
        for (const ms of res.milestones) {
            if (ms.code === 'paid-off' && res.nodes[ms.nodeId].balance[ms.month] > 0.005) add(ms.month, D.payoff(ms, plan));
            else if (ms.code === 'stops') add(ms.month, D.incomeStop(ms, plan));
        }
        pins = [...byK.values()].sort((a, b) => a.k - b.k);
        const n = res.months;
        pinsEl.innerHTML = pins.map((p, i) => {
            const label = `${D.monthLabel(plan, p.month)}: ${p.items.map((d) => d.text).join(' ')}`;
            return `<button class="scrub-pin" type="button" data-pin="${i}" data-level="${p.level}"
                style="left:${n ? (p.k / n) * 100 : 0}%" aria-label="${escapeHtml(label)}"></button>`;
        }).join('');
        hideTip();
    }

    /** List a pin's issues over it. Focus scrubs to the pin's point; a
     *  pointer keeps scrubbing to where it is (the pins lie over the track,
     *  and snapping to them left the months under each one out of reach). */
    function showTip(btn, snap) {
        const p = pins[Number(btn.dataset.pin)];
        if (!p) return;
        tip.innerHTML = p.items.map((d) => `<p class="scrub-tip-row" data-level="${d.level}">${
            planIcon(TIP_ICON[d.level])}<span>${escapeHtml(d.text)}</span></p>`).join('');
        tip.hidden = false;
        // Centred over the pin, kept inside the lane.
        const lane = tip.parentElement.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        const half = tip.offsetWidth / 2;
        const x = Math.max(half, Math.min(lane.width - half, b.left + b.width / 2 - lane.left));
        tip.style.left = `${x}px`;
        if (snap) PlanStore.setScrub(p.k);
    }

    function hideTip() {
        tip.hidden = true;
    }

    pinsEl.addEventListener('pointerover', (e) => {
        const btn = e.target.closest('.scrub-pin');
        if (btn) showTip(btn, false);
    });
    pinsEl.addEventListener('pointermove', (e) => {
        if (drawn && !dragging) PlanStore.setScrub(pointAt(e.clientX));
    });
    pinsEl.addEventListener('pointerout', (e) => {
        const btn = e.target.closest('.scrub-pin');
        if (!btn || btn.contains(e.relatedTarget)) return;
        hideTip();
        // Onto the track (or the next pin), the scrub carries on from there.
        if (document.activeElement !== btn && !track.contains(e.relatedTarget)
            && !pinsEl.contains(e.relatedTarget)) PlanStore.setScrub(null);
    });
    pinsEl.addEventListener('focusin', (e) => {
        const btn = e.target.closest('.scrub-pin');
        if (btn) showTip(btn, true);
    });
    pinsEl.addEventListener('focusout', () => {
        hideTip();
        PlanStore.setScrub(null);
    });
    pinsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.scrub-pin');
        const p = btn && pins[Number(btn.dataset.pin)];
        const target = p && p.items.find((d) => d.select);
        if (target) PlanStore.select(target.select);
    });

    /** Put the cursor and the dot at the scrubbed point, or the end. */
    function place() {
        if (!drawn) return;
        const plan = PlanStore.state.plan;
        const { worth, n, lo, hi } = drawn;
        const scrub = PlanStore.state.scrub;
        const k = scrub == null ? n : Math.max(0, Math.min(n, scrub));
        const v = worth[k];
        const x = n ? (k / n) * 100 : 0;
        const yPct = ((hi - v) / (hi - lo)) * 100;
        cursor.style.left = `${x}%`;
        dot.style.left = `${x}%`;
        dot.style.top = `${yPct}%`;
        root.classList.toggle('is-scrubbing', scrub != null);
        dot.classList.toggle('is-negative', v < 0);
        track.setAttribute('aria-valuenow', String(k));
        // Point k is the end of month k - 1, which is the month the cards show.
        track.setAttribute('aria-valuetext', `${window.Describe.monthLabel(plan, Math.max(0, k - 1))}: ${Fmt.money(v)}`);
    }

    /** The balance point under a pointer at clientX. */
    function pointAt(clientX) {
        const r = track.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
        return Math.round(f * (drawn ? drawn.n : 0));
    }

    track.addEventListener('pointermove', (e) => {
        if (drawn) PlanStore.setScrub(pointAt(e.clientX));
    });
    track.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !drawn) return;
        dragging = true;
        track.setPointerCapture(e.pointerId);
        PlanStore.setScrub(pointAt(e.clientX));
    });
    const release = () => { dragging = false; };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);
    track.addEventListener('pointerleave', (e) => {
        // Onto a pin, which lies over the track, the scrub goes on following.
        if (pinsEl.contains(e.relatedTarget)) return;
        if (!dragging && document.activeElement !== track) PlanStore.setScrub(null);
    });
    track.addEventListener('blur', () => PlanStore.setScrub(null));

    // Arrows step a month (Shift: a year); Home and End jump; Escape lets go.
    track.addEventListener('keydown', (e) => {
        if (!drawn) return;
        const { n } = drawn;
        const now = PlanStore.state.scrub == null ? n : PlanStore.state.scrub;
        const step = e.shiftKey ? 12 : 1;
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n, now + step);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, now - step);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = n;
        else if (e.key === 'Escape') { PlanStore.setScrub(null); return; }
        else return;
        e.preventDefault();
        PlanStore.setScrub(next);
    });

    root.querySelector('.scrub-length').addEventListener('click', (e) => {
        const b = e.target.closest('[data-years]');
        if (b) PlanStore.setYears(Number(b.dataset.years));
    });

    PlanStore.on((c) => {
        if (c.type === 'results') draw();
        else if (c.type === 'scrub') place();
    });
    // A Format change (Preferences) rewrites the amounts in the issues and
    // the slider's spoken value.
    window.addEventListener('currencychange', draw);
}());
