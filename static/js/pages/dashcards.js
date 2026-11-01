'use strict';

// ─── dashcards.js ─────────────────────────────────────────────────────────────
// The Dashboard's cards: what each widget type is called, which periods it
// offers, the sizes it comes in, the settings it has, how it loads its data and
// how it draws itself into the box the grid gives it. pages/dashboard.js places
// the cards and runs the page (layouts, Customize, the period picker); nothing
// in this file knows about the grid, edit mode or saving.
//
// A CARD DEFINITION (DashCards.TYPES[type]):
//   name, group, info      label, widget-list group, the header's info tip
//   periods, period        the presets it offers (widgets/dashperiod.js) and
//                          the spec a new card starts with
//   sizes, min             S/M/L/XL presets and the minimum, as [columns, rows]
//   defaults, fields       its settings, and the controls for them: a field
//                          with `inline` is a Segmented in the card's header,
//                          the rest sit in the header's gear
//   gear                   a checkbox list in the header gear (Account
//                          Balances only), once its data has entries:
//                          { title, label, heading, options(ctx),
//                            toggle(ctx, key) → settings patch, available(ctx) }
//   chip(ctx, key)         → the settings patch for a click on one of its chips
//   uses                   the Store datasets it reads, so a background refresh
//                          of one redraws exactly the cards that read it
//   skeleton               'rows' for a list-shaped loading placeholder
//   load(ctx)              → Promise of the data it needs for its period
//   render(host, ctx)      draws into `host`, which is ctx.w × ctx.h pixels
//
// ctx is { card, period, data, w, h, animate, hub }: the stored card, its
// resolved period (DashPeriod.resolve), the loaded data, the box, whether this
// paint is an entrance, and the data hub (dashboard.js), whose store(name) and
// json(url) a card's load() reads through. load() gets { card, period, hub }.
// The widget list's schematic of each type is THUMBS, below.
//
// DRAWN IN ANT DESIGN (ant.css): a figure in Statistic's voice, series chips as
// CheckableTags, Progress bars, Tags, Alert, Empty. The charts are the app's
// own engines (widgets/chart.js, donut.js and the two below), in Ant's palette:
// see Colours.
//
// EVERY CARD IS DRAWN FOR A BOX, NOT FOR A PAGE. A card is as large as the user
// sized it on the grid, so each renderer reads ctx.w and ctx.h and decides what
// fits: the charts take the box's height exactly (FinanceChart's `fit`), and the
// lists show as many rows as there is room for.
//
// SECURITY: category, account and merchant names, transaction descriptions and
// card titles are user-controlled. Every one passes through escapeHtml before it
// reaches markup, and the chart reading builds its rows with textContent.

(function () {
    const MONTHS = DashPeriod.MONTH_NAMES;
    const MONTHS_ABBR = DashPeriod.MONTH_SHORT;
    const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m, i]));

    // ─── Shared helpers ──────────────────────────────────────────────────────

    // CURRENCY_SYMBOL and the number format are read at call time inside
    // formatCurrency (currency.js), so a change in Settings shows on the next
    // draw without a reload. A whole amount drops its ".00", as Ant's
    // dashboards print them.
    const fmtValue = (n) => (n === null || n === undefined ? '—' : formatCurrency(n, true));

    /** Every month in a period as { year, monthIdx }, first to last. */
    const slotsOf = (period) => period.slots || [];
    const slotKey = (s) => `${s.year}-${s.monthIdx}`;
    const pad2 = (n) => String(n).padStart(2, '0');
    const isoMonth = (s) => `${s.year}-${pad2(s.monthIdx + 1)}`;
    const lastDayOf = (s) => new Date(s.year, s.monthIdx + 1, 0).getDate();

    /** The ISO dates a month or range spans, both included. */
    function periodDates(period) {
        const a = period.first, b = period.last;
        return { from: `${isoMonth(a)}-01`, to: `${isoMonth(b)}-${pad2(lastDayOf(b))}` };
    }

    /**
     * Deep link into the Transactions ledger for the card's period, optionally
     * narrowed to one category, one merchant or one type of money. A single
     * month keeps Cash Flow's year+month shorthand (the Sankey's link,
     * cashflow-sankey.js); a span of months sends the from/to pair the ledger
     * writes itself. `cat` is the stable category key, so the link survives a
     * rename.
     */
    function ledgerHref(period, { cat, name, type } = {}) {
        const q = new URLSearchParams();
        if (period.slots.length === 1) {
            q.set('year', String(period.first.year));
            q.set('month', String(period.first.monthIdx + 1));
        } else {
            const { from, to } = periodDates(period);
            q.set('from', from);
            q.set('to', to);
        }
        if (cat) q.set('cat', cat);
        if (name) q.set('name', name);
        if (type) q.set('type', type);
        return `/transactions?${q}`;
    }

    /**
     * The Cash Flow statement summed over a period: column key → total of its
     * cells across every month of the period. The statement is the blend point
     * (synced cells are computed from transactions, the rest are hand-entered),
     * so the cards that read it light up for import users and manual bookkeepers
     * alike. Months with no cells add nothing.
     */
    function statementTotals(data, slots) {
        const byKey = new Map();
        for (const s of slots) {
            const cells = ((data.entries || {})[String(s.year)] || {})[MONTHS[s.monthIdx]] || {};
            for (const [key, val] of Object.entries(cells)) {
                if (typeof val === 'number') byKey.set(key, (byKey.get(key) || 0) + val);
            }
        }
        return byKey;
    }

    /**
     * A period's statement, sliced the way the month cards read it: per-type
     * totals, each type's categories (positive cells only, biggest first) and
     * the expense categories alone.
     */
    function sliceStatement(data, slots) {
        const byKey = statementTotals(data, slots);
        const totals = { income: 0, expense: 0, transfer: 0 };
        const segments = { income: [], expense: [], transfer: [] };
        const categories = [];
        for (const col of data.columns || []) {
            const val = byKey.get(col.key);
            if (typeof val !== 'number') continue;
            if (col.type in totals) {
                totals[col.type] += val;
                if (val > 0) segments[col.type].push({ key: col.key, name: col.label, value: val });
            }
            if (col.type === 'expense' && val > 0) categories.push({ key: col.key, name: col.label, total: val });
        }
        for (const list of Object.values(segments)) list.sort((a, b) => b.value - a.value);
        return { totals, segments, categories };
    }

    /**
     * Last-observation-carried-forward snapshot of the balance sheet: for each
     * account column, the value from the most recent month it was filled in, at
     * or before `cutoff` ({ year, monthIdx }, optional). A balance carries forward
     * until the user enters a newer one, so a month that updates one account does
     * not blank out the rest.
     */
    function latestValueByColumn(entries, cutoff) {
        const cutoffT = cutoff ? cutoff.year * 12 + cutoff.monthIdx : Infinity;
        const latest = {};
        for (const [yearStr, months] of Object.entries(entries || {})) {
            const year = parseInt(yearStr, 10);
            for (const [month, cats] of Object.entries(months)) {
                const idx = MONTH_INDEX.get(month);
                if (idx === undefined) continue;
                const t = year * 12 + idx;
                if (t > cutoffT) continue;
                for (const [key, val] of Object.entries(cats)) {
                    const prev = latest[key];
                    if (!prev || t > prev.t) latest[key] = { t, value: val };
                }
            }
        }
        const out = {};
        for (const [key, rec] of Object.entries(latest)) out[key] = rec.value;
        return out;
    }

    /**
     * Net worth over every populated month, oldest first: { year, monthIdx,
     * value }. Debt columns count negative. Each month carries every column's
     * most recent value forward (the same carry-forward the Breakdown donut uses),
     * so a month that updates one account still reports net worth across all of
     * them. A column contributes nothing until its first entry.
     */
    function computeNetWorth(data) {
        const columns = data.columns || [];
        const debtKeys = new Set(columns.filter((c) => c.type === 'debt').map((c) => c.key));
        const months = [];
        for (const year of (data.years || []).slice().sort((a, b) => a - b)) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const idx = MONTH_INDEX.get(month);
                if (idx !== undefined) months.push({ year, monthIdx: idx, cats });
            }
        }
        months.sort((a, b) => a.year - b.year || a.monthIdx - b.monthIdx);
        const latest = {};
        return months.map(({ year, monthIdx, cats }) => {
            Object.assign(latest, cats);
            let total = 0;
            for (const [key, val] of Object.entries(latest)) total += debtKeys.has(key) ? -val : val;
            return { year, monthIdx, value: total };
        });
    }

    /** Keep only the points that fall in the period's months. */
    function inSlots(points, slots) {
        const allowed = new Set(slots.map(slotKey));
        return points.filter((p) => allowed.has(slotKey(p)));
    }

    /** First-to-last change across the points: null with fewer than two, or a
     *  base of 0 (where a percentage would be undefined). */
    function rangeChange(points) {
        if (points.length < 2) return null;
        const first = points[0].value, last = points[points.length - 1].value;
        if (first === 0) return null;
        return { delta: last - first, pct: ((last - first) / Math.abs(first)) * 100 };
    }

    // ─── Colours ─────────────────────────────────────────────────────────────
    // The Graphs palette, as the Reports cards draw it: the primary for a
    // measure over time, the income colour for money arriving, the expense one
    // for money leaving, the transfer one for money put away, and the
    // categorical hues for categories (Ant.categoryHue, the same hue a
    // category's tag wears in the ledger) and for accounts. All of it is
    // var() text over the --ant-chart-* tokens (ant.css), which Preferences
    // re-points; paint() reads the colour it resolves to, because a chart bakes
    // its colours into SVG attributes, where var() is not read.
    const COLOR = {
        primary: 'var(--ant-chart-primary)',
        income: 'var(--ant-chart-income)',
        expense: 'var(--ant-chart-expense)',
        transfer: 'var(--ant-chart-transfer)',
        neutral: 'var(--ant-chart-neutral)',
    };
    // Accounts in column order: the primary first, then the categorical hues.
    const ACCOUNT_HUES = [COLOR.primary, ...[1, 3, 2, 4, 6, 7, 8].map((n) => `var(--ant-chart-${n})`)];
    // The Breakdown ring's slices, fixed BY TYPE so a type keeps its colour
    // across months; debt is the expense colour, so it never reads as one more
    // asset.
    const TYPE_HUES = {
        cash: 'var(--ant-chart-1)', investment: 'var(--ant-chart-3)', retirement: 'var(--ant-chart-2)',
        debt: COLOR.expense,
    };

    let probe = null;
    /** The colour `color` paints as: var() text is put on a probe element and
     *  read back; anything else is already a colour. */
    function paint(color) {
        if (!String(color).includes('var(')) return color;
        if (!probe) {
            probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
            document.body.appendChild(probe);
        }
        probe.style.color = '';
        probe.style.color = color;
        return getComputedStyle(probe).color || color;
    }
    const catColor = (key) => paint(Ant.categoryHue(key));

    /** Account key → colour, walking ACCOUNT_HUES in COLUMN order and wrapping
     *  past the eighth. Column order rather than size rank: an account is an
     *  identity, and a line that changed colour whenever another account grew
     *  past it would be unreadable across a period change. */
    function accountColors(columns) {
        return new Map((columns || []).map((c, i) => [c.key, paint(ACCOUNT_HUES[i % ACCOUNT_HUES.length])]));
    }

    /** [r, g, b] from a #hex, rgb() or color(srgb) colour, else null. */
    function rgbOf(color) {
        const text = String(color || '').trim();
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
        if (hex) {
            let h = hex[1];
            if (h.length === 3) h = h.split('').map((c) => c + c).join('');
            return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        }
        const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
        if (rgb) {
            const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
            if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
        }
        // A colour-mix() result comes back as color(srgb r g b) with channels in 0-1,
        // which is what the Opal palette's primary is (themes.css).
        const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(text);
        if (srgb) {
            const parts = srgb[1].split(/[\s/]+/).filter(Boolean).slice(0, 3).map((n) => Math.round(Number(n) * 255));
            if (parts.length === 3 && parts.every(Number.isFinite)) return parts;
        }
        return null;
    }

    /** The ink that reads on a fill of `color`: white, or Ant's near-black on
     *  a light hue (the cyan, the light green), picked from its luminance. */
    function inkOn(color) {
        const rgb = rgbOf(color);
        if (!rgb) return '#fff';
        const lin = rgb.map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
        return L > 0.4 ? 'rgba(0, 0, 0, 0.88)' : '#fff';
    }

    // ─── Chips ───────────────────────────────────────────────────────────────
    // The Income & Expenses and Account Balances series switches: CheckableTags
    // in their series colour, outlined when off and filled when on.
    const chipsHtml = (chips) => `<div class="dash-chips">${chips.map((c) => {
        const color = paint(c.color);
        return `<button type="button" class="ant-tag ant-tag-checkable" data-chip="${escapeHtml(c.key)}" aria-pressed="${c.on}"
            style="${escapeHtml(`--ant-tag-color:${color};--ant-tag-ink:${inkOn(color)}`)}"><span class="ant-tag-checkable-dot" aria-hidden="true"></span>${escapeHtml(c.label)}</button>`;
    }).join('')}</div>`;

    // ─── Chart frame ─────────────────────────────────────────────────────────
    // The line charts are FinanceChart.buildLine (widgets/chart.js), the
    // renderer every line chart in the app shares; `fit` makes one take its
    // card's height exactly. The column chart below shares its frame (pad,
    // dashed grid, nice-tick axis, label type) so a card of each reads as one
    // family; dashboard.css gives all of them G2's axis chrome.
    const CHART_PAD = { l: 56, r: 20, t: 18, b: 30 };

    const lineChart = (series, slots, W, H, animate) =>
        FinanceChart.buildLine({ series, slots, W, boxH: H, fit: true, animate, centred: true, hover: true });

    /** A card's empty state: Ant's Empty, compact, with the action that fills
     *  it where there is one. */
    const empty = (title, action = null) => Ant.empty({ title, compact: true, action });

    /** Lay a chart body out and hand back its plot box: `head` markup above, a
     *  plot below taking the rest of the height. */
    function chartBody(host, { head = '' } = {}) {
        host.innerHTML = `${head}<div class="dash-plot" data-plot></div>`;
        const plot = host.querySelector('[data-plot]');
        return { plot, W: plot.clientWidth, H: plot.clientHeight };
    }

    /** A card's headline figure over a muted line, in Statistic's voice. Both
     *  arguments are markup: the caller escapes anything user-controlled. */
    const figureHtml = (value, sub = '', tone = '') => `<div class="dash-figure">
        <div class="dash-figure-value${tone ? ` is-${tone}` : ''}">${value}</div>${sub ? `<div class="dash-figure-sub">${sub}</div>` : ''}</div>`;

    /** "▲ $34,760.07 (29.2%)": a change in green when it rose, red when it fell. */
    function changeHtml(change) {
        if (!change) return '<span class="dash-change">—</span>';
        const up = change.delta >= 0;
        const tone = Math.abs(change.pct) < 0.05 ? 'flat' : up ? 'up' : 'down';
        return `<span class="dash-change is-${tone}">${Ant.icon(up ? 'caret-up' : 'caret-down')}<span class="ant-visually-hidden">${up ? 'Up' : 'Down'} </span>`
            + `${escapeHtml(fmtValue(Math.abs(change.delta)))} (${Math.abs(change.pct).toFixed(1)}%)</span>`;
    }

    // ─── Period offers ───────────────────────────────────────────────────────
    // Trend cards draw change over time, so they offer ranges: the five the
    // Year to Year section's range group always had. Period cards add up or
    // snapshot a stretch of the statement, so they offer any month (the current
    // one follows the calendar) or a range added up. Look-ahead cards count
    // forward from today.
    const TREND = ['ytd', 'm6', 'y1', 'y3', 'y5'];
    const SPAN = ['month', 'm3', 'ytd', 'y1'];
    const THIS_MONTH = { preset: 'month', month: null };
    const YEAR_TO_DATE = { preset: 'ytd', month: null };

    const ADD_BALANCES = { label: 'Add balances', href: '/statements#balance-sheet' };
    const OPEN_STATEMENTS = { label: 'Open Statements', href: '/statements#cash-flow' };
    const ADD_TRANSACTIONS = { label: 'Add transactions', href: '/transactions' };

    /** Points for one balance column, oldest first. */
    function columnPoints(data, key) {
        const points = [];
        for (const year of data.years || []) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const monthIdx = MONTH_INDEX.get(month);
                if (monthIdx !== undefined && key in cats) points.push({ year, monthIdx, value: cats[key] });
            }
        }
        return points.sort((a, b) => a.year - b.year || a.monthIdx - b.monthIdx);
    }

    /** The accounts an Account Balances card plots: the stored choice among the
     *  accounts it offers, or the first one offered when it has not chosen yet
     *  (what the card always started with). */
    function plottedAccounts(settings, offered) {
        const keys = new Set(offered.map((c) => c.key));
        if (!Array.isArray(settings.plotted)) return new Set(offered.length ? [offered[0].key] : []);
        return new Set(settings.plotted.filter((k) => keys.has(k)));
    }

    /** Income and expense totals per month, from the statement's typed columns. */
    function incomeExpenseSeries(data) {
        const columns = data.columns || [];
        const incomeKeys = new Set(columns.filter((c) => c.type === 'income').map((c) => c.key));
        const expenseKeys = new Set(columns.filter((c) => c.type === 'expense').map((c) => c.key));
        const income = [], expenses = [];
        for (const year of data.years || []) {
            for (const [month, cats] of Object.entries((data.entries || {})[String(year)] || {})) {
                const monthIdx = MONTH_INDEX.get(month);
                if (monthIdx === undefined) continue;
                let inc = 0, exp = 0, hasInc = false, hasExp = false;
                for (const [key, val] of Object.entries(cats)) {
                    if (incomeKeys.has(key)) { inc += val; hasInc = true; }
                    if (expenseKeys.has(key)) { exp += val; hasExp = true; }
                }
                if (hasInc) income.push({ year, monthIdx, value: inc });
                if (hasExp) expenses.push({ year, monthIdx, value: exp });
            }
        }
        const byDate = (a, b) => a.year - b.year || a.monthIdx - b.monthIdx;
        return [
            { label: 'Income', color: paint(COLOR.income), points: income.sort(byDate) },
            { label: 'Expenses', color: paint(COLOR.expense), points: expenses.sort(byDate) },
        ];
    }

    /** A toggle in a stored list: present → removed, absent → added. */
    const toggled = (list, key) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

    // ─── Monthly Cash Flow ───────────────────────────────────────────────────
    // A row per kind of money: its name (a link to the ledger filtered to it),
    // a bar as long as its total against the largest, split into its
    // categories biggest first, and the total. Under them, what was left over.
    // Income opens on the success green and each further income category takes
    // its own hue; expenses are their categories' hues; transfers are all the
    // info blue, money put away. Every segment links to its category's rows
    // and names itself in a tooltip.
    const MCF_ROWS = [
        { key: 'income', label: 'Income' },
        { key: 'expense', label: 'Expenses' },
        { key: 'transfer', label: 'Transfers' },
    ];

    function segmentColor(type, key, i) {
        if (type === 'transfer') return paint(COLOR.transfer);
        if (type === 'income' && i === 0) return paint(COLOR.income);
        return catColor(key);
    }

    function cashflowHtml(month, period) {
        const rows = MCF_ROWS.map((r) => ({ ...r, value: month.totals[r.key] || 0, segments: month.segments[r.key] || [] }));
        const max = Math.max(...rows.map((r) => r.value), 1);
        const rowHtml = (r) => {
            const segs = r.segments.map((s, i) => {
                const tip = `${s.name}: ${fmtValue(s.value)}`;
                const style = `flex-grow:${s.value};background:${segmentColor(r.key, s.key, i)}`;
                return `<a class="dash-seg" href="${escapeHtml(ledgerHref(period, { cat: s.key }))}" style="${escapeHtml(style)}"
                    data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(`${tip}, view transactions`)}"></a>`;
            }).join('');
            const width = r.value > 0 ? Math.max(2, (100 * r.value) / max) : 0;
            return `<div class="dash-cf-row">
                <a class="dash-cf-label" href="${escapeHtml(ledgerHref(period, { type: r.key }))}">${r.label}</a>
                <div class="dash-cf-track"><div class="dash-cf-bar" style="width:${width.toFixed(2)}%">${segs}</div></div>
                <span class="dash-cf-amount">${escapeHtml(fmtValue(r.value))}</span>
            </div>`;
        };
        const left = month.totals.income - month.totals.expense - month.totals.transfer;
        return `<div class="dash-cf">${rows.map(rowHtml).join('')}
            <div class="dash-cf-net">
                <span class="dash-cf-net-label">${left >= 0 ? 'Left over' : 'Overspent'}</span>
                <span class="dash-cf-net-value is-${left >= 0 ? 'up' : 'down'}">${left >= 0 ? '+' : '-'}${escapeHtml(fmtValue(Math.abs(left)))}</span>
            </div></div>`;
    }

    // ─── Rings: Breakdown and Monthly Spending ───────────────────────────────
    // The ring over its legend, or beside it once the card is wide enough. A
    // legend line is the slice's colour, its name, its amount and its share,
    // and opens where the slice's figure comes from. The ring goes when the box
    // has no room left for one: the figures are the reading, and the ring is
    // their picture.
    const RING_MIN = 96;

    /** rows: [{ label, color, valueText, share (0-1), href }] */
    const legendHtml = (rows) => `<div class="dash-legend">${rows.map((r) => `<a class="dash-legend-row" href="${escapeHtml(r.href)}">
            <span class="dash-dot" style="background:${r.color}" aria-hidden="true"></span>
            <span class="dash-legend-name">${escapeHtml(r.label)}</span>
            <span class="dash-legend-value">${escapeHtml(r.valueText)}</span>
            <span class="dash-legend-share">${(r.share * 100).toFixed(0)}%</span></a>`).join('')}</div>`;

    function renderRing(host, ctx, { slices, centerLabel, centerValue, linkHint }) {
        const total = slices.reduce((s, x) => s + x.value, 0);
        const side = ctx.w >= 380;
        const legend = legendHtml(slices.map((s) => ({
            label: s.label, color: s.color, valueText: s.valueText, share: s.value / total, href: s.href,
        })));
        host.innerHTML = `<div class="dash-donut${side ? ' is-side' : ''}">${legend}<div class="dash-donut-ring"></div></div>`;
        const ring = host.querySelector('.dash-donut-ring');
        if (Math.min(ring.clientWidth, ring.clientHeight) < RING_MIN) {
            ring.remove();
            return;
        }
        DonutChart.render(ring, { slices, centerLabel, centerValue, linkHint, animate: Boolean(ctx.animate) });
        // The figure in the hole, as large as fits it (donut.js draws a 280
        // unit ring whose hole is about 200 across).
        const value = ring.querySelector('.donut-center-value');
        if (value) value.style.fontSize = `${Math.round(Math.min(30, 170 / (Math.max(centerValue.length, 4) * 0.6)))}px`;
    }

    // The ring's slices are Balance Sheet totals per account type, so its
    // destination is the Balance Sheet, where those numbers are entered.
    const BALANCE_SHEET_HREF = '/statements#balance-sheet';

    function renderBreakdown(host, ctx) {
        const data = ctx.data;
        const curr = latestValueByColumn(data.entries, ctx.period.last);
        if (Object.keys(curr).length === 0) {
            // A truly empty balance sheet, or a month from before the first entry.
            host.innerHTML = Object.keys(latestValueByColumn(data.entries)).length
                ? empty(`No balances by ${ctx.period.label}`)
                : empty('No balances to show yet', ADD_BALANCES);
            return;
        }
        const columns = data.columns || [];
        const sumType = (type) => columns.filter((c) => c.type === type).reduce((s, c) => s + (curr[c.key] ?? 0), 0);
        const raw = [
            { label: 'Investments', type: 'investment', signed: sumType('investment') },
            { label: 'Cash',        type: 'cash',       signed: sumType('cash') },
            { label: 'Retirement',  type: 'retirement', signed: sumType('retirement') },
            { label: 'Debt',        type: 'debt',       signed: -sumType('debt') },
        ];
        // Magnitudes: a debt of 12k carries the same weight as 12k of assets.
        const slices = raw.map((s) => ({
            label: s.label,
            color: paint(TYPE_HUES[s.type]),
            value: Math.abs(s.signed),
            valueText: fmtValue(s.signed),
            href: BALANCE_SHEET_HREF,
        })).filter((s) => s.value > 0);
        if (slices.length === 0) {
            host.innerHTML = empty('All balances are zero', { label: 'Edit balances', href: BALANCE_SHEET_HREF });
            return;
        }
        // Assets minus debt at the shown month: Net Worth's sign convention.
        const net = raw.reduce((t, s) => t + s.signed, 0);
        renderRing(host, ctx, { slices, centerLabel: 'Net', centerValue: fmtValue(net), linkHint: 'open the Balance Sheet' });
    }

    // The ring keeps its biggest categories and folds the rest into one slice,
    // so a month with a dozen categories still reads as a ring and a legend.
    const DONUT_CATEGORIES = 6;

    function renderMonthlySpending(host, ctx) {
        const { period } = ctx;
        const slice = sliceStatement(ctx.data, slotsOf(period));
        if (slice.categories.length === 0) {
            host.innerHTML = period.isCurrentMonth
                ? empty('No spending this month yet', ADD_TRANSACTIONS)
                : empty(`Nothing in ${period.label}`);
            return;
        }
        const ranked = [...slice.categories].sort((a, b) => b.total - a.total);
        const shown = ranked.length > DONUT_CATEGORIES + 1 ? ranked.slice(0, DONUT_CATEGORIES) : ranked;
        const slices = shown.map((c) => ({
            label: c.name, value: c.total, color: catColor(c.key), href: ledgerHref(period, { cat: c.key }),
        }));
        const rest = ranked.slice(shown.length);
        if (rest.length) {
            slices.push({
                label: 'Other', value: rest.reduce((s, c) => s + c.total, 0),
                color: paint(COLOR.neutral), href: ledgerHref(period, { type: 'expense' }),
            });
        }
        for (const s of slices) s.valueText = fmtValue(s.value);
        const total = slices.reduce((s, x) => s + x.value, 0);
        renderRing(host, ctx, { slices, centerLabel: 'Spent', centerValue: fmtValue(total), linkHint: 'view transactions' });
    }

    // ─── Spending ────────────────────────────────────────────────────────────
    /** One series per expense category, biggest first so the largest band is the
     *  bottom of every column, each in its category's hue. */
    function spendingSeries(data, slots) {
        const slice = sliceStatement(data, slots);
        return [...slice.categories].sort((a, b) => b.total - a.total).map((c) => {
            const points = [];
            for (const s of slots) {
                const cells = ((data.entries || {})[String(s.year)] || {})[MONTHS[s.monthIdx]] || {};
                if (typeof cells[c.key] === 'number' && cells[c.key] > 0) points.push({ year: s.year, monthIdx: s.monthIdx, value: cells[c.key] });
            }
            return { label: c.name, color: catColor(c.key), points };
        });
    }

    function renderSpending(host, ctx) {
        const { period } = ctx;
        const slots = slotsOf(period);
        const series = spendingSeries(ctx.data, slots);
        if (series.length === 0) {
            host.innerHTML = empty(`Nothing in ${period.label}`, ADD_TRANSACTIONS);
            return;
        }
        const { plot, W, H } = chartBody(host);
        plot.innerHTML = FinanceChart.buildStacked({ series, slots, W, boxH: H, fit: true, animate: ctx.animate }) || '';
    }

    // ─── Lists ───────────────────────────────────────────────────────────────
    // The list cards (Budgets, Top Merchants, Recent Transactions, Upcoming
    // Bills) show as many rows as their box has room for, each list at its own
    // row height; when the items outnumber the rows, the last row becomes a
    // link to the page that lists every one of them.

    // Recent Transactions asks for this many rows, under the server's cap
    // (handlers/transactions.js MAX_LIST_LIMIT). A card at its tallest fits about
    // 17, and its Show filter is applied here, so the request carries spare rows
    // for a filter to thin out.
    const TX_LIMIT = 50;

    /** Lay a list body out: `head` above, the list taking the rest, its rows
     *  `rowH` tall. Returns the list element and how many rows fit in it. */
    function listBody(host, { head = '', rowH = 44, after = '' } = {}) {
        host.innerHTML = `${head}<div class="dash-list" style="--dash-row-h:${rowH}px" data-list></div>${after}`;
        const list = host.querySelector('[data-list]');
        return { list, fits: Math.max(1, Math.floor(list.clientHeight / rowH)) };
    }

    /** Fill `list` with rows for `items`, at most `fits` of them. Past that the
     *  last row links to `more.href`, reading `more.label` or else how many
     *  were left out. */
    function fillList(list, items, fits, rowHtml, more) {
        const overflow = items.length > fits;
        const shown = overflow ? items.slice(0, Math.max(1, fits - 1)) : items;
        const moreLabel = more.label || `${items.length - shown.length} more`;
        list.innerHTML = shown.map(rowHtml).join('')
            + (overflow ? `<a class="dash-more" href="${escapeHtml(more.href)}">${escapeHtml(moreLabel)}${Ant.icon('right')}</a>` : '');
    }

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    /** Ant's line Progress without its figure, filled to `share` (0-1) in
     *  `color`. `thin` is the 4px bar the merchant rows carry. */
    const progressHtml = (share, color, thin = false) => `<span class="ant-progress dash-progress${thin ? ' is-thin' : ''}" aria-hidden="true">
        <span class="ant-progress-outer"><span class="ant-progress-inner">
            <span class="ant-progress-bg dash-progress-bg" style="width:${(clamp01(share) * 100).toFixed(2)}%;background:${color}"></span>
        </span></span></span>`;

    /** The money a ledger row moved, signed and coloured the way the ledger
     *  prints it (tximport.css .tx-amount-*): + for income, − otherwise. */
    const TX_TYPES = new Set(['income', 'expense', 'transfer']);
    const txAmountHtml = (type, amount) => {
        const kind = TX_TYPES.has(type) ? type : 'expense';
        return `<span class="dash-row-amt tx-amount tx-amount-${kind}">${kind === 'income' ? '+' : '-'} ${escapeHtml(formatCurrency(Math.abs(amount)))}</span>`;
    };

    /** A ledger row's category as its Tag, in the hue it wears in the ledger;
     *  none (or a locked Uncategorized bucket) is the warning tag. */
    const categoryTagHtml = (cat) => (!cat || cat.locked
        ? '<span class="ant-tag ant-tag-warning dash-tag">Uncategorized</span>'
        : `<span class="ant-tag ant-tag-hue dash-tag" style="--ant-tag-hue:${Ant.categoryHue(cat.key)}">${escapeHtml(cat.name)}</span>`);

    /** 'YYYY-MM-DD' as a whole-day count, for day arithmetic without time zones. */
    const isoDay = (iso) => {
        const [y, m, d] = String(iso).split('-').map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
    };
    const isoOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    // ─── Savings Rate ────────────────────────────────────────────────────────
    // The share of income moved into the user's own savings or brokerage
    // accounts: the Transfer columns of the Cash Flow statement over its Income
    // columns, the Metrics tab's definition (services/reportCard.js). The goal
    // it is held to starts at the 20% the Metrics tab grades against and is the
    // card's own setting (a percent), so changing it never moves that grade.
    const SAVINGS_GOAL_DEFAULT = 20;
    const SAVINGS_GOAL_MIN = 1;
    const SAVINGS_GOAL_MAX = 100;

    /** A card's saved goal as a 0-1 share. A value outside the range the gear
     *  offers (a hand-edited row) draws the default instead of a broken rule. */
    const savingsGoal = (percent) => (
        Number.isFinite(percent) && percent >= SAVINGS_GOAL_MIN && percent <= SAVINGS_GOAL_MAX
            ? percent : SAVINGS_GOAL_DEFAULT
    ) / 100;
    /** The goal as typed: 20%, 12.5%, never 20.0%. */
    const goalText = (goal) => `${Number((goal * 100).toFixed(1))}%`;
    const pctText = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

    /** Income and transfers per month of the period, and the rate in each. */
    function savingsMonths(data, slots) {
        const columns = data.columns || [];
        const types = new Map(columns.map((c) => [c.key, c.type]));
        return slots.map((slot) => {
            let income = 0, transfers = 0;
            const cells = ((data.entries || {})[String(slot.year)] || {})[MONTHS[slot.monthIdx]] || {};
            for (const [key, val] of Object.entries(cells)) {
                if (typeof val !== 'number') continue;
                if (types.get(key) === 'income') income += val;
                else if (types.get(key) === 'transfer') transfers += val;
            }
            return { slot, income, transfers, rate: income > 0 ? transfers / income : null };
        });
    }

    /** One column per month, the goal as a dashed rule across them, labelled
     *  at its right end. A month that met the goal is the info blue; one that
     *  fell short is the same blue at half strength. A month with no income has
     *  no rate and draws no column. */
    function buildRateChartSVG({ months, W, H, animate, goal }) {
        const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
        const f2 = (n) => Math.round(n * 100) / 100;
        const rates = months.filter((m) => m.rate !== null).map((m) => m.rate);
        const ticks = ChartMath.niceTicks(Math.min(0, ...rates), Math.max(goal * 1.25, ...rates), 4);
        const lo = ticks[0], hi = ticks[ticks.length - 1];
        const CH = Math.max(20, H - PT - PB);
        const y = (v) => PT + CH - ((v - lo) / ((hi - lo) || 1)) * CH;
        const slotW = (W - PL - PR) / months.length;
        const barW = Math.min(slotW * 0.6, 40);
        const color = paint(COLOR.transfer);
        const y0 = y(0);

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">`;
        for (const v of ticks) {
            svg += `<line class="chart-grid" x1="${PL}" y1="${f2(y(v))}" x2="${W - PR}" y2="${f2(y(v))}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(y(v))}" text-anchor="end" dominant-baseline="middle">${Math.round(v * 100)}%</text>`;
        }
        // Month labels thin out to every second, third... month as columns
        // narrow, counted back from the last month so it is always labelled.
        const every = Math.max(1, Math.ceil(36 / slotW));
        const last = months.length - 1;
        months.forEach((m, i) => {
            const cx = PL + slotW * (i + 0.5);
            if (m.rate !== null) {
                const top = Math.min(y(m.rate), y0), h = Math.abs(y0 - y(m.rate));
                const r = m.rate > 0 ? Math.min(3, barW / 2, h) : 0;
                const x = cx - barW / 2;
                const d = `M ${f2(x)} ${f2(top + h)} L ${f2(x)} ${f2(top + r)} Q ${f2(x)} ${f2(top)} ${f2(x + r)} ${f2(top)}`
                        + ` L ${f2(x + barW - r)} ${f2(top)} Q ${f2(x + barW)} ${f2(top)} ${f2(x + barW)} ${f2(top + r)} L ${f2(x + barW)} ${f2(top + h)} Z`;
                const met = m.rate >= goal;
                const tip = `${MONTHS[m.slot.monthIdx]} ${m.slot.year}: ${pctText(m.rate)}, ${fmtValue(m.transfers)} of ${fmtValue(m.income)}${met ? '' : ', under the goal'}`;
                svg += `<path class="chart-bar" d="${d}" fill="${color}"${met ? '' : ' fill-opacity="0.5"'} style="animation-delay:${i * 50}ms"><title>${escapeHtml(tip)}</title></path>`;
            }
            if ((last - i) % every === 0) {
                svg += `<text class="chart-label" x="${f2(cx)}" y="${H - PB + 18}" text-anchor="middle">${MONTHS_ABBR[m.slot.monthIdx]}</text>`;
            }
        });
        svg += `<line class="chart-goal" x1="${PL}" y1="${f2(y(goal))}" x2="${W - PR}" y2="${f2(y(goal))}"><title>Goal: ${goalText(goal)}</title></line>`;
        svg += `<text class="chart-goal-label" x="${W - PR}" y="${f2(y(goal) - 6)}" text-anchor="end">Goal ${goalText(goal)}</text>`;
        return `${svg}</svg>`;
    }

    // ─── Balance Forecast ────────────────────────────────────────────────────
    // The Reports forecast in miniature (widgets/forecast.js carries the
    // reasoning): recorded weekly balances to the left of today, the projection
    // to its right, one hue told apart by weight, solid over a filled area for
    // the past and dashed for the future.
    let forecastSeq = 0;

    function buildForecastSVG(d, W, H, animate) {
        const f2 = (n) => Math.round(n * 100) / 100;
        const { l: PL, r: PR, t: PT, b: PB } = CHART_PAD;
        const anchor = d.anchor || { date: d.series[0].weekStart, balance: d.series[0].balance };
        const anchorPt = { date: anchor.date, balance: anchor.balance, anchor: true };
        const past = [...(d.history || []).map((h) => ({ date: h.weekEnd, balance: h.balance, label: h.label })), anchorPt];
        const future = [anchorPt, ...d.series.map((s) => ({ date: s.weekEnd, balance: s.balance, label: s.label, projected: true }))];

        // Zero joins the axis only when the line nears it, the report's rule:
        // on a healthy balance a zero baseline flattens every movement.
        const values = [...past, ...future].map((p) => p.balance);
        const lo = Math.min(...values), hi = Math.max(...values);
        const span = (hi - lo) || Math.abs(hi) || 1;
        const ticks = ChartMath.niceTicks(lo <= 0 || lo < span * 0.5 ? Math.min(0, lo) : lo, Math.max(0, hi), 4);
        const minV = ticks[0], maxV = ticks[ticks.length - 1];

        const domain = d.domain || { start: past[0].date, end: future[future.length - 1].date };
        const day0 = isoDay(domain.start);
        const days = Math.max(1, isoDay(domain.end) - day0);
        const CW = W - PL - PR, CH = Math.max(20, H - PT - PB);
        const x = (iso) => PL + ((isoDay(iso) - day0) / days) * CW;
        const y = (v) => PT + CH - ((v - minV) / ((maxV - minV) || 1)) * CH;
        const baseY = PT + CH;
        const color = paint(COLOR.primary);
        const negColor = paint(COLOR.expense);
        const id = `dash-fc-${++forecastSeq}`;

        let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="dashboard-chart dash-forecast-chart${animate ? '' : ' chart-no-anim'}" style="display:block;">
            <defs>
                <linearGradient id="${id}-past" gradientUnits="userSpaceOnUse" x1="0" y1="${PT}" x2="0" y2="${baseY}">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.24"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
                </linearGradient>
                <linearGradient id="${id}-next" gradientUnits="userSpaceOnUse" x1="0" y1="${PT}" x2="0" y2="${baseY}">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.12"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
                </linearGradient>
            </defs>`;
        const fmtAxis = axisFormatter(ticks);
        for (const v of ticks) {
            svg += `<line class="chart-grid" x1="${PL}" y1="${f2(y(v))}" x2="${W - PR}" y2="${f2(y(v))}"/>`;
            svg += `<text class="chart-label" x="${PL - 10}" y="${f2(y(v))}" text-anchor="end" dominant-baseline="middle">${escapeHtml(fmtAxis(v))}</text>`;
        }
        if (minV < 0 && maxV > 0) svg += `<line class="chart-zero" x1="${PL}" y1="${f2(y(0))}" x2="${W - PR}" y2="${f2(y(0))}"/>`;

        const todayX = f2(x(anchor.date));
        svg += `<line class="dash-fc-today" x1="${todayX}" y1="${PT}" x2="${todayX}" y2="${baseY}"/>`;
        const labelY = baseY + 18;
        svg += `<text class="chart-label" x="${PL}" y="${labelY}" text-anchor="start">${escapeHtml(fmtShortDate(domain.start))}</text>`;
        svg += `<text class="chart-label dash-fc-today-label" x="${todayX}" y="${labelY}" text-anchor="middle">Today</text>`;
        svg += `<text class="chart-label" x="${W - PR}" y="${labelY}" text-anchor="end">${escapeHtml(fmtShortDate(domain.end))}</text>`;

        const half = (pts, projected) => {
            if (pts.length < 2) return '';
            const xy = pts.map((p) => ({ x: x(p.date), y: y(p.balance) }));
            const line = ChartMath.smoothPath(xy);
            const area = `${line} L ${f2(xy[xy.length - 1].x)} ${baseY} L ${f2(xy[0].x)} ${baseY} Z`;
            return `<path class="dash-fc-area" d="${area}" fill="url(#${id}-${projected ? 'next' : 'past'})"/>
                <path class="${projected ? 'dash-fc-projected' : 'dash-fc-actual'}" d="${line}"${projected ? '' : ' pathLength="1"'}
                    fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        };
        svg += half(past, false) + half(future, true);

        // A dot per week, read through its tooltip, the way the report's are.
        const dot = (p) => {
            const tip = p.anchor ? `Today: ${fmtValue(p.balance)}`
                : `${p.projected ? 'Projected week' : 'Week'} of ${p.label}: ${fmtValue(p.balance)}`;
            const cls = `chart-dot dash-fc-dot${p.anchor ? ' is-anchor' : ''}${p.projected ? ' is-projected' : ''}${p.balance < 0 ? ' is-neg' : ''}`;
            return `<circle class="${cls}" cx="${f2(x(p.date))}" cy="${f2(y(p.balance))}" r="3" fill="${p.balance < 0 ? negColor : color}"><title>${escapeHtml(tip)}</title></circle>`;
        };
        svg += [...past, ...future.slice(1)].map(dot).join('');
        return `${svg}</svg>`;
    }

    // ─── Upcoming Bills ──────────────────────────────────────────────────────
    /** "Today", "Tomorrow" or "In 9 days", counted from `today`. */
    const relativeDay = (iso, today) => {
        const n = isoDay(iso) - isoDay(today);
        return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
    };

    /** Monday or Sunday, as Settings has it (the ledger's date panel reads it
     *  the same way). */
    const weekStartsMonday = () => {
        try { return localStorage.getItem('week_start') === 'monday'; } catch { return false; }
    };

    /** A month grid with the days a bill falls on marked in the error tint and
     *  today ringed: the month the period starts in, drawn beside the list
     *  when the card is wide enough. */
    function billCalendarHtml(bills, start) {
        const y = start.getFullYear(), m = start.getMonth();
        const monday = weekStartsMonday();
        const first = new Date(y, m, 1).getDay();
        const lead = monday ? (first + 6) % 7 : first;
        const length = new Date(y, m + 1, 0).getDate();
        const prefix = `${y}-${pad2(m + 1)}-`;
        const due = new Set(bills.filter((b) => b.date.startsWith(prefix)).map((b) => Number(b.date.slice(8))));
        const names = monday ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        let cells = names.map((d) => `<span class="dash-cal-dow">${d}</span>`).join('');
        cells += '<span></span>'.repeat(lead);
        for (let d = 1; d <= length; d++) {
            const cls = `${due.has(d) ? ' is-due' : ''}${d === start.getDate() ? ' is-today' : ''}`;
            cells += `<span class="dash-cal-day${cls}">${d}</span>`;
        }
        return `<div class="dash-cal" aria-hidden="true"><div class="dash-cal-title">${MONTHS[m]} ${y}</div><div class="dash-cal-grid">${cells}</div></div>`;
    }

    // ─── The cards ───────────────────────────────────────────────────────────
    const TYPES = {
        networth: {
            name: 'Net Worth', group: 'Overview',
            info: 'Computed from the most recent entries in your Balance Sheet.',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 3], M: [4, 6], L: [6, 6], XL: [8, 7] }, min: [3, 3],
            defaults: {}, fields: [],
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            render(host, ctx) {
                const all = computeNetWorth(ctx.data);
                if (all.length === 0) {
                    host.innerHTML = empty('No net worth to chart yet', ADD_BALANCES);
                    return;
                }
                const points = inSlots(all, slotsOf(ctx.period));
                // The figure is the most recent net worth there is, whatever the
                // period; the change is the period's, first month to last.
                const head = figureHtml(escapeHtml(fmtValue(all[all.length - 1].value)), changeHtml(rangeChange(points)));
                // A card sized down to a tile is the figure alone.
                if (ctx.h < 150) { host.innerHTML = head; return; }
                if (points.length === 0) { host.innerHTML = head + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head });
                plot.innerHTML = lineChart([{ label: 'Net Worth', color: paint(COLOR.primary), points }], slotsOf(ctx.period), W, H, ctx.animate) || '';
            },
        },

        accounts: {
            name: 'Account Balances', group: 'Overview',
            info: 'Month-end balances from the Balance Sheet. Choose which accounts to chart with the chips; the gear hides accounts from the chips.',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [8, 7] }, min: [3, 4],
            // hidden: accounts left out of the chips (the gear). plotted: the
            // chips switched on; null until the user has chosen.
            defaults: { hidden: [], plotted: null }, fields: [],
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            gear: {
                title: 'Choose accounts',
                label: 'Choose accounts for this chart',
                heading: 'Accounts on this chart',
                options: (ctx) => (ctx.data.columns || []).map((c) => ({
                    key: c.key, label: c.label, on: !(ctx.card.settings.hidden || []).includes(c.key),
                })),
                // Stored as the HIDDEN set, so an account added later appears
                // without being asked for. Hiding one drops it from the plot too.
                toggle(ctx, key) {
                    const hidden = toggled(ctx.card.settings.hidden || [], key);
                    const plotted = Array.isArray(ctx.card.settings.plotted)
                        ? ctx.card.settings.plotted.filter((k) => !hidden.includes(k)) : null;
                    return { hidden, plotted };
                },
                // Only offered once there are accounts to offer.
                available: (ctx) => (ctx.data && (ctx.data.columns || []).length > 0),
            },
            chip(ctx, key) {
                const offered = (ctx.data.columns || []).filter((c) => !(ctx.card.settings.hidden || []).includes(c.key));
                return { plotted: toggled([...plottedAccounts(ctx.card.settings, offered)], key) };
            },
            render(host, ctx) {
                const data = ctx.data;
                const columns = data.columns || [];
                if (columns.length === 0) {
                    host.innerHTML = empty('No accounts to compare yet', ADD_BALANCES);
                    return;
                }
                const hidden = new Set(ctx.card.settings.hidden || []);
                const offered = columns.filter((c) => !hidden.has(c.key));
                const plotted = plottedAccounts(ctx.card.settings, offered);
                // Colours walk the full column list, so hiding an account never
                // recolours the ones that remain.
                const colors = accountColors(columns);
                const chips = chipsHtml(offered.map((c) => ({ key: c.key, label: c.label, color: colors.get(c.key), on: plotted.has(c.key) })));
                if (plotted.size === 0) { host.innerHTML = chips + empty('Nothing selected'); return; }
                const slots = slotsOf(ctx.period);
                const series = offered.filter((c) => plotted.has(c.key)).map((c) => ({
                    label: c.label, color: colors.get(c.key), points: inSlots(columnPoints(data, c.key), slots),
                }));
                if (!series.some((s) => s.points.length)) { host.innerHTML = chips + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head: chips });
                plot.innerHTML = lineChart(series, slots, W, H, ctx.animate) || '';
            },
        },

        incomeExpenses: {
            name: 'Income & Expenses', group: 'Cash flow',
            info: 'Monthly totals from the Cash Flow statement. Transfers between your own accounts are never counted as either.',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [12, 6] }, min: [3, 4],
            // hidden: the series switched off on the card's chips.
            defaults: { hidden: [] }, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            chip: (ctx, key) => ({ hidden: toggled(ctx.card.settings.hidden || [], key) }),
            render(host, ctx) {
                const all = incomeExpenseSeries(ctx.data);
                if (!all.some((s) => s.points.length)) {
                    host.innerHTML = empty('No income or expenses yet', OPEN_STATEMENTS);
                    return;
                }
                const hidden = new Set(ctx.card.settings.hidden || []);
                const chips = chipsHtml(all.map((s) => ({ key: s.label, label: s.label, color: s.color, on: !hidden.has(s.label) })));
                const slots = slotsOf(ctx.period);
                const visible = all.filter((s) => !hidden.has(s.label)).map((s) => ({ ...s, points: inSlots(s.points, slots) }));
                if (visible.length === 0) { host.innerHTML = chips + empty('Nothing selected'); return; }
                if (!visible.some((s) => s.points.length)) { host.innerHTML = chips + empty('Nothing in this range'); return; }
                const { plot, W, H } = chartBody(host, { head: chips });
                plot.innerHTML = lineChart(visible, slots, W, H, ctx.animate) || '';
            },
        },

        cashflow: {
            name: 'Monthly Cash Flow', group: 'Cash flow',
            info: 'Where the shown month’s money went: income, expenses and transfers from your transactions ledger. Transfers are money moved to your own savings or brokerage accounts, neither income nor spending.',
            periods: ['month'], period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 5], XL: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render(host, ctx) {
                const { period } = ctx;
                const month = sliceStatement(ctx.data, slotsOf(period));
                if (!Object.values(month.totals).some((v) => v > 0)) {
                    host.innerHTML = empty(period.isCurrentMonth ? 'No activity this month yet' : `Nothing in ${period.label}`, OPEN_STATEMENTS);
                    return;
                }
                host.innerHTML = cashflowHtml(month, period);
                if (ctx.animate) host.querySelector('.dash-cf').classList.add('is-entering');
            },
        },

        balances: {
            name: 'Breakdown', group: 'Overview',
            info: 'How your Balance Sheet splits across account types in the shown month: cash, investment, retirement and debt. Each account contributes its most recent balance from that month or earlier, carried forward until you record a newer one.',
            // A snapshot: one month, as of its end.
            periods: ['month'], period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: ['balance'],
            load: (ctx) => ctx.hub.store('balance'),
            render: renderBreakdown,
        },

        spending: {
            name: 'Spending', group: 'Spending',
            info: 'What you’ve spent each month, stacked by category, from your transactions ledger.',
            periods: TREND, period: YEAR_TO_DATE,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6], XL: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render: renderSpending,
        },

        monthlySpending: {
            name: 'Monthly Spending', group: 'Spending',
            info: 'How the shown month’s spending splits across categories, from your transactions ledger.',
            periods: ['month'], period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render: renderMonthlySpending,
        },

        // ─── Cards new with the customizable Dashboard ───────────────────────
        budgets: {
            name: 'Budgets', group: 'Spending',
            info: 'Each budgeted category against its target for the period: a month’s target, times the months shown. Money put away is drawn in blue and never graded.',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 7], L: [6, 7] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: ['ie'],
            load: (ctx) => Promise.all([ctx.hub.store('ie'), ctx.hub.json('/api/budgets')])
                .then(([statement, saved]) => ({ statement, budgets: saved.budgets || [] })),
            // A target is one month's (handlers/budgets.js), so a span of months
            // is held to the target times its length. Spending turns red past
            // its target; money put away is drawn in blue and never graded, the
            // Budgets page's two kinds of circle (budgets.js carries the why).
            render(host, ctx) {
                const { statement, budgets } = ctx.data;
                const targets = new Map(budgets.filter((b) => b.amount > 0).map((b) => [b.category, b.amount]));
                const slots = slotsOf(ctx.period);
                const spent = statementTotals(statement, slots);
                const rows = (statement.columns || [])
                    .filter((c) => (c.type === 'expense' || c.type === 'transfer') && targets.has(c.key))
                    .map((c) => {
                        const target = targets.get(c.key) * slots.length;
                        // A negative cell is not progress toward a target.
                        const actual = Math.max(spent.get(c.key) || 0, 0);
                        const away = c.type === 'transfer';
                        return { key: c.key, label: c.label, target, actual, away, used: actual / target, over: !away && actual > target };
                    });
                if (rows.length === 0) {
                    host.innerHTML = empty('No budgets set', { label: 'Open Budgets', href: '/budgets' });
                    return;
                }
                rows.sort((a, b) => b.used - a.used || a.label.localeCompare(b.label));
                const spending = rows.filter((r) => !r.away);
                const head = ctx.h >= 200 && spending.length
                    ? figureHtml(escapeHtml(fmtValue(spending.reduce((s, r) => s + r.actual, 0))),
                        `of ${escapeHtml(fmtValue(spending.reduce((s, r) => s + r.target, 0)))} budgeted`)
                    : '';
                const { list, fits } = listBody(host, { head, rowH: 48 });
                fillList(list, rows, fits, (r) => {
                    const color = r.away ? COLOR.transfer : r.over ? COLOR.expense : COLOR.primary;
                    const of = `${formatCurrency(r.actual)} of ${formatCurrency(r.target)}`;
                    const tip = r.away ? `${r.label}: ${of} put away` : r.over ? `${r.label}: ${of}, over budget` : `${r.label}: ${of}`;
                    return `<a class="dash-row dash-row-budget" href="${escapeHtml(ledgerHref(ctx.period, { cat: r.key }))}" aria-label="${escapeHtml(tip)}">
                        <span class="dash-row-line">
                            <span class="dash-row-title">${escapeHtml(r.label)}</span>
                            <span class="dash-row-amt"><span class="${r.over ? 'is-over' : ''}">${escapeHtml(fmtValue(r.actual))}</span><span class="dash-row-of"> / ${escapeHtml(fmtValue(r.target))}</span></span>
                        </span>
                        ${progressHtml(r.used, color)}</a>`;
                }, { href: '/budgets' });
            },
        },

        savingsRate: {
            name: 'Savings Rate', group: 'Cash flow',
            info: 'The share of income you moved into your own savings or brokerage accounts, across every transfer category.',
            periods: ['month', 'm3', 'm6', 'ytd', 'y1'], period: YEAR_TO_DATE,
            sizes: { S: [3, 3], M: [4, 5], L: [6, 5], XL: [8, 6] }, min: [3, 3],
            defaults: { goal: SAVINGS_GOAL_DEFAULT },
            fields: [{ key: 'goal', label: 'Savings goal', type: 'percent', min: SAVINGS_GOAL_MIN, max: SAVINGS_GOAL_MAX }],
            uses: ['ie'],
            load: (ctx) => ctx.hub.store('ie'),
            render(host, ctx) {
                const months = savingsMonths(ctx.data, slotsOf(ctx.period));
                const income = months.reduce((s, m) => s + m.income, 0);
                const transfers = months.reduce((s, m) => s + m.transfers, 0);
                if (income <= 0) {
                    const anything = Object.keys(ctx.data.entries || {}).length > 0;
                    host.innerHTML = !anything ? empty('No income or expenses yet', OPEN_STATEMENTS)
                        : empty(ctx.period.isCurrentMonth ? 'No income this month yet' : `No income in ${ctx.period.label}`);
                    return;
                }
                const goal = savingsGoal(ctx.card.settings.goal);
                const head = figureHtml(escapeHtml(pctText(transfers / income)),
                    `Goal ${escapeHtml(goalText(goal))} · ${escapeHtml(fmtValue(transfers))} put away`);
                // A single month, or a card sized down to a tile, is the figure alone.
                if (months.length === 1 || ctx.h < 150) { host.innerHTML = head; return; }
                const { plot, W, H } = chartBody(host, { head });
                plot.innerHTML = buildRateChartSVG({ months, W, H, animate: ctx.animate, goal });
            },
        },

        merchants: {
            name: 'Top Merchants', group: 'Spending',
            info: 'Where the period’s spending went, by merchant, each bar in its main category’s colour. Click one to see its transactions.',
            periods: SPAN, period: THIS_MONTH,
            sizes: { S: [3, 5], M: [4, 6], L: [6, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: [],
            load(ctx) {
                const { first, last } = ctx.period;
                return ctx.hub.json(`/api/top-merchants?start=${isoMonth(first)}&end=${isoMonth(last)}`);
            },
            // Bars scale to the period's top merchant, and each tooltip carries
            // its share of everything spent.
            render(host, ctx) {
                const { period } = ctx;
                const merchants = (ctx.data && ctx.data.merchants) || [];
                if (merchants.length === 0) {
                    host.innerHTML = period.isCurrentMonth
                        ? empty('No spending this month yet', ADD_TRANSACTIONS)
                        : empty(`Nothing in ${period.label}`);
                    return;
                }
                const spent = ctx.data.total || 0;
                const max = merchants[0].total || 1;
                const { list, fits } = listBody(host, { rowH: 44 });
                fillList(list, merchants, fits, (m) => {
                    const share = spent > 0 ? `, ${pctText(m.total / spent)} of spending` : '';
                    const tip = `${m.name}: ${m.count} transaction${m.count === 1 ? '' : 's'}${share}`;
                    const inner = `${merchantAvatarHtml(m.name)}<span class="dash-row-main">
                        <span class="dash-row-line"><span class="dash-row-title">${escapeHtml(m.name)}</span>
                        <span class="dash-row-amt">${escapeHtml(fmtValue(m.total))}</span></span>
                        ${progressHtml(m.total / max, m.category ? Ant.categoryHue(m.category) : COLOR.primary, true)}</span>`;
                    const attrs = `class="dash-row dash-row-merchant" data-tip="${escapeHtml(tip)}" data-tip-placement="left"`;
                    return m.search
                        ? `<a ${attrs} href="${escapeHtml(ledgerHref(period, { name: m.search }))}" aria-label="${escapeHtml(tip)}">${inner}</a>`
                        : `<div ${attrs}>${inner}</div>`;
                }, { href: ledgerHref(period) });
            },
        },

        transactions: {
            name: 'Recent Transactions', group: 'Spending',
            // The newest rows, whatever their date: no period picker or link.
            noPeriod: true,
            periods: SPAN, period: { preset: 'm3', month: null },
            sizes: { S: [4, 5], M: [6, 6], L: [8, 7], XL: [12, 7] }, min: [4, 4],
            defaults: { show: 'all' },
            // In the header, as Ant's Segmented: [value, label, what it shows].
            fields: [{
                key: 'show', label: 'Show', inline: true,
                options: [['all', 'All', 'All transactions'], ['expense', 'Out', 'Expenses only'], ['income', 'In', 'Income only']],
            }],
            skeleton: 'rows',
            uses: [],
            load(ctx) {
                return ctx.hub.json(`/api/transactions?limit=${TX_LIMIT}`);
            },
            render(host, ctx) {
                const show = ctx.card.settings.show;
                const all = ctx.data.transactions || [];
                const rows = all.filter((t) => show === 'all' || t.tx_type === show);
                if (rows.length === 0) {
                    host.innerHTML = all.length
                        ? empty(show === 'income' ? 'No recent income' : 'No recent expenses')
                        : empty('No transactions yet', ADD_TRANSACTIONS);
                    return;
                }
                const cats = new Map((ctx.data.categories || []).map((c) => [c.id, c]));
                const wide = ctx.w >= 560;
                const { list, fits } = listBody(host, { rowH: 44 });
                fillList(list, rows, fits, (t) => {
                    const label = t.display_name || t.description || '';
                    const cat = cats.get(t.category_id);
                    const date = escapeHtml(fmtShortDate(t.date));
                    return wide
                        ? `<div class="dash-row dash-row-tx is-wide"><span class="dash-row-date">${date}</span>${merchantAvatarHtml(label)}
                            <span class="dash-row-title" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${categoryTagHtml(cat)}${txAmountHtml(t.tx_type, t.amount)}</div>`
                        : `<div class="dash-row dash-row-tx">${merchantAvatarHtml(label)}<span class="dash-row-main">
                            <span class="dash-row-title" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
                            <span class="dash-row-sub">${date} · ${escapeHtml(cat && !cat.locked ? cat.name : 'Uncategorized')}</span></span>${txAmountHtml(t.tx_type, t.amount)}</div>`;
                // The response stops at TX_LIMIT rows, so past that the count of
                // what was left out is not known and the link just opens them.
                }, { href: '/transactions', label: all.length >= TX_LIMIT ? 'View all' : '' });
            },
        },

        upcoming: {
            name: 'Upcoming Bills', group: 'Planning',
            info: 'Expenses your recurring schedules expect in the coming days.',
            noLink: true,
            periods: ['d14', 'd30', 'd60'], period: { preset: 'd30', month: null },
            sizes: { S: [3, 5], M: [4, 6], L: [8, 6] }, min: [3, 4],
            defaults: {}, fields: [],
            skeleton: 'rows',
            uses: [],
            // The Recurring page answers one calendar month at a time, so a span
            // that crosses a month end asks for each month it touches.
            load(ctx) {
                const { start, end } = ctx.period;
                const months = DashPeriod.monthsBetween(
                    { year: start.getFullYear(), monthIdx: start.getMonth() },
                    { year: end.getFullYear(), monthIdx: end.getMonth() });
                return Promise.all(months.map((s) => ctx.hub.json(`/api/recurring?month=${isoMonth(s)}`)));
            },
            render(host, ctx) {
                const { period } = ctx;
                const from = isoOf(period.start), to = isoOf(period.end);
                const names = new Map();
                const seen = new Set();
                const bills = [];
                for (const page of ctx.data) {
                    for (const s of page.series || []) names.set(s.key, s.display_name || s.description || s.key);
                    for (const o of page.occurrences || []) {
                        const id = `${o.key}|${o.date}`;
                        if (o.direction !== 'expense' || o.date < from || o.date > to || seen.has(id)) continue;
                        seen.add(id);
                        bills.push(o);
                    }
                }
                if (bills.length === 0) {
                    const schedules = ctx.data.some((page) => (page.series || []).length > 0);
                    host.innerHTML = schedules
                        ? empty(`Nothing due in the ${period.short.toLowerCase()}`)
                        : empty('No recurring bills yet', { label: 'Open Recurring', href: '/recurring' });
                    return;
                }
                bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
                const total = bills.reduce((s, b) => s + b.amount, 0);
                const head = ctx.h >= 170
                    ? figureHtml(escapeHtml(fmtValue(total)), `${bills.length} bill${bills.length === 1 ? '' : 's'} due`) : '';
                const tight = ctx.w < 340;
                const calendar = ctx.w >= 540 && ctx.h >= 250 ? billCalendarHtml(bills, period.start) : '';
                host.innerHTML = `${head}<div class="dash-bills">${calendar}<div class="dash-list" style="--dash-row-h:52px" data-list></div></div>`;
                const list = host.querySelector('[data-list]');
                const fits = Math.max(1, Math.floor(list.clientHeight / 52));
                fillList(list, bills, fits, (b) => {
                    const name = names.get(b.key) || b.key;
                    const [, m, d] = b.date.split('-').map(Number);
                    return `<a class="dash-row dash-row-bill${tight ? ' is-tight' : ''}" href="/recurring" aria-label="${escapeHtml(`${name}: ${formatCurrency(b.amount, true)}, ${relativeDay(b.date, from)}`)}">
                        <span class="dash-datechip${b.date === from ? ' is-today' : ''}" aria-hidden="true"><span>${MONTHS_ABBR[m - 1]}</span><b>${d}</b></span>
                        ${tight ? '' : merchantAvatarHtml(name)}
                        <span class="dash-row-main"><span class="dash-row-title">${escapeHtml(name)}</span>
                            <span class="dash-row-sub">${relativeDay(b.date, from)}</span></span>
                        <span class="dash-row-amt">${escapeHtml(fmtValue(b.amount))}</span></a>`;
                }, { href: '/recurring' });
            },
        },

        forecast: {
            name: 'Balance Forecast', group: 'Planning',
            info: 'Projects one account’s balance forward, week by week, from your typical income and spending over recent complete months.',
            periods: ['f1', 'f3', 'f6'], period: { preset: 'f3', month: null },
            sizes: { S: [3, 4], M: [6, 5], L: [8, 6], XL: [12, 6] }, min: [3, 3],
            defaults: {}, fields: [],
            uses: [],
            load: (ctx) => ctx.hub.json(`/api/forecast?months=${ctx.period.months}`),
            render(host, ctx) {
                const d = ctx.data;
                const series = d.series || [];
                const anything = series.length > 0
                    && ((d.history && d.history.length > 0) || (d.planned || []).length > 0 || !!d.start_balance);
                if (!anything) {
                    host.innerHTML = empty('Nothing to forecast yet', ADD_TRANSACTIONS);
                    return;
                }
                const { summary } = d;
                const account = (d.accounts || []).find((a) => a.key === d.start_account);
                const sub = `${account ? `${escapeHtml(account.label)} · ` : ''}${escapeHtml(fmtShortDate(summary.endDate))}`;
                let head = figureHtml(escapeHtml(fmtValue(summary.endBalance)), sub, summary.endBalance < 0 ? 'neg' : '');
                if (summary.belowZero && summary.lowest) {
                    head += `<div class="ant-alert ant-alert-error dash-alert" role="status">
                        <span class="ant-alert-icon">${Ant.icon('close-circle')}</span>
                        <div class="ant-alert-content"><div class="ant-alert-message">Runs out of money the week of ${escapeHtml(summary.lowest.label)}, down to ${escapeHtml(fmtValue(summary.lowest.balance))}.</div></div>
                    </div>`;
                }
                if (ctx.h < 150) { host.innerHTML = head; return; }
                const { plot, W, H } = chartBody(host, { head });
                plot.innerHTML = buildForecastSVG(d, W, H, ctx.animate);
            },
        },
    };

    // ─── Widget list ─────────────────────────────────────────────────────────
    // Each widget's picture in the widget Drawer: a schematic of its shape in
    // Ant's inks (dashboard.css .dash-thumb), not its data, so the Drawer opens
    // without loading anything.
    const THUMBS = {
        networth: '<rect class="t-ink" x="8" y="8" width="40" height="8" rx="2"/><rect class="t-mute" x="8" y="20" width="26" height="4" rx="2"/>'
            + '<path class="t-line t-a" d="M8 60 C24 56 32 46 48 48 S78 36 92 32 108 26 112 24"/>',
        accounts: '<rect class="t-chip t-a" x="8" y="8" width="22" height="7" rx="3.5"/><rect class="t-chip t-mute" x="34" y="8" width="22" height="7" rx="3.5"/>'
            + '<path class="t-line t-a" d="M8 58 C30 54 40 44 60 46 S96 34 112 30"/><path class="t-line t-c" d="M8 40 C30 42 48 36 66 38 S98 46 112 44"/>',
        incomeExpenses: '<rect class="t-chip t-pos" x="8" y="8" width="22" height="7" rx="3.5"/><rect class="t-chip t-neg" x="34" y="8" width="22" height="7" rx="3.5"/>'
            + '<path class="t-line t-pos" d="M8 36 C28 30 44 38 62 32 S96 26 112 28"/><path class="t-line t-neg" d="M8 56 C28 50 44 58 62 50 S96 52 112 46"/>',
        cashflow: '<rect class="t-fill t-pos" x="30" y="14" width="74" height="10" rx="2"/><rect class="t-fill t-b" x="30" y="32" width="56" height="10" rx="2"/>'
            + '<rect class="t-fill t-c" x="30" y="50" width="22" height="10" rx="2"/><rect class="t-mute" x="8" y="16" width="16" height="5" rx="2"/>'
            + '<rect class="t-mute" x="8" y="34" width="16" height="5" rx="2"/><rect class="t-mute" x="8" y="52" width="16" height="5" rx="2"/>',
        balances: '<circle class="t-ring t-mute" cx="84" cy="36" r="20"/><path class="t-ring t-a" d="M84 16 A20 20 0 0 1 103 42"/>'
            + '<path class="t-ring t-c" d="M103 42 A20 20 0 0 1 72 52"/><rect class="t-ink" x="8" y="18" width="34" height="6" rx="2"/>'
            + '<rect class="t-mute" x="8" y="30" width="26" height="5" rx="2"/><rect class="t-ink" x="8" y="44" width="30" height="6" rx="2"/>',
        spending: '<rect class="t-fill t-b" x="12" y="30" width="12" height="32" rx="2"/><rect class="t-fill t-mute" x="12" y="18" width="12" height="10" rx="2"/>'
            + '<rect class="t-fill t-b" x="36" y="22" width="12" height="40" rx="2"/><rect class="t-fill t-mute" x="36" y="12" width="12" height="8" rx="2"/>'
            + '<rect class="t-fill t-b" x="60" y="38" width="12" height="24" rx="2"/><rect class="t-fill t-mute" x="60" y="28" width="12" height="8" rx="2"/>'
            + '<rect class="t-fill t-b" x="84" y="32" width="12" height="30" rx="2"/><rect class="t-fill t-mute" x="84" y="20" width="12" height="10" rx="2"/>',
        monthlySpending: '<circle class="t-ring t-mute" cx="84" cy="36" r="20"/><path class="t-ring t-b" d="M84 16 A20 20 0 0 1 103 42"/>'
            + '<path class="t-ring t-b" d="M103 42 A20 20 0 0 1 72 52" opacity="0.6"/><rect class="t-ink" x="8" y="18" width="34" height="6" rx="2"/>'
            + '<rect class="t-mute" x="8" y="30" width="26" height="5" rx="2"/><rect class="t-ink" x="8" y="44" width="30" height="6" rx="2"/>',
        budgets: '<rect class="t-mute" x="8" y="12" width="104" height="6" rx="3"/><rect class="t-fill t-a" x="8" y="12" width="70" height="6" rx="3"/>'
            + '<rect class="t-mute" x="8" y="32" width="104" height="6" rx="3"/><rect class="t-fill t-neg" x="8" y="32" width="104" height="6" rx="3"/>'
            + '<rect class="t-mute" x="8" y="52" width="104" height="6" rx="3"/><rect class="t-fill t-c" x="8" y="52" width="44" height="6" rx="3"/>',
        savingsRate: '<rect class="t-ink" x="8" y="8" width="30" height="8" rx="2"/><line class="t-goal" x1="8" y1="38" x2="112" y2="38"/>'
            + '<rect class="t-fill t-c" x="14" y="42" width="12" height="20" rx="2"/><rect class="t-fill t-c" x="36" y="34" width="12" height="28" rx="2"/>'
            + '<rect class="t-fill t-c" x="58" y="40" width="12" height="22" rx="2"/><rect class="t-fill t-c" x="80" y="28" width="12" height="34" rx="2"/>'
            + '<rect class="t-fill t-c" x="102" y="36" width="10" height="26" rx="2"/>',
        merchants: '<circle class="t-fill t-mute" cx="13" cy="15" r="5"/><rect class="t-fill t-b" x="24" y="12" width="80" height="6" rx="3"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="36" r="5"/><rect class="t-fill t-b" x="24" y="33" width="54" height="6" rx="3"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="57" r="5"/><rect class="t-fill t-b" x="24" y="54" width="32" height="6" rx="3"/>',
        transactions: '<circle class="t-fill t-mute" cx="13" cy="15" r="5"/><rect class="t-ink" x="24" y="12" width="52" height="6" rx="2"/><rect class="t-fill t-neg" x="90" y="12" width="22" height="6" rx="2"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="36" r="5"/><rect class="t-ink" x="24" y="33" width="40" height="6" rx="2"/><rect class="t-fill t-pos" x="90" y="33" width="22" height="6" rx="2"/>'
            + '<circle class="t-fill t-mute" cx="13" cy="57" r="5"/><rect class="t-ink" x="24" y="54" width="46" height="6" rx="2"/><rect class="t-fill t-neg" x="90" y="54" width="22" height="6" rx="2"/>',
        upcoming: '<rect class="t-chip t-mute" x="8" y="8" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="10" width="48" height="5" rx="2"/><rect class="t-mute" x="32" y="18" width="28" height="4" rx="2"/>'
            + '<rect class="t-chip t-mute" x="8" y="30" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="32" width="40" height="5" rx="2"/><rect class="t-mute" x="32" y="40" width="22" height="4" rx="2"/>'
            + '<rect class="t-chip t-mute" x="8" y="52" width="16" height="16" rx="3"/><rect class="t-ink" x="32" y="54" width="44" height="5" rx="2"/><rect class="t-mute" x="32" y="62" width="30" height="4" rx="2"/>',
        forecast: '<line class="t-goal" x1="60" y1="8" x2="60" y2="64"/><path class="t-line t-a" d="M8 50 C22 46 34 52 46 44 S56 38 60 38"/>'
            + '<path class="t-line t-a t-dash" d="M60 38 C72 34 84 42 96 32 S108 26 112 24"/>',
    };

    const thumbHtml = (type) => `<svg class="dash-thumb" viewBox="0 0 120 72" aria-hidden="true">${THUMBS[type] || ''}</svg>`;

    // The widget Drawer's groups, in the order they list.
    const GROUPS = ['Overview', 'Cash flow', 'Spending', 'Planning'].map((name) => ({
        name,
        types: Object.keys(TYPES).filter((type) => TYPES[type].group === name),
    }));

    // ─── Default layout ──────────────────────────────────────────────────────
    // The Dashboard as it always was: the Year to Year cards over the Month to
    // Month ones, so a database that never saved a layout opens on the page its
    // user already knows.
    // A card here is { type, x, y, w, h, period?, settings? }; the page fills in
    // the id and anything left out from the card's own definition.
    const MONTH_THIS = { preset: 'month', month: null };
    const OVERVIEW = {
        name: 'Overview',
        cards: [
            { type: 'networth', x: 0, y: 0, w: 4, h: 6 },
            { type: 'accounts', x: 4, y: 0, w: 4, h: 6 },
            { type: 'incomeExpenses', x: 8, y: 0, w: 4, h: 6 },
            { type: 'cashflow', x: 0, y: 6, w: 4, h: 6, period: MONTH_THIS },
            { type: 'balances', x: 4, y: 6, w: 4, h: 6, period: MONTH_THIS },
            { type: 'spending', x: 8, y: 6, w: 4, h: 6, period: MONTH_THIS },
        ],
    };

    window.DashCards = { TYPES, GROUPS, OVERVIEW, thumbHtml };
}());
