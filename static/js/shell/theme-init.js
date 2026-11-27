'use strict';

// ─── theme-init.js ──────────────────────────────────────────────────────────
// Applies the saved colour mode and theme before first paint. Loaded as a
// classic (blocking) script in <head> so it runs synchronously during parsing —
// CSP-compatible (script-src 'self' forbids inline scripts).
//
// Two choices, stored apart:
//   'color-mode'  'light' (the default), 'dark' or 'system' (follow the OS; the
//                 live picker, settings.js, repaints when the OS flips).
//   'app-theme'   '' for the Default theme (static/css/theme.css), else the id
//                 of a theme file in the user's themes folder (electron/
//                 themes.js): the file name less ".css".
//
// On <html>: data-mode="light|dark" always, the hook every theme file's two
// halves hang on (:root[data-mode="light"] / [data-mode="dark"]), and
// data-theme="dark" in dark mode, which every dark-only rule in the app reads.
// A theme file loads as <link id="app-theme-file"> from
// app://aventurine/themes/<id>.css, render-blocking so the first paint is
// already in its colours. A file that has gone missing simply 404s, and the
// Default theme shows until the picker (which can see the folder) resets it.
//
// The single 'color-theme' choice Manage used to store (Light, Dark, System,
// Gruvbox, Oblivion, Flexoki Light/Dark, and the older surfaces read as their
// nearest) is split into the two keys once, then dropped.
//
// The chart colours are part of the theme; there is no separate graph palette.
// window.appTheme exposes the reads and the painter to the live picker, so
// which values exist is decided in this one file. 'ui-density' = 'compact'
// tightens table row heights (else comfortable) and is applied the same way.

(function () {
    const MODES = ['light', 'dark', 'system'];

    // The old single choice → [mode, theme].
    const LEGACY = {
        '':              ['light', ''],
        dark:            ['dark', ''],
        'warm-dark':     ['dark', ''],
        system:          ['system', ''],
        gruvbox:         ['dark', 'gruvbox'],
        oblivion:        ['dark', 'oblivion'],
        'flexoki-light': ['light', 'flexoki'],
        'flexoki-dark':  ['dark', 'flexoki'],
    };
    {
        const legacy = localStorage.getItem('color-theme');
        if (legacy !== null) {
            if (localStorage.getItem('color-mode') === null) {
                // Mixed, Warm Light and the hue tints all read as Light.
                const [mode, theme] = LEGACY[legacy] ?? ['light', ''];
                localStorage.setItem('color-mode', mode);
                localStorage.setItem('app-theme', theme);
            }
            localStorage.removeItem('color-theme');
        }
    }

    // The retired graph palette choice ('graph-theme': Opal and the ones before
    // it). Charts now take the theme's own palette, so the stale key is dropped.
    localStorage.removeItem('graph-theme');

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    /** The stored mode choice: one of MODES. Light when none. */
    function mode() {
        const m = localStorage.getItem('color-mode');
        return MODES.includes(m) ? m : 'light';
    }

    /** The mode painted now: 'light' or 'dark' ('system' resolved). */
    function effectiveMode() {
        const m = mode();
        if (m !== 'system') return m;
        return prefersDark.matches ? 'dark' : 'light';
    }

    /** The stored theme: '' (Default) or a theme file's id. */
    function theme() {
        return localStorage.getItem('app-theme') ?? '';
    }

    const LINK_ID = 'app-theme-file';
    let reloads = 0;

    /** Paint the mode and load the theme file onto <html>. Called here
     *  pre-paint and by the live picker after a choice. Resolves once the
     *  theme's colours are in place (the new file loaded, or failed), so a
     *  chart repainting after it reads the new tokens. `reload` re-fetches the
     *  current file after an edit. */
    function apply({ reload = false } = {}) {
        const root = document.documentElement;
        const m = effectiveMode();
        root.dataset.mode = m;
        if (m === 'dark') root.dataset.theme = 'dark';
        else delete root.dataset.theme;

        const id = theme();
        const old = document.getElementById(LINK_ID);
        if (!id) {
            if (old) old.remove();
            return Promise.resolve();
        }
        const base = '/themes/' + encodeURIComponent(id + '.css');
        if (old && old.dataset.themeId === id && !reload) return Promise.resolve();

        // The new sheet goes in beside the old one, which stays until the new
        // one has loaded, so a swap never flashes the Default theme between.
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('blocking', 'render');
        link.dataset.themeId = id;
        link.href = reload ? base + '?v=' + (++reloads) : base;
        if (old) old.removeAttribute('id');
        link.id = LINK_ID;
        return new Promise((resolve) => {
            const done = () => {
                if (old) old.remove();
                resolve();
            };
            link.addEventListener('load', done, { once: true });
            link.addEventListener('error', done, { once: true });
            document.head.appendChild(link);
        });
    }

    window.appTheme = { MODES, mode, effectiveMode, theme, apply };

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
