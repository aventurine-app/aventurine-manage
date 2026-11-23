'use strict';

// Highlights the current page's link in the shared sidebar. The sidebar is one
// partial served to every route (pages/partials/sidebar.html), so the .active
// class can no longer be baked into per-page markup — derive it from the URL.
//
// The Plan page's links differ only by hash (/plan#goals names a Planner
// workspace), so on /plan the hash is part of the match, and it is matched
// again whenever it changes (static/js/plan/main.js changes it without a reload).
(function () {
  function currentRoute() {
    let p = location.pathname;
    // Plain-browser mode: a page opened straight from pages/ — map
    // ".../pages/dashboard.html" back to its app:// route shape.
    const m = p.match(/\/pages\/([\w-]+)\.html$/);
    if (m) p = m[1] === 'dashboard' ? '/' : `/${m[1]}`;
    if (p === '/plan') p += `#${location.hash.slice(1) || 'plans'}`;
    return p;
  }

  function markActive() {
    const p = currentRoute();
    document.querySelectorAll('.menu .nav a[href]').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === p);
    });
  }

  markActive();
  window.addEventListener('hashchange', markActive);
}());

// ── Sections: Manage and Plan ────────────────────────────────────────────
// Each header folds its own links away; the sections are independent, so
// any mix of them can be open at once. The folded ones are kept as one
// space-separated list
// ('nav-closed' in localStorage), which theme-init.js puts on
// <html data-nav-closed> before first paint; nav.css reads it from there, so
// this file only rewrites the list and keeps aria-expanded and inert in step
// with it.
(function () {
  const KEY = 'nav-closed';
  const root = document.documentElement;
  const toggles = [...document.querySelectorAll('.nav-section-toggle[data-section]')];
  if (!toggles.length) return;

  const closedSet = () => new Set((root.dataset.navClosed || '').split(' ').filter(Boolean));

  function sync() {
    const closed = closedSet();
    for (const btn of toggles) {
      const open = !closed.has(btn.dataset.section);
      btn.setAttribute('aria-expanded', String(open));
      const items = document.getElementById(btn.getAttribute('aria-controls'));
      // A folded section's links are clipped to nothing; inert keeps them
      // out of the Tab order and the accessibility tree too.
      if (items) items.inert = !open;
    }
  }

  // Fold or unfold one section, leaving the others as they are.
  function toggle(section) {
    const closed = closedSet();
    if (closed.has(section)) closed.delete(section);
    else closed.add(section);
    const value = [...closed].join(' ');
    if (value) root.dataset.navClosed = value;
    else delete root.dataset.navClosed;
    try { localStorage.setItem(KEY, value); } catch { /* storage blocked: the fold lasts this page */ }
    sync();
  }

  for (const btn of toggles) btn.addEventListener('click', () => toggle(btn.dataset.section));
  sync();
}());

// ── File and Settings (foot of the sidebar) ──────────────────────────────
// File opens its three options in place, above the button. The options call
// window.dbActions (dbactions.js, loaded earlier), which owns the database
// modal. Settings opens the Preferences modal; settings.js wires its close.
(function () {
  const fileBtn = document.querySelector('.nav-footer [data-menu="file"]');
  const options = document.getElementById('nav-file-options');
  if (fileBtn && options) {
    const setOpen = (open) => {
      fileBtn.setAttribute('aria-expanded', String(open));
      options.classList.toggle('open', open);
      // inert keeps the collapsed options out of the Tab order and the
      // accessibility tree while they are clipped to zero height.
      options.inert = !open;
    };
    const isOpen = () => fileBtn.getAttribute('aria-expanded') === 'true';

    fileBtn.addEventListener('click', () => setOpen(!isOpen()));

    options.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      setOpen(false);
      switch (item.dataset.action) {
        case 'new-db':     window.dbActions?.showNew();    break;
        case 'open-db':    window.dbActions?.showOpen();   break;
        case 'save-db-as': window.dbActions?.showSaveAs(); break;
      }
    });

    // A click anywhere else, or Escape, folds the options away again.
    const fileItem = fileBtn.parentElement;
    document.addEventListener('click', (e) => {
      if (isOpen() && !fileItem.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) setOpen(false);
    });
  }

  document.querySelector('.nav-footer [data-action="open-settings"]')?.addEventListener('click', () => {
    openPreferences();
  });
}());

// ── Collapse (very bottom of the sidebar) ───────────────────────────────
// Narrows the sidebar to a rail of icons, to give the page more room. The
// choice is remembered ('nav-rail' in localStorage); theme-init.js applies it
// before first paint so a collapsed sidebar never flashes open. Ctrl/Cmd+B
// toggles it, as in Prism.
(function () {
  const KEY = 'nav-rail';
  const btn = document.querySelector('.nav-footer [data-action="toggle-rail"]');
  if (!btn) return;
  const label = btn.querySelector('.nav-label');

  const setRail = (on) => {
    document.documentElement.classList.toggle('has-rail', on);
    const text = on ? 'Expand navigation' : 'Collapse navigation';
    btn.setAttribute('aria-label', text);
    btn.title = `${text} (Ctrl+B)`;
    if (label) label.textContent = on ? 'Expand' : 'Collapse';
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  };
  const isRail = () => document.documentElement.classList.contains('has-rail');

  btn.addEventListener('click', () => setRail(!isRail()));
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    setRail(!isRail());
  });

  // Sync the button with the state theme-init.js already painted.
  if (isRail()) setRail(true);
}());

// (The Transactions link used to carry an uncategorized-count pill, refreshed
// here on every page load and by the Transactions page after each edit. It was
// removed — the count is shown on the Transactions page instead — along with
// the GET /api/transactions/uncategorized-count route it was the only caller
// of.)
