'use strict';

// ─── Subscription state (window.Subscription) ───────────────────────────────
// The one place page code asks "are subscriber features unlocked?". The main
// process decides (electron/license.js, licensePolicy.js); this file keeps the
// latest answer it was sent and hands it out.
//
//   Subscription.unlocked()   true only with a valid, active license. False
//                             until the first answer arrives, and always false
//                             in a plain browser (no bridge).
//   Subscription.onState(fn)  fn(state) now if known, then on every change.
//                             state: { signedIn, unlocked, email, status,
//                             renewsAt, cancelsAt, checkedAt, validUntil,
//                             checking, error }
//
// Gating a feature:
//
//   Subscription.onState(() => { button.hidden = !Subscription.unlocked(); });
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
        unlocked: () => Boolean(current && current.unlocked),
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
