'use strict';

// End-to-end verification: boots the REAL app entry (main.js) against an
// isolated data dir, waits for the window, then asserts from INSIDE the renderer
// that the page rendered, the preload bridge responds, and a write round-trips
// through IPC to SQLite and back. Exits 0 on PASS.
//
//   AVENTURINE_E2E=1 electron . is NOT used — this drives main.js directly:
//   npm run verify  (alias: electron scripts/verify-e2e.js)

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir — set AFTER requiring main.js, not before: main.js
// re-points userData at the shared 'aventurine-manage-dev' profile at require time (dev
// isolation from the packaged build), which silently clobbers any earlier
// setPath and sends every write from this script into the REAL dev database.
// startBackend derives AVENTURINE_DATA_DIR from userData only at app.whenReady, so
// overriding here (post-require, pre-ready) is what actually isolates us.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-e2e-'));
const { app, BrowserWindow } = require('electron');

// The Plan section needs a subscription; this run checks the section itself,
// so it unlocks it the dev-only way (licensePolicy.js) before main.js reads it.
process.env.AVENTURINE_DEV_UNLOCK = '1';
require('../main.js'); // the real entry: backend, protocol, window
app.setPath('userData', tmp);

// main.js requests the single-instance lock at REQUIRE time, and in dev it has
// already re-pointed userData at the shared 'aventurine-manage-dev' profile — before
// the setPath above can isolate us. So a running `npm start` makes this process
// the losing second instance: main.js calls app.quit(), whenReady never fires,
// and this script would exit 0 having asserted nothing at all. A verification
// that passes vacuously is worse than one that fails, so say so and fail.
if (!app.hasSingleInstanceLock()) {
  console.error('FAIL — another Aventurine Manage instance holds the single-instance '
    + 'lock. Close `npm start` (or the installed app) and run this again.');
  process.exit(1);
}

const DEADLINE_MS = 20000;

async function waitForWindow() {
  const t0 = Date.now();
  for (;;) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    if (Date.now() - t0 > DEADLINE_MS) throw new Error('window never finished loading');
    await new Promise((r) => setTimeout(r, 200));
  }
}

app.whenReady().then(async () => {
  let failed = false;
  const check = (label, cond) => {
    console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`);
    if (!cond) failed = true;
  };

  try {
    const win = await waitForWindow();
    const evalJs = (js) => win.webContents.executeJavaScript(js, true);

    check('renderer URL is app origin', win.webContents.getURL() === 'app://aventurine/');
    check('page title', (await evalJs('document.title')).includes('Aventurine Manage'));
    check('navbar rendered', await evalJs('!!document.querySelector(".menu .nav a[href=\'/transactions\']")'));
    // The sidebar is a shared partial; nav.js derives .active from the URL.
    check('home link marked active', await evalJs('document.querySelector(".menu .nav a[href=\'/\']").classList.contains("active")'));
    check('escapeHtml global present', await evalJs('typeof escapeHtml === "function"'));
    check('apiFetch present', await evalJs('typeof apiFetch === "function"'));
    check('financeApi bridge present', await evalJs('!!window.financeApi'));

    const status = await evalJs('apiFetch("/api/db/status").then(r => r.json())');
    check('IPC db status ok+unlocked', status.ok === true && status.locked === false);

    const created = await evalJs(`apiFetch("/api/transactions", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({date: "2026-06-11", description: "e2e probe",
                              tx_type: "expense", amount: 9.99})
      }).then(r => r.json())`);
    check('IPC tx create round-trips', created.ok === true && created.transaction.amount === 9.99);

    const listed = await evalJs('apiFetch("/api/transactions").then(r => r.json())');
    check('IPC tx visible in list', listed.transactions.some((t) => t.description === 'e2e probe'));

    // The page must be parsed as UTF-8 (no server header declares it;
    // a windows-1252 fallback renders every em-dash as mojibake).
    check('document parsed as UTF-8', (await evalJs('document.characterSet')) === 'UTF-8');

    // Navigate the way a user does: click the navbar link. Renderer-initiated
    // navigation fires will-navigate (loadURL does not), so this catches a
    // navigation guard that blocks every link with no error.
    await evalJs('document.querySelector(".menu .nav a[href=\'/transactions\']").click()');
    const t0 = Date.now();
    while (
      (win.webContents.isLoading() || !win.webContents.getURL().endsWith('/transactions')) &&
      Date.now() - t0 < 8000
    ) {
      await new Promise((r) => setTimeout(r, 150));
    }
    check('link click navigates', win.webContents.getURL() === 'app://aventurine/transactions');
    check('transactions page loads', (await evalJs('document.title')).includes('Transactions'));
    check('active link follows navigation', await evalJs('document.querySelector(".menu .nav a[href=\'/transactions\']").classList.contains("active")'));
    check('tx table boots with data', await evalJs(
      'new Promise(res => setTimeout(() => res(!!document.querySelector(".tx-row, .tx-table tbody tr")), 800))'
    ));
    // Import stack load-order contract: txparse.js (pure parser) must attach
    // TxParse before txfileimport.js destructures it — a broken order leaves
    // TxFileImport undefined and the Import button dead.
    check('import parser + widget globals present', await evalJs(
      '!!(window.TxParse && window.TxParse.parseFile && window.TxFileImport && window.TxFileImport.run)'
    ));

    // Merchant brand icons fail with no error: drop the generated manifest's
    // <script> tag, or the asset dir from the package, and every avatar falls back
    // to initials, which is indistinguishable from a build that never had icons.
    // So assert all three links of the chain from inside the real renderer: the
    // manifest loaded, avatar.js emits an <img> for a merchant with a shipped
    // icon, and that file resolves over app://.
    check('merchant icon manifest loaded', await evalJs(
      '!!(window.MERCHANT_ICONS && Object.keys(window.MERCHANT_ICONS).length > 0'
      + ' && Array.isArray(window.MERCHANT_ICONS_BLEED))'
    ));
    check('merchant avatar renders a brand icon', await evalJs(`(() => {
      const slug = Object.keys(window.MERCHANT_ICONS)[0];
      const file = window.MERCHANT_ICONS[slug];
      const html = merchantAvatarHtml(slug);
      return html.includes('avatar-circle-icon')
          && html.includes('/static/merchant-icons/' + file + '.png');
    })()`));
    check('merchant icon asset resolves', await evalJs(`new Promise(res => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth > 0);
      img.onerror = () => res(false);
      img.src = '/static/merchant-icons/'
        + window.MERCHANT_ICONS[Object.keys(window.MERCHANT_ICONS)[0]] + '.png';
    })`));

    // Every page is assembled from pages/partials/ at serve time — walk all
    // routes and prove the shared chrome landed on each one.
    const routes = {
      '/':                'Dashboard',
      '/transactions':    'Transactions',
      '/statements':      'Statements',
      '/budgets':         'Budgets',
      '/reports':         'Reports',
      '/recurring':       'Recurring',
    };
    for (const [route, name] of Object.entries(routes)) {
      await win.loadURL(`app://aventurine${route}`);
      // A route whose sidebar link is commented out is still reachable by URL
      // but has no nav link to highlight. Check the rendered sidebar rather than
      // assuming every route is linked; otherwise disabling a nav link makes
      // this check fail permanently.
      const linked = await evalJs(
        `!!document.querySelector(".menu .nav a[href=" + ${JSON.stringify(JSON.stringify(route))} + "]")`);
      const activeHref = linked ? route : null;
      const ok = await evalJs(`document.title.includes(${JSON.stringify(name)})
        && !!document.querySelector(".titlebar")
        && !!document.querySelector(".menu .nav")
        && !!document.querySelector("#db-modal")
        && !!document.querySelector("[data-modal='preferences']")
        && (document.querySelector(".menu .nav a.active")?.getAttribute("href") ?? null) === ${JSON.stringify(activeHref)}
        && document.querySelectorAll(".menu .nav a.active").length === ${activeHref ? 1 : 0}`);
      check(`page ${route} assembles with chrome`, ok);
    }

    // ── Plan: the Plan section (pages/plan.html, static/js/plan/) ──
    // An ordinary page on Manage's origin: these checks prove it opens the
    // plans from the database, that the sidebar's links and the section's
    // own workspace changes stay in step both ways, that it follows Manage's
    // Preferences, and that plans and their order are stored in the file.
    await win.loadURL('app://aventurine/plan#goals');
    const until = async (fn) => {
      const t0 = Date.now();
      while (!(await fn()) && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 100));
      return fn();
    };
    check('Plan page opens its plans', await until(() => evalJs(
      '!!(window.PlanStore && PlanStore.state.plan) && !document.getElementById("app").hidden')));
    check('Plan page has no frame of its own', await evalJs('window.frames.length === 0'));
    check('Plan opens on the hash\'s workspace', (await evalJs('PlanStore.state.workspace')) === 'goals');
    check('Plan link for the workspace is active', await evalJs(
      'document.querySelector(".menu .nav a.active")?.getAttribute("href") === "/plan#goals"'
      + ' && document.querySelectorAll(".menu .nav a.active").length === 1'));
    await evalJs('document.querySelector(".menu .nav a[href=\'/plan#compare\']").click()');
    check('Plan link switches the workspace', await until(
      async () => (await evalJs('PlanStore.state.workspace')) === 'compare'));
    await evalJs('PlanStore.setWorkspace("analyze")');
    check('the section\'s own workspace change moves the sidebar', await until(() => evalJs(
      'location.hash === "#analyze"'
      + ' && document.querySelector(".menu .nav a.active")?.getAttribute("href") === "/plan#analyze"')));

    // Manage's Preferences are the section's: Format and Flow Animation apply
    // live, and Ctrl+, opens them.
    await evalJs('setCurrencySymbol("€"); setNumberFormat("eu")');
    check('Plan follows Manage\'s Format', (await evalJs('Fmt.money(1234)')) === '€1.234');
    await evalJs('setCurrencySymbol("$"); setNumberFormat("us")');
    await evalJs('document.querySelector(".settings-pref-radio[name=\'flow-motion\'][value=\'off\']").click()');
    check('Plan follows Manage\'s Flow Animation', await until(
      async () => (await evalJs('document.documentElement.dataset.motion')) === 'off'));
    await evalJs('document.querySelector(".settings-pref-radio[name=\'flow-motion\'][value=\'on\']").click()');
    await evalJs('document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }))');
    check('Ctrl+, on the Plan page opens Preferences', await until(() => evalJs(
      '!document.querySelector("[data-modal=\'preferences\']").hidden')));
    await evalJs('document.querySelector("[data-modal=\'preferences\']").hidden = true');

    // The plans are in the database file: a new plan is stored there, beside
    // the ledger.
    const storedPlans = () => evalJs('apiFetch("/api/plans").then((r) => r.json())');
    const storedIds = async () => (await storedPlans()).plans.map((p) => p.id).sort();
    const before = await storedIds();
    await evalJs('PlanStore.newPlan().then(() => PlanStore.flush())');
    const after = await storedIds();
    const tabs = await evalJs('PlanStore.state.tabs.slice().sort()');
    check('a new plan is stored in the database', after.length === before.length + 1
      && JSON.stringify(after) === JSON.stringify(tabs));

    // The plans are tabs across the builder's top. Moving one reorders the
    // stored plans; its × deletes it once confirmed.
    await evalJs('PlanStore.setWorkspace("plans")');
    check('a tab per plan, the open one selected', await until(() => evalJs(
      '[...document.querySelectorAll(".builder > .plan-tabs .plan-tab")].map((t) => t.dataset.id).join() === PlanStore.state.tabs.join()'
      + ' && document.querySelector(".plan-tab[aria-selected=\'true\']").dataset.id === PlanStore.state.activeId')));
    const order = await evalJs('PlanStore.state.tabs.slice()');
    await evalJs('document.querySelector(".plan-tab[aria-selected=\'true\']")'
      + '.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, shiftKey: true, bubbles: true }))');
    const moved = [...order.slice(0, -2), order.at(-1), order.at(-2)];
    check('a tab moves, and the order is stored', await until(async () =>
      JSON.stringify((await storedPlans()).order) === JSON.stringify(moved)));
    const doomed = await evalJs('PlanStore.state.activeId');
    await evalJs('document.querySelector(".plan-tab[aria-selected=\'true\'] .plan-tab-close").click()');
    await until(() => evalJs('!!document.querySelector(".ant-modal-confirm [data-choice=\'ok\']")'));
    await evalJs('document.querySelector(".ant-modal-confirm [data-choice=\'ok\']").click()');
    check('a tab\'s × deletes its plan', await until(async () => !(await storedIds()).includes(doomed)
      && !(await evalJs(`!!document.querySelector('.plan-tab[data-id="${doomed}"]')`))));

    // The sections fold, and stay folded on the next page (painted before
    // the page's scripts run, from theme-init.js). On the dashboard Manage
    // is the open section.
    await win.loadURL('app://aventurine/');
    await evalJs('document.querySelector(".nav-section-toggle[data-section=\'manage\']").click()');
    // (It animates, so the height is read once the fold has run.)
    check('Manage section folds', await until(() => evalJs(
      'document.getElementById("nav-section-manage").inert'
      + ' && document.querySelector("[data-section=\'manage\']").getAttribute("aria-expanded") === "false"'
      + ' && document.getElementById("nav-section-manage").getBoundingClientRect().height < 1')));
    await win.loadURL('app://aventurine/plan');
    check('folded section stays folded on the next page', await evalJs(
      'document.documentElement.dataset.navClosed.split(" ").includes("manage") && document.getElementById("nav-section-manage").inert'));
    await evalJs('document.querySelector(".nav-section-toggle[data-section=\'plan\']").click()');
    await evalJs('document.querySelector(".nav-section-toggle[data-section=\'manage\']").click()');
    check('opening Manage folds Invest and Plan (one section open at a time)', await evalJs(
      'document.documentElement.dataset.navClosed === "invest plan" && !document.getElementById("nav-section-manage").inert'
      + ' && document.getElementById("nav-section-invest").inert && document.getElementById("nav-section-plan").inert'));

    // The sidebar's File button is the only way to reach the DB modal — prove
    // the File options → window.dbActions → modal chain works, and that the
    // options are unreachable until File is opened.
    await win.loadURL('app://aventurine/');
    check('File options start collapsed', await evalJs(
      'document.getElementById("nav-file-options").inert'
    ));
    await evalJs('document.querySelector(".nav-footer [data-menu=\'file\']").click()');
    check('File button opens its options', await evalJs(
      '!document.getElementById("nav-file-options").inert'
      + ' && document.querySelector(".nav-footer [data-menu=\'file\']").getAttribute("aria-expanded") === "true"'
    ));
    await evalJs('document.querySelector("#nav-file-options [data-action=\'new-db\']").click()');
    check('File menu opens New Database modal', await evalJs(
      '!document.getElementById("db-modal").hidden && document.getElementById("db-modal-title").textContent === "New Database"'
      + ' && document.getElementById("nav-file-options").inert'
    ));

    // Settings is a single button, not a menu: one click, one modal.
    await evalJs('document.querySelector(".nav-footer [data-action=\'open-settings\']").click()');
    check('Settings button opens the settings modal', await evalJs(
      '!document.querySelector("[data-modal=\'preferences\']").hidden'
    ));

    // About's version row is filled from the preload bridge on load. It read a
    // hardcoded placeholder in every shipped build after the updater was
    // removed, so assert a real version string reached it.
    check('About shows the installed version', await evalJs(
      '/^\\d+\\.\\d+\\.\\d+/.test(document.querySelector("[data-about-version]").textContent.trim())'
    ));

    // Picking a theme paints in place and fires 'themechange' for the charts —
    // it must NOT reload the page, which used to shut the modal the user was
    // standing in. Assert the swap landed AND the modal survived it.
    check('theme swap paints without closing Preferences', await evalJs(`(() => {
      document.querySelector(".settings-theme-btn[data-theme='dark']").click();
      return document.documentElement.dataset.theme === 'dark'
        && !document.querySelector("[data-modal='preferences']").hidden
        && document.querySelector(".settings-theme-btn[data-theme='dark']").classList.contains('active');
    })()`));
    // Reset to the default so later checks run against the default theme.
    await evalJs('document.querySelector(".settings-theme-btn[data-theme=\'\']").click()');

    // The graph palette is the second appearance axis and swaps the same way:
    // an attribute on <html> that re-points --ant-chart-*, no reload. Assert the
    // attribute landed AND that the tokens the charts read actually moved (both
    // the Ant name and the --chart-* the Reports engines read through it) — the
    // picker being wired is not the same as the palette being applied.
    check('opal graph palette re-points the chart tokens', await evalJs(`(() => {
      const read = (name) => getComputedStyle(document.documentElement)
        .getPropertyValue(name).trim();
      const before = [read('--ant-chart-1'), read('--chart-1')];
      document.querySelector(".settings-graph-btn[data-graph-theme='opal']").click();
      return document.documentElement.dataset.graphTheme === 'opal'
        && read('--ant-chart-1') !== before[0]
        && read('--chart-1') !== before[1]
        && !document.querySelector("[data-modal='preferences']").hidden
        && document.querySelector(".settings-graph-btn[data-graph-theme='opal']").classList.contains('active');
    })()`));
    // Back to the default palette, same as the theme above.
    await evalJs('document.querySelector(".settings-graph-btn[data-graph-theme=\'\']").click()');

    // Both column editors live behind ONE toolbar button: "Manage Columns"
    // opens an Ant modal on the tab matching the statement tab. From Cash Flow
    // that is Categories: one card per type (Income / Expenses / Transfers),
    // each with its rows and an add field. The list fills asynchronously after
    // mount, so poll briefly like the tx table.
    await win.loadURL('app://aventurine/statements');
    await evalJs('new Promise(res => setTimeout(res, 400))');
    await evalJs('document.getElementById("stmt-columns-btn").click()');
    check('Statements → Manage Columns opens on Categories', await evalJs(
      'new Promise(res => setTimeout(() => res('
        + '!!document.querySelector(".stmt-columns-modal")'
        + ' && document.querySelectorAll(".stmt-columns-modal [role=tab]").length === 2'
        + ' && document.querySelector(".stmt-columns-modal [data-tab=\'cashflow\']").getAttribute("aria-selected") === "true"'
        + ' && !document.querySelector(".stmt-columns-modal [data-panel=\'cashflow\']").hidden'
        + ' && document.querySelector(".stmt-columns-modal [data-panel=\'balance\']").hidden'
        + ' && document.querySelectorAll(".stmt-cat-card").length === 3'
        + ' && document.querySelectorAll(".stmt-cat-card [data-new]").length === 3'
        + ' && document.querySelectorAll(".stmt-cat-card [data-id]").length > 0'
        + '), 800))'
    ));

    // The other tab of the same modal: the Balance Sheet's accounts, which
    // mount only on first view, with the Categories panel still mounted
    // behind them.
    await evalJs(`document.querySelector(".stmt-columns-modal [role=tab][data-tab='balance']").click()`);
    check('the tab switch shows the Balance Sheet accounts in the same modal', await evalJs(
      'new Promise(res => setTimeout(() => res('
        + 'document.querySelectorAll(".stmt-columns-modal").length === 1'
        + ' && !document.querySelector(".stmt-columns-modal [data-panel=\'balance\']").hidden'
        + ' && document.querySelector(".stmt-columns-modal [data-panel=\'cashflow\']").hidden'
        + ' && !!document.querySelector(".stmt-account-list")'
        + ' && !!document.querySelector(".stmt-columns-modal [data-new-account]")'
        + ' && document.querySelectorAll(".stmt-cat-card").length === 3'
        + '), 800))'
    ));

    // Year management is the other toolbar button. The probe transaction above
    // is dated 2026, and creating it opened the 2026 statement year, so that row
    // must come back LOCKED: the year, its ledger count and the lock, with no
    // renumber pencil and no Remove. This is the whole rule the modal exists to
    // enforce, end to end — the /api/transactions/years read, the row split,
    // and the markup.
    await evalJs('document.querySelector(".stmt-columns-modal .ant-modal-close").click()');
    await evalJs('new Promise(res => setTimeout(res, 400))');
    await evalJs('document.getElementById("stmt-years-btn").click()');
    check('Statements → Manage Years locks the year holding transactions', await evalJs(
      'new Promise(res => setTimeout(() => {'
        + 'const row = document.querySelector(".stmt-year-list [data-year=\'2026\']");'
        + 'res(!!document.querySelector(".stmt-years-modal")'
        + ' && !document.querySelector(".stmt-years-modal [role=tab]")'
        + ' && !!document.querySelector(".stmt-years-modal [data-act=\'add\']")'
        + ' && !!row && !!row.querySelector(".stmt-lock")'
        + ' && !row.querySelector("[data-act=\'remove\'], [data-act=\'rename\']")'
        + ' && /transaction/.test(row.textContent));'
      + '}, 800))'
    ));

  } catch (e) {
    console.error('FAIL  exception:', e.message);
    failed = true;
  }

  console.log(failed ? 'E2E: FAIL' : 'E2E: PASS');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
  app.exit(failed ? 1 : 0);
});
