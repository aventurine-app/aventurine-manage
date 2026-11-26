'use strict';

// Reports — tab bar controller (pages/reports.html).
// Standard ARIA tablist: click or arrow/Home/End to switch report panels,
// with roving tabindex so only the active tab is in the tab order. Adding a
// report = a `.rep-tab` button in the tablist + a matching
// `.rep-panel[data-panel]` — no JS change needed.
//
// A hidden panel's charts draw at zero width and skip the paint; every chart
// here observes its container, so the report renders the moment its tab is
// selected. That's what lets each report load its data up front, unconditionally.
//
// The open tab lives in the URL hash (/reports#spending), so each tab clicked
// is a session-history entry: Back/Forward step through the tabs before they
// leave the page, and a reload reopens the same tab. Arrow keys replace the
// entry instead of adding one, so sweeping across the row with the keyboard
// does not bury the previous page under a stack of tab visits.
(function () {
  const tablist = document.querySelector('.rep-tabs');
  if (!tablist) return;

  const tabs = Array.from(tablist.querySelectorAll('.rep-tab'));
  const panels = Array.from(document.querySelectorAll('.rep-panel'));
  if (!tabs.length) return;

  function select(tab, focus) {
    const id = tab.dataset.tab;
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panels.forEach((p) => { p.hidden = p.dataset.panel !== id; });
    if (focus) tab.focus();
  }

  const byId = (id) => tabs.find((t) => t.dataset.tab === id);

  /** The tab the URL names; no hash (or an unknown one) is the first tab. */
  function tabFromHash() {
    return byId(decodeURIComponent(location.hash.slice(1))) || tabs[0];
  }

  /** Point the URL at `tab`. Pushing goes through location.hash, whose
   *  hashchange (below) does the selecting; replacing fires no event. */
  function writeHash(tab, replace) {
    const hash = `#${tab.dataset.tab}`;
    if (location.hash === hash) return;
    if (replace) history.replaceState(history.state, '', hash);
    else location.hash = hash;
  }

  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('.rep-tab');
    if (!tab) return;
    select(tab);
    writeHash(tab, false);
  });

  // Back/Forward between two tabs of this page (and a hand-edited hash).
  window.addEventListener('hashchange', () => select(tabFromHash()));

  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j >= 0) { e.preventDefault(); select(tabs[j], true); writeHash(tabs[j], true); }
  });

  // The URL's tab, else whatever tab comes first in the row — reordering the
  // buttons in the markup is all it takes to change the default.
  select(tabFromHash());
}());
