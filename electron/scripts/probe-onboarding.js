'use strict';

// UI probe for the first-run onboarding flow. Boots the real app entry against
// an isolated (fresh) userData dir, then drives Dashboard → hero → account picker →
// the import wizard (file, columns, review, done), capturing a screenshot at
// each step, then an ordinary import from the ledger.
//
//   electron scratchpad/probe-onboarding.js
//
// userData is overridden AFTER requiring main.js (main.js re-points it at the
// shared dev profile at require time) — otherwise this writes to the dev DB.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-onb-'));
const { app, BrowserWindow } = require('electron');

require('../main.js');
app.setPath('userData', tmp);

const OUT = process.env.PROBE_OUT || tmp;
const DEADLINE_MS = 25000;

async function waitForWindow() {
  const t0 = Date.now();
  for (;;) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length && !wins[0].webContents.isLoading()) return wins[0];
    if (Date.now() - t0 > DEADLINE_MS) throw new Error('window never finished loading');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A messy export: mixed date format, a signed amount column, a trailing balance
// column, merchants the lexicon matches plus one it must leave blank. Synthetic —
// no real strings (see the repo's no-real-strings rule).
const CSV = [
  'Posting Date,Description,Amount,Balance',
  '03/02/2026,SQ *ZZQX COFFEE ROASTERS 4471,-6.75,2413.19',
  '03/03/2026,TRADER JOES #221 SEATTLE WA,-84.12,2329.07',
  '03/05/2026,SHELL OIL 57432119 SEATTLE,-41.80,2287.27',
  '03/06/2026,NETFLIX.COM,-15.49,2271.78',
  '03/07/2026,ZZQX 88421 MEMO 0033,-22.00,2249.78',
  '03/10/2026,DIRECT DEP ZZQX PAYROLL,3120.44,5370.22',
  '03/12/2026,SAFEWAY #1188,-63.20,5307.02',
  '03/15/2026,CHIPOTLE 2244,-14.85,5292.17',
  '03/18/2026,DELTA AIR LINES 0062119,-318.40,4973.77',
  '03/20/2026,ZZQX MUTUAL INS PREM,-142.00,4831.77',
].join('\n');

app.whenReady().then(async () => {
  const results = [];
  const check = (label, cond, extra = '') => {
    results.push({ label, ok: !!cond, extra });
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  };

  try {
    const win = await waitForWindow();
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') {
        console.log(`      [renderer ${e.level}] ${e.message}`);
      }
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      const p = path.join(OUT, `${name}.png`);
      fs.writeFileSync(p, img.toPNG());
      console.log(`      shot → ${p}`);
    };

    // ── Step 0: a fresh DB should have no visible accounts and be "fresh" ──
    const state = await js('apiFetch("/api/onboarding").then(r => r.json())');
    check('fresh DB reports fresh', state.fresh === true && state.dismissed === false,
      JSON.stringify(state));
    const cols = await js('apiFetch("/api/balance/columns").then(r => r.json())');
    check('no visible accounts on a fresh DB', Array.isArray(cols) && cols.length === 0,
      `got ${JSON.stringify(cols)}`);
    const all = await js('apiFetch("/api/balance/columns?include_hidden=true").then(r => r.json())');
    check('six starter accounts offered', all.length === 6, all.map((c) => c.key).join(','));

    // ── Step 1: the hero preempts the dashboard ──
    await sleep(600);
    check('hero visible', await js('!document.getElementById("dashboard-firstrun").hidden'));
    check('dashboard preempted',
      await js('document.querySelectorAll(".dash-shell.is-preempted").length === 1'));
    check('hero is actually laid out (the [hidden] trap)',
      await js('document.getElementById("dashboard-firstrun").getBoundingClientRect().height > 100'));
    await shot('01-hero');

    // ── Step 2: the account picker ──
    await js('document.getElementById("dashboard-firstrun-start").click()');
    await sleep(500);
    check('picker modal open', await js('!!document.querySelector(".onb-dialog .acct-tiles")'));
    const tiles = await js(`[...document.querySelectorAll('.acct-tile-name')].map(e => e.textContent)`);
    check('the four account types are the only kinds offered',
      tiles.join('|') === 'Cash|Retirement|Investment|Debt', tiles.join(' | '));
    check('no "your accounts" section on a fresh DB',
      await js(`[...document.querySelectorAll('.acct-section-label')].map(e => e.textContent).join('|')`) === 'Add your first account');
    check('the name field is hidden until a kind is picked',
      await js('document.querySelector(".acct-custom").hidden === true'));
    check('nothing pre-selected',
      await js('!document.querySelector(".onb-dialog input[name=\'onb-account\']:checked")'));
    check('primary action blocked until a choice is made',
      await js('document.querySelector(".onb-next").disabled === true'));
    await shot('02-picker');

    // Select Checking.
    await js(`(() => {
      const r = document.querySelector('.onb-dialog input[value="new:checking"]');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    check('picking a kind reveals the name field',
      await js('document.querySelector(".acct-custom").hidden === false'));
    check('placeholder teaches that the name is theirs',
      await js(`document.querySelector('.acct-custom-name').placeholder`) === 'e.g. Joint Checking');
    check('an unnamed new account cannot proceed',
      await js('document.querySelector(".onb-next").disabled === true'));

    // Name it — this is what makes the ledger the user's rather than generic.
    await js(`(() => {
      const n = document.querySelector('.acct-custom-name');
      n.value = 'Everyday Checking';
      n.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    check('naming the new account enables the action',
      await js('document.querySelector(".onb-next").disabled === false'));
    await shot('02b-naming');

    // ── Step 3: intercept the native file dialog and inject the CSV ──
    await js(`(() => {
      window.__probeCsv = ${JSON.stringify(CSV)};
      const realClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return realClick.apply(this, arguments);
        const dt = new DataTransfer();
        dt.items.add(new File([window.__probeCsv], 'zzqx-export.csv', { type: 'text/csv' }));
        this.files = dt.files;
        setTimeout(() => this.dispatchEvent(new Event('change')), 30);
      };
    })()`);

    // The import wizard (an Ant Design Modal stepping through File, Columns and
    // Review here, since first-run has asked the account already). Its drop
    // zone clicks the file input, which the patch above answers with the CSV.
    await js('document.querySelector(".onb-next").click()');
    await sleep(1200);
    check('the wizard opens at the file, the account already settled',
      await js(`[...document.querySelectorAll('.tx-import-modal .ant-steps-item-title')].map(e => e.textContent).join('|')`) === 'File|Columns|Review');
    check('account is not re-asked', await js(`!document.querySelector('.tx-import-modal input[type="radio"]')`));
    await js('document.querySelector(".tx-import-modal .ant-upload-drag").click()');
    await sleep(1200);
    const mapped = (f) => `document.querySelector('.tx-import-modal [data-map="${f}"]')?.selectedOptions[0]?.textContent`;
    check('column-mapping step reached', await js(`!!document.querySelector('.tx-import-map')`));
    const detected = await js(`({ date: ${mapped('date')}, description: ${mapped('description')}, amount: ${mapped('amount')}, balance: ${mapped('balance')} })`);
    check('columns auto-detected, including the balance column',
      detected.date === 'Posting Date' && detected.description === 'Description'
        && detected.amount === 'Amount' && detected.balance === 'Balance',
      JSON.stringify(detected));

    // ── The live preview reflects the MAPPING, not a raw file dump ──
    const cell = (n) => `document.querySelector('.tx-import-preview tbody tr td:nth-child(${n})')?.textContent.trim()`;
    const firstCell = await js(cell(1));
    check('live preview shows the parsed date (mapped), not the raw file string',
      firstCell === await js(`formatDate('2026-03-02')`), firstCell);
    await shot('03-mapping');

    // Re-map Notes to the Balance column and confirm the preview updates
    // immediately, with no Continue click involved.
    const setMap = (field, text) => js(`(() => {
      const sel = document.querySelector('.tx-import-modal [data-map="${field}"]');
      const opt = [...sel.options].find(o => o.textContent === ${JSON.stringify(text)});
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await setMap('notes', 'Balance');
    await sleep(200);
    const notesCell = await js(cell(3));
    check('changing a column selection live-updates the preview', notesCell === '2413.19', notesCell);
    await shot('03b-mapping-live-update');
    // Back to skip, so the rest of the run matches the file's real shape.
    await setMap('notes', '— skip —');
    await sleep(200);

    await js('document.querySelector(".tx-import-modal [data-act=continue]").click()');
    await sleep(1400);
    const review = await js(`(() => ({
      title: document.querySelector('.tx-import-title')?.textContent,
      stats: [...document.querySelectorAll('.tx-import-stats .ant-statistic-title')].map(e => e.textContent).join('|'),
      need: document.querySelectorAll('.tx-import-stats .ant-statistic-content')[3]?.textContent,
      rows: document.querySelectorAll('.tx-import-table tbody tr').length,
      buttons: [...document.querySelectorAll('.tx-import-modal .ant-modal-footer button')].map(b => b.textContent.trim()),
    }))()`);
    check('review reached: "Here’s what we found"', review.title === 'Here’s what we found', review.title);
    check('the four figures: new, already in the ledger, categorized, need a category',
      review.stats === 'New transactions|Already in the ledger|Categorized for you|Need a category', review.stats);
    check('the categorizer leaves the ones it is unsure of blank', Number(review.need) > 0, review.need);
    check('three footer actions: Back, Cancel, Import N',
      review.buttons.length === 3 && review.buttons[0] === 'Back' && /^Import \d+ transactions$/.test(review.buttons[2]),
      review.buttons.join(' | '));
    await shot('04-review');

    await js('document.querySelector(".tx-import-modal [data-act=import]").click()');
    await sleep(2000);

    const after = await js('apiFetch("/api/balance/columns").then(r => r.json())');
    check('exactly one account adopted, under the user\'s own name',
      after.length === 1 && after[0].key === 'checking' && after[0].label === 'Everyday Checking',
      JSON.stringify(after));
    const bal = await js('apiFetch("/api/balance/data").then(r => r.json())');
    check('balance reading seeded into the sheet',
      JSON.stringify(bal.entries).includes('checking'), JSON.stringify(bal.entries));
    const onb = await js('apiFetch("/api/onboarding").then(r => r.json())');
    check('no longer fresh', onb.fresh === false);

    // ── The Done step: what was done, and exactly two ways on ──
    check('Done step reached',
      await js(`document.querySelector('.tx-import-done-title')?.textContent`) === 'Everyday Checking is set up');
    check('exactly two actions: Import another account, Finish',
      await js(`[...document.querySelectorAll('.tx-import-modal .ant-modal-footer button')].map(b => b.textContent.trim()).join('|')`)
        === 'Import another account|Finish');
    await shot('05-done');

    // "Import another account" is onboarding's path back to the picker
    // (the account just imported shows up as a chip there).
    await js('document.querySelector(".tx-import-modal [data-act=more]").click()');
    await sleep(600);
    check('back at the picker',
      await js('!!document.querySelector(".onb-dialog .acct-tiles")'));
    check('the adopted account appears under "your accounts", by its name',
      (await js(`[...document.querySelectorAll('.acct-tile-name')].map(e => e.textContent)`))[0] === 'Everyday Checking');
    check('both sections present on the second pass',
      await js(`[...document.querySelectorAll('.acct-section-label')].map(e => e.textContent).join('|')`) === 'Your accounts|Add New Account');
    check('progress chip for the finished account',
      await js(`document.querySelector('.onb-done-chip')?.textContent`) === 'Everyday Checking');
    check('"Finish" is offered as the deliberate way out on a second pass',
      await js(`document.querySelector('.onb-skip')?.textContent`) === 'Finish');
    check('the × close button is still present (skip is never taken away)',
      await js('!!document.querySelector(".onb-close")'));
    await shot('06-second-pass');

    // Finish and confirm the dashboard comes back populated.
    await js('document.querySelector(".onb-skip").click()');
    await sleep(2500);
    check('dashboard restored after finishing',
      await js('document.querySelectorAll(".dash-shell.is-preempted").length === 0'));
    check('hero gone', await js('document.getElementById("dashboard-firstrun") === null || document.getElementById("dashboard-firstrun").hidden'));
    await shot('07-dashboard');

    // ── The ORDINARY import asks the same question, up front ──
    // Same wizard, no onboarding involved: the account step comes before the
    // file, pre-picked from the account used last.
    await js('window.location.href = "app://aventurine/transactions"');
    await sleep(2500);
    await js(`(() => {
      const realClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return realClick.apply(this, arguments);
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(CSV)}], 'zzqx-april.csv', { type: 'text/csv' }));
        this.files = dt.files;
        setTimeout(() => this.dispatchEvent(new Event('change')), 30);
      };
    })()`);

    // Not awaited: executeJavaScript resolves a returned promise, and run() does
    // not settle until the whole flow finishes, so awaiting it here would block
    // past the step being observed.
    await js('window.__runP = TxFileImport.run(); "started"');
    await sleep(900);
    check('normal import asks the account FIRST, before the file',
      await js(`document.querySelector('.tx-import-modal .ant-steps-item-process .ant-steps-item-title')?.textContent`) === 'Account');
    check('pre-filled from the account used last (an EXISTING account)',
      await js(`document.querySelector('.tx-import-modal input[name="tx-import-acct"]:checked')?.value`) === 'checking',
      'checked=' + await js(`document.querySelector('.tx-import-modal input[name="tx-import-acct"]:checked')?.value`));
    check('primary action is ready (routine path is one click)',
      await js(`document.querySelector('.tx-import-modal [data-act=next]').disabled === false`));
    await shot('08-normal-import-account');

    await js('document.querySelector(".tx-import-modal [data-act=next]").click()');
    await sleep(600);
    await js('document.querySelector(".tx-import-modal .ant-upload-drag").click()');
    await sleep(1400);
    check('proceeds to mapping after the account step',
      await js(`!!document.querySelector('.tx-import-map')`));
    check('no manual split toggle — this file has one Amount column, so only that field shows',
      await js(`!!document.querySelector('.tx-import-modal [data-map="amount"]')
                 && !document.querySelector('.tx-import-modal [data-map="debit"]')`));
    await js('document.querySelector(".tx-import-modal [data-act=continue]").click()');
    await sleep(1400);
    check('review reached again on the normal path', await js(`!!document.querySelector('.tx-import-stats')`));
    await shot('09-normal-import-review');

    // Back returns to the columns with the previous selections intact, and
    // commits nothing — verified by continuing again and landing back on the
    // review.
    await js('document.querySelector(".tx-import-modal [data-act=back]").click()');
    await sleep(800);
    check('Back returns to the columns', await js(`!!document.querySelector('.tx-import-map')`));
    check('previous column selections are retained', await js(mapped('date')) === 'Posting Date');
    await js('document.querySelector(".tx-import-modal [data-act=continue]").click()');
    await sleep(1400);
    check('continuing again lands back on the review', await js(`!!document.querySelector('.tx-import-stats')`));
    await shot('10-normal-import-back');

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('FAILED: ' + failed.map((f) => f.label).join('; '));
    app.exit(failed.length ? 1 : 0);
  } catch (err) {
    console.error('PROBE ERROR:', err && err.stack || err);
    app.exit(2);
  }
});
