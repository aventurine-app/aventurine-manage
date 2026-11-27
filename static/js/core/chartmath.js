'use strict';

// ─── chartmath.js ───────────────────────────────────────────────────────────
// The tick maths every chart in the app shares, in one copy: the charts are
// drawn by Apache ECharts (widgets/echart-kit.js), but their gridlines are
// chosen here, so two charts showing the same numbers always agree on where
// the lines fall. Curves are ECharts' own, which never overshoot the points
// they join (a month of zero is never drawn below zero).
//
//   ChartMath.niceTicks() → the gridline values for a range.
//
// Pure: no DOM, no tokens, no currency. Axis LABELS are a separate concern and
// belong to axisFormatter (core/currency.js), which is handed a whole tick set
// so it can pick one scale for all of them.

(function () {
    /**
     * Gridline values covering [min, max], about `target` of them.
     *
     * Steps are only 2, 5 or 10 × a power of ten, so labels land on round
     * numbers ($20K, $50K, $100K) rather than an awkward $30K or $15K. The
     * range is widened to whole steps at both ends so the first and last
     * gridline sit outside the data rather than through it.
     */
    function niceTicks(min, max, target = 4) {
        if (max <= min) return [min];
        const rough = (max - min) / target;
        const mag = Math.pow(10, Math.floor(Math.log10(rough)));
        const norm = rough / mag;
        let step;
        if      (norm < 2) step = 2  * mag;
        else if (norm < 5) step = 5  * mag;
        else               step = 10 * mag;
        const niceMin = Math.floor(min / step) * step;
        const niceMax = Math.ceil(max / step) * step;
        const ticks = [];
        // Round each tick to suppress the floating-point fuzz that accumulates
        // across the += below.
        for (let v = niceMin; v <= niceMax + step / 2; v += step) {
            ticks.push(Math.round(v * 1e6) / 1e6);
        }
        return ticks;
    }

    window.ChartMath = { niceTicks };
})();
