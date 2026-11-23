'use strict';

// ─── Subscription state (window.Subscription) ───────────────────────────────
// The one place page code asks what the subscription unlocks. The main
// process decides (electron/license.js, licensePolicy.js); this file keeps the
// latest answer it was sent and hands it out. All three are false (or 'none')
// until the first answer arrives, and always in a plain browser (no bridge).
//
//   Subscription.tier()       'none', 'basic' or 'pro'
//   Subscription.unlocked()   Basic or Pro: the app is open. Every page but
//                             the sign-in page can assume it (main.js serves
//                             that page below Basic).
//   Subscription.pro()        Pro: Plan and every later Pro feature.
//   Subscription.onState(fn)  fn(state) now if known, then on every change.
//                             state: { signedIn, tier, unlocked, pro, paidTier, email, status,
//                             renewsAt, cancelsAt, checkedAt, validUntil,
//                             checking, error }
//
// Gating a Pro feature:
//
//   Subscription.onState(() => { button.hidden = !Subscription.pro(); });
//
// Read it on every change rather than once: the answer can arrive after the
// page script runs, and signing in or out changes it without a reload.

(function () {
    const bridge = window.electronLicense;
    const listeners = new Set();
    let current = null;

    function publish(state) {
        current = state;
        for (const fn of listeners) {
            try {
                fn(state);
            } catch (err) {
                console.error('[subscription] listener failed:', err);
            }
        }
    }

    window.Subscription = {
        tier: () => (current && current.tier) || 'none',
        unlocked: () => Boolean(current && current.unlocked),
        pro: () => Boolean(current && current.pro),
        onState(fn) {
            listeners.add(fn);
            if (current) fn(current);
            return () => listeners.delete(fn);
        },
    };

    if (!bridge) return;
    bridge.onStatus(publish);
    bridge.getState()
        .then(state => { if (!current) publish(state); })
        .catch(err => console.error('[subscription] reading the subscription state failed:', err));
}());
