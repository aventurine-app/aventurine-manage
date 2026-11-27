'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved color theme before first paint. Loaded as a classic
// (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Sets the data-theme attribute on <html> from localStorage so the saved
// theme is the FIRST paint, with no flash of the default theme on nav.
//
// Stored 'color-theme' values: '' (Light, the default), 'dark', 'gruvbox',
// 'oblivion', 'flexoki-light', 'flexoki-dark', or 'system' (follow the OS; the live picker, settings.js, repaints it when the
// OS preference changes while the app is open). Gruvbox is a dark theme: it
// paints data-theme="dark", so every dark-only rule applies, plus
// data-palette="gruvbox", which re-points the colours (theme.css §5).
// Oblivion and Flexoki Dark are painted the same way (§6, §8). Flexoki Light
// is the one palette theme on the light base: no data-theme, only
// data-palette="flexoki-light" (§7). The surfaces Manage used to offer are read as the nearest one:
// Warm Dark as Dark, and Mixed ('colorful'), Warm Light and the hue tints
// ('tint-<hue>') as Light. A stale value is rewritten, so the picker lights the
// choice that is actually painted.
//
// The chart colours are part of the theme (theme.css); there is no separate
// graph palette any more.
//
// The theme lands on <html> as data-theme before first paint, to avoid a flash
// of the wrong theme on nav. window.appTheme exposes the same reads and the painter to
// the live picker, so which values exist is decided in this one file. 'ui-density' =
// 'compact' tightens table row heights (else comfortable) and is applied the
// same way.

(function () {
    // Retired surfaces, and the theme each is now read as.
    const RETIRED_SURFACES = { 'warm-dark': 'dark' };
    // Themes painted as a base (Light '' or 'dark') plus a palette of their
    // own (theme.css), keyed by palette, valued by base.
    const PALETTES = {
        gruvbox: 'dark',
        oblivion: 'dark',
        'flexoki-light': '',
        'flexoki-dark': 'dark',
    };
    const SURFACES = ['', 'dark', 'system', ...Object.keys(PALETTES)];
    {
        const stored = localStorage.getItem('color-theme');
        if (stored !== null && !SURFACES.includes(stored)) {
            localStorage.setItem('color-theme', RETIRED_SURFACES[stored] ?? '');
        }
    }

    // The retired graph palette choice ('graph-theme': Opal and the ones before
    // it). Charts now take the theme's own palette, so the stale key is dropped.
    localStorage.removeItem('graph-theme');

    /** The stored surface choice: one of SURFACES. Light when none. */
    function surface() {
        return localStorage.getItem('color-theme') ?? '';
    }

    /** Paint the theme onto <html>. Called here pre-paint and by the live
     *  picker after a choice. */
    function apply() {
        const root = document.documentElement;
        const s = surface();
        const effective = s === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '')
            : s;
        const base = Object.hasOwn(PALETTES, effective) ? PALETTES[effective] : effective;
        if (base) root.dataset.theme = base;
        else delete root.dataset.theme;
        if (base !== effective) root.dataset.palette = effective;
        else delete root.dataset.palette;
    }

    window.appTheme = { surface, apply };

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
    // Each folds on its own. The app always launches with Manage open and
    // the rest folded; after that, folds are remembered from page to page.
    // "After that" is told by a slot in the window's ViewState bag
    // (core/viewstate.js, loaded later, so its format is read by hand here):
    // window.name lives as long as the window, so a launch finds it empty.
    // A database switch clears the bag too, which resets the folds the same way.
    const VIEWSTATE_TAG = 'aventurine:viewstate';
    let bag = null;
    try {
        const parsed = JSON.parse(window.name);
        if (parsed && parsed.tag === VIEWSTATE_TAG && parsed.slots) bag = parsed;
    } catch { /* unset or not ours */ }
    if (!(bag && bag.slots.navStarted)) {
        localStorage.setItem('nav-closed', 'plan');
        if (bag || !window.name) {
            bag = bag || { tag: VIEWSTATE_TAG, slots: {} };
            bag.slots.navStarted = true;
            window.name = JSON.stringify(bag);
        }
    }
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
