'use strict';

// ─── donut.js ───────────────────────────────────────────────────────────────
// The segmented ring the Dashboard's Breakdown and Monthly Spending cards
// share, drawn as an Apache ECharts doughnut (widgets/echart-kit.js).
//
// Two forms. By default slices meet edge to edge: their colours separate them,
// and a gap in a ring that sums to a whole reads as missing money. `rounded`
// draws ECharts' Doughnut Chart with Rounded Corner instead: rounded slice
// ends, parted by a thin line of the card's surface (the Breakdown card). The
// figure sits in the hole, sized to it.
//
//   DonutChart.render(host, { slices, centerLabel, centerValue, linkHint, animate, rounded })
//
//   animate    true (default) sweeps the ring in; false redraws it in place
//   rounded    false (default); true for the rounded-corner form
//   slices: [{ label, color, value, valueText, href? }]
//     value      the arc's size, already a positive magnitude
//     valueText  what the slice is worth, as the user reads it (may be signed)
//     href       optional; a click on the slice opens it
//
// The caller decides each slice's colour (from the theme's tokens) and draws
// the legend beside the ring, whose rows are the keyboard-reachable links.
//
// Globals: EChartKit (echart-kit.js).

(function () {
    const INNER = 0.72;   // the hole, as a share of the ring's outer radius
    const OUTER = 0.96;
    // The rounded form: a thicker ring, so its rounded ends have room to read.
    const ROUNDED = { inner: 0.62, outer: 0.96, radius: 8, gap: 2 };

    function render(host, { slices, centerLabel, centerValue, linkHint = '', animate = true, rounded = false }) {
        const inner = rounded ? ROUNDED.inner : INNER;
        const outer = rounded ? ROUNDED.outer : OUTER;
        const label = `${centerLabel} ${centerValue}: ${slices.map((s) => `${s.label} ${s.valueText}`).join(', ')}`;
        EChartKit.mount(host, (t) => {
            // The figure as large as the hole fits it.
            const side = Math.min(host.clientWidth, host.clientHeight);
            const hole = side * inner;
            const valueSize = Math.round(Math.max(12, Math.min(30, hole / (Math.max(centerValue.length, 4) * 0.62))));
            return {
                tooltip: EChartKit.tooltip(t, {
                    trigger: 'item',
                    formatter: (p) => {
                        const s = slices[p.dataIndex];
                        return s ? EChartKit.tipHtml({
                            rows: [{ color: s.color, name: s.label, value: s.valueText }],
                            note: s.href && linkHint ? `Click to ${linkHint}` : '',
                        }) : '';
                    },
                }),
                title: {
                    text: centerValue,
                    subtext: centerLabel,
                    left: 'center',
                    top: 'center',
                    itemGap: 4,
                    textStyle: { color: t.text, fontFamily: t.font, fontSize: valueSize, fontWeight: 600 },
                    subtextStyle: { color: t.textTertiary, fontFamily: t.font, fontSize: 12 },
                },
                series: [{
                    type: 'pie',
                    radius: [`${inner * 100}%`, `${outer * 100}%`],
                    center: ['50%', '50%'],
                    startAngle: 90,
                    avoidLabelOverlap: false,
                    label: { show: false },
                    labelLine: { show: false },
                    // A sliver of a slice still has to be visible and hoverable.
                    minAngle: 2,
                    animationType: 'expansion',
                    itemStyle: rounded
                        ? { borderRadius: ROUNDED.radius, borderColor: t.bgContainer, borderWidth: ROUNDED.gap }
                        : { borderWidth: 0 },
                    emphasis: { scale: true, scaleSize: 4 },
                    cursor: 'pointer',
                    data: slices.map((s) => ({ name: s.label, value: s.value, itemStyle: { color: s.color } })),
                }],
            };
        }, {
            animate,
            label,
            on: {
                click: (p) => {
                    const s = slices[p.dataIndex];
                    if (s && s.href) location.assign(s.href);
                },
            },
        });
    }

    window.DonutChart = { render };
})();
