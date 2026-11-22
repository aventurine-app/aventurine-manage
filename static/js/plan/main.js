'use strict';

// ─── main.js ────────────────────────────────────────────────────────────────
// The Plan page's boot: load the plans, then hand over to the views, which
// all render from PlanStore events. Also what ties the section to the rest of
// Manage:
//
//   workspace    The sidebar's Plan links are /plan#plans, #goals, #analyze
//                and #compare: the hash names the workspace. A change made
//                in the page (opening a plan from Analyze moves to Plans) is
//                written back to the hash without a new history entry, so
//                shell/nav.js marks the right link.
//   preferences  Manage's Preferences are the only ones. Ctrl+, opens them;
//                a Format change redraws every number (core/currency.js
//                fires 'currencychange'); Flow Animation (the 'flow-motion'
//                preference) shows or stops the dots along links.
//   lock         When the database locks, shell/dbactions.js hides the page
//                and sets data-db-locked; the plans are dropped from memory
//                too. Unlocking reloads the page.
//
// Also the section's shortcuts (undo, redo, new plan, next plan, save now).

(function () {
    const app = document.getElementById('app');
    const root = document.documentElement;
    if (!app || root.dataset.dbLocked) return;

    // ── Workspace ⇄ address ────────────────────────────────────────────────

    const WORKSPACES = new Set(['plans', 'goals', 'analyze', 'compare']);
    const hashWorkspace = () => {
        const w = location.hash.slice(1);
        return WORKSPACES.has(w) ? w : 'plans';
    };

    PlanStore.setWorkspace(hashWorkspace());
    window.addEventListener('hashchange', () => PlanStore.setWorkspace(hashWorkspace()));
    PlanStore.on((c) => {
        if (c.type !== 'workspace') return;
        const w = PlanStore.state.workspace;
        if (location.hash.slice(1) !== w) location.replace(`#${w}`);
    });

    // ── Preferences ────────────────────────────────────────────────────────

    function applyMotion() {
        let off = false;
        try { off = localStorage.getItem('flow-motion') === 'off'; } catch { /* default: on */ }
        if (off) root.dataset.motion = 'off';
        else delete root.dataset.motion;
    }
    applyMotion();
    window.addEventListener('flowmotionchange', applyMotion);

    window.addEventListener('currencychange', () => {
        Canvas.render();
        Inspector.refresh();
        Outlook.render();
    });

    // ── Lock ───────────────────────────────────────────────────────────────

    new MutationObserver(() => {
        if (root.dataset.dbLocked) PlanStore.clearAll();
    }).observe(root, { attributes: true, attributeFilter: ['data-db-locked'] });

    // ── Window title ───────────────────────────────────────────────────────
    // Plans and Analyze name the open plan; Goals and Compare the workspace.

    const WORKSPACE_NAME = { plans: 'Plans', goals: 'Goals', analyze: 'Analyze', compare: 'Compare' };
    let titled = null;
    function renderTitle() {
        const { plan, workspace } = PlanStore.state;
        const name = plan && (workspace === 'plans' || workspace === 'analyze') ? plan.name : WORKSPACE_NAME[workspace];
        if (name === titled) return;
        titled = name;
        document.title = `Aventurine Manage | ${name}`;
    }
    PlanStore.on((c) => { if (c.type === 'plan' || c.type === 'tabs' || c.type === 'workspace') renderTitle(); });

    // ── Shortcuts ──────────────────────────────────────────────────────────

    const typing = (el) => !!el && (el.matches('input, select, textarea') || el.isContentEditable);

    document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const key = e.key.toLowerCase();
        if (key === ',') {
            e.preventDefault();
            openPreferences();
            return;
        }
        if (!PlanStore.state.plan) return;
        // In a text field, undo belongs to the field.
        if (key === 'z' && !typing(document.activeElement)) {
            e.preventDefault();
            if (e.shiftKey) PlanStore.redo(); else PlanStore.undo();
        } else if (key === 'y' && !typing(document.activeElement)) {
            e.preventDefault();
            PlanStore.redo();
        } else if (key === 't') {
            e.preventDefault();
            PlanStore.setWorkspace('plans');
            PlanStore.newPlan();
        } else if (key === 'tab') {
            e.preventDefault();
            const { tabs, activeId } = PlanStore.state;
            const i = tabs.indexOf(activeId);
            const next = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
            if (next) PlanStore.openPlan(next);
        } else if (key === 's') {
            // Saving is automatic; Ctrl+S just makes it happen now.
            e.preventDefault();
            PlanStore.flush();
        }
    });

    // ── Boot ───────────────────────────────────────────────────────────────
    // The workbench is shown as the plans load (one request): the canvas
    // measures the stage to frame the open plan, so it must be laid out first.

    function boot() {
        app.hidden = false;
        PlanStore.boot().catch((e) => {
            console.error('[plan] boot failed', e);
            app.hidden = true;
            planNotice('Your plans could not be loaded.', { type: 'error', duration: 0 });
        });
    }

    // ── Subscription ───────────────────────────────────────────────────────
    // The Plan section is a subscriber feature (CLAUDE.md rule 16). Locked,
    // the page says why and how to unlock it, and the plans stay in the
    // database file untouched; if there are any, it offers them as the
    // Download All zip, because a lapsed subscription never locks data in.
    // The backend holds the same line (handlers/plans.js answers every edit
    // with 402), so this page is the explanation, not the lock. The
    // subscription's state can arrive after this script runs and change
    // without a reload, so it is followed, not read once
    // (core/subscription.js).

    const REQUIRES_SUBSCRIPTION = true;

    let locked = null;
    function showLocked() {
        if (locked) return;
        locked = document.createElement('div');
        locked.className = 'plan-locked ant-scope';
        locked.innerHTML = Ant.empty({
            title: 'Aventurine Planner comes with an Aventurine subscription',
            desc: 'Sign in with your subscription to plan here. Your plans are kept in this file either way.',
            actionHtml: `<button class="ant-btn ant-btn-primary" type="button" data-act="sign-in">Sign in</button>
                <button class="ant-btn ant-btn-default" type="button" data-act="pricing">See pricing</button>
                <button class="ant-btn ant-btn-default" type="button" data-act="download" hidden>Download your plans</button>`,
        });
        locked.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'sign-in') openPreferences('account');
            else if (act === 'pricing') window.electronLicense?.openPricingPage();
            else if (act === 'download') PlanStore.exportAll();
        });
        app.after(locked);

        // Offer the download only when there is something to take out.
        const page = locked;
        apiFetch('/api/plans')
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => {
                if (body && body.plans.length && locked === page) {
                    page.querySelector('[data-act="download"]').hidden = false;
                }
            })
            .catch((err) => console.error('[plan] counting the saved plans failed:', err));
    }

    if (!REQUIRES_SUBSCRIPTION) {
        boot();
    } else {
        let booted = false;
        Subscription.onState(() => {
            if (Subscription.unlocked()) {
                if (booted) return;
                booted = true;
                locked?.remove();
                locked = null;
                boot();
            } else if (booted) {
                // Signed out, or the subscription lapsed, with the plans open.
                location.reload();
            } else {
                showLocked();
            }
        });
    }
}());
