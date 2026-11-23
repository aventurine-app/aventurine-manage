'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved color theme before first paint. Loaded as a classic
// (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Sets the data-theme attribute on <html> from localStorage so the saved
// theme is the FIRST paint, with no flash of the default theme on nav.
//
// Stored 'color-theme' values: '' (Light, the default), 'dark', or 'system'
// (follow the OS; the live picker, settings.js, repaints it when the OS
// preference changes while the app is open). They are the Aventurine theme's
// (static/css/theme.css, shared with Aventurine Planner), which has these two
// faces only. The surfaces Manage used to offer are read as the nearest one:
// Warm Dark as Dark, and Mixed ('colorful'), Warm Light and the hue tints
// ('tint-<hue>') as Light. A stale value is rewritten, so the picker lights the
// choice that is actually painted.
//
// Stored 'graph-theme' values: '' (Ant Design's chart palette, the default) or
// 'opal' (the same palette, desaturated). The graph palette is a SECOND,
// independent axis from the surface (see the block at the foot of themes.css).
//
// Both axes land on <html> as data-* before first paint, to avoid a flash of the
// wrong theme on nav. window.appTheme exposes the same reads and the painter to
// the live picker, so which values exist is decided in this one file. 'ui-density' =
// 'compact' tightens table row heights (else comfortable) and is applied the
// same way.

(function () {
    // Retired surfaces, and the theme each is now read as.
    const RETIRED_SURFACES = { 'warm-dark': 'dark' };
    {
        const stored = localStorage.getItem('color-theme');
        if (stored !== null && stored !== '' && stored !== 'dark' && stored !== 'system') {
            localStorage.setItem('color-theme', RETIRED_SURFACES[stored] ?? '');
        }
    }

    // Palettes this app used to offer (the accent-derived Aventurine ramp,
    // 'gemstone', 'lapis', 'labradorite', and 'colorful' before them) are gone.
    // An unknown value is not an error anywhere, it just falls through to the
    // default with no picker button lit, so a stale one is rewritten to the
    // default rather than left to look as though no palette had been chosen.
    {
        const stored = localStorage.getItem('graph-theme');
        if (stored !== null && stored !== '' && stored !== 'opal') {
            localStorage.setItem('graph-theme', '');
        }
    }

    /** The stored surface choice: '', 'dark' or 'system'. Light when none. */
    function surface() {
        return localStorage.getItem('color-theme') ?? '';
    }

    /** The stored graph palette; '' (the default) when none is stored. */
    function graph() {
        return localStorage.getItem('graph-theme') ?? '';
    }

    /** Paint both axes onto <html>. Called here pre-paint and by the live
     *  picker after a choice. */
    function apply() {
        const root = document.documentElement;
        const s = surface();
        const effective = s === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')
            : s;
        if (effective) root.dataset.theme = effective;
        else delete root.dataset.theme;

        const g = graph();
        if (g) root.dataset.graphTheme = g;
        else delete root.dataset.graphTheme;
    }

    window.appTheme = { surface, graph, apply };

    apply();

    if (localStorage.getItem('ui-density') === 'compact') {
        document.documentElement.dataset.density = 'compact';
    }

    // A collapsed sidebar (nav.js) is restored pre-paint too, so it never
    // flashes open and then snaps shut.
    if (localStorage.getItem('nav-rail') === '1') {
        document.documentElement.classList.add('has-rail');
    }
    // Likewise the sidebar's folded sections ('manage', 'plan'; nav.js).
    // Each folds on its own; with nothing saved yet, all are open.
    const navClosed = localStorage.getItem('nav-closed');
    if (navClosed) document.documentElement.dataset.navClosed = navClosed;

    // Tag the host OS so the custom title bar (titlebar.css) can match the
    // platform's native window controls: macOS traffic lights on the left,
    // square Windows-style controls on the right elsewhere. Set pre-paint so
    // the bar never flashes the wrong layout. electronWindow comes from the
    // preload bridge; absent in a plain browser (no chrome there to style).
    const plat = window.electronWindow && window.electronWindow.platform;
    document.documentElement.dataset.platform =
        plat === 'darwin' ? 'mac' : plat === 'win32' ? 'win' : 'linux';
}());
