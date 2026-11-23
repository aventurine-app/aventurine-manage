'use strict';

// ─── The sign-in page (pages/signin.html) ───────────────────────────────────
// Once the subscription opens the app (Basic or Pro), go to it. Signing in
// gets here, and so does a reload of /signin while already signed in. The
// page is replaced, not left in the history, so Back never returns to it.
// The other direction, from the app to this page, is the main process's
// (electron/main.js, showPageForTier).

(function () {
    if (!window.Subscription) return;
    Subscription.onState((state) => {
        if (state.unlocked) location.replace('/');
    });
}());
