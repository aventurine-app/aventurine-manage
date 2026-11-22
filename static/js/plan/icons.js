'use strict';

// ─── icons.js ───────────────────────────────────────────────────────────────
// Inline SVG for a Phosphor icon by name. The markup comes from the generated
// core/icon-data.js (scripts/make-ui-icons.js), never from user input,
// so it can go straight into innerHTML.
//
//   planIcon('piggy-bank')

(function () {
    const DATA = window.PLAN_ICON_DATA || { regular: {} };

    function planIcon(name, { cls = '' } = {}) {
        const inner = DATA.regular[name] || DATA.regular['squares-four'] || '';
        const klass = cls ? `icon ${cls}` : 'icon';
        return `<svg class="${klass}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
    }

    window.planIcon = planIcon;
}());
