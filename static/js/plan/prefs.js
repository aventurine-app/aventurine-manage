'use strict';

// ─── prefs.js ───────────────────────────────────────────────────────────────
// The Plan section's per-machine view choices (chart view, plan length, the
// inspector's folds…) in localStorage. Every key is stored under a "plan-"
// prefix, so the section's names never meet Manage's own keys.
//
// Storage can be unavailable or full: a read then falls back and a write is
// simply not kept, so no caller needs a try/catch of its own.
//
//   PlanPrefs.get('outlook-view', 'worth')   reads localStorage 'plan-outlook-view'
//   PlanPrefs.set('outlook-view', 'table')

(function () {
    const PREFIX = 'plan-';

    function get(key, fallback = null) {
        try {
            const v = localStorage.getItem(PREFIX + key);
            return v === null ? fallback : v;
        } catch {
            return fallback;
        }
    }

    function set(key, value) {
        try { localStorage.setItem(PREFIX + key, value); } catch { /* not kept */ }
    }

    window.PlanPrefs = { get, set };
}());
