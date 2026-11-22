'use strict';

// ─── Aventurine account (Preferences → Account) ─────────────────────────────
// Sign in, sign out and the subscription's status. Every decision is made in
// the main process (electron/license.js); this file draws the state it gets
// from window.Subscription (core/subscription.js) and sends the user's email
// and code over the electronLicense bridge (preload.js).
//
// Three views, one at a time (data-account-view in chrome.html):
//   email      signed out: type an email, get a code
//   code       a code was asked for: type it in
//   signed-in  who is signed in and what the subscription is doing
// Only "code" is local to this page: the email waiting for its code. Leaving
// the page drops it, and the user asks for a new code, which is harmless.
//
// In a plain browser the bridge is absent and the tab's section stays empty.

(function () {
    const license = window.electronLicense;
    const section = document.querySelector('[data-account-section]');
    if (!license || !section || !window.Subscription) return;

    const views       = section.querySelectorAll('[data-account-view]');
    const emailForm   = section.querySelector('form[data-account-view="email"]');
    const codeForm    = section.querySelector('form[data-account-view="code"]');
    const emailInput  = section.querySelector('[data-account-email]');
    const codeInput   = section.querySelector('[data-account-code]');
    const codeDesc    = section.querySelector('[data-account-code-desc]');
    const sendBtn     = section.querySelector('[data-account-send]');
    const verifyBtn   = section.querySelector('[data-account-verify]');
    const restartBtn  = section.querySelector('[data-account-restart]');
    const emailText   = section.querySelector('[data-account-email-text]');
    const statusText  = section.querySelector('[data-account-status]');
    const checkBtn    = section.querySelector('[data-account-check]');
    const signOutBtn  = section.querySelector('[data-account-signout]');
    const pricingBtns = section.querySelectorAll('[data-account-pricing]');
    const errorRow    = section.querySelector('[data-account-error-row]');
    const errorText   = section.querySelector('[data-account-error]');

    const ERRORS = {
        offline:       'Couldn’t reach Aventurine. Check your internet connection and try again.',
        server:        'Something went wrong on our side. Try again in a few minutes.',
        rate_limited:  'Too many tries. Wait a minute and try again.',
        invalid_email: 'Enter a valid email address.',
        invalid_code:  'That code didn’t work. Check it and try again, or ask for a new one.',
        bad_license:   'This version of Aventurine Manage can’t read your license. Update the app and try again.',
    };

    let pendingEmail = null;
    let current = null;

    const longDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });

    function showError(code) {
        errorText.textContent = code ? (ERRORS[code] || ERRORS.server) : '';
        errorRow.hidden = !code;
    }

    // One sentence on the subscription, then when it was last confirmed.
    function describe(s) {
        if (!s.email) return 'Checking your subscription…';
        let line;
        if (s.unlocked) {
            if (s.status === 'complimentary') line = 'Active, complimentary.';
            else if (s.cancelsAt) line = `Active until ${longDate(s.cancelsAt)}. It won’t renew.`;
            else if (s.status === 'past_due') line = 'Active. Your last payment didn’t go through, so Paddle will try again. You can update your card from Aventurine Planner’s billing settings.';
            else if (s.status === 'trialing') line = s.renewsAt ? `Free trial, until ${longDate(s.renewsAt)}.` : 'Free trial.';
            else line = s.renewsAt ? `Active. Renews on ${longDate(s.renewsAt)}.` : 'Active.';
        } else if (s.active) {
            line = 'Not confirmed for 30 days. Connect to the internet and choose Check Now to unlock subscriber features again.';
        } else {
            line = 'No active subscription. Subscriber features are locked; everything else works as usual.';
        }
        if (s.checking) return `${line} Checking…`;
        if (s.error && s.unlocked) return `${line} Couldn’t check just now; subscriber features stay unlocked until ${longDate(s.validUntil)}.`;
        return `${line} Last checked ${longDate(s.checkedAt)}.`;
    }

    function render(s) {
        current = s;
        const view = s.signedIn ? 'signed-in' : (pendingEmail ? 'code' : 'email');
        views.forEach(el => { el.hidden = el.dataset.accountView !== view; });

        if (view === 'signed-in') {
            pendingEmail = null;
            emailText.textContent = s.email || '';
            statusText.textContent = describe(s);
            checkBtn.disabled = s.checking;
            checkBtn.textContent = s.checking ? 'Checking…' : 'Check Now';
            // The status row's See Plans: only when there's nothing active.
            pricingBtns.forEach(btn => {
                if (btn.closest('[data-account-view="signed-in"]')) btn.hidden = Boolean(s.email && s.active);
            });
            // A failed background check is said in the status line, not as an error.
            if (s.error && !s.unlocked && s.email) showError(s.error);
        }
    }

    // Runs a bridge action with its button busy, and shows its error if any.
    async function run(button, busyLabel, action) {
        const label = button.textContent;
        button.disabled = true;
        button.textContent = busyLabel;
        showError(null);
        try {
            const result = await action();
            if (!result.ok) showError(result.error);
            return result.ok;
        } catch (err) {
            console.error('[account]', err);
            showError('server');
            return false;
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    }

    emailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (!email || !emailInput.checkValidity()) {
            showError('invalid_email');
            emailInput.focus();
            return;
        }
        if (!(await run(sendBtn, 'Sending…', () => license.requestCode(email)))) return;
        pendingEmail = email;
        codeDesc.textContent = `If ${email} has an active Aventurine subscription, a 6-digit code is on its way. It expires in 10 minutes.`;
        codeInput.value = '';
        render(current || { signedIn: false });
        codeInput.focus();
    });

    codeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = codeInput.value.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) {
            showError('invalid_code');
            codeInput.focus();
            return;
        }
        if (await run(verifyBtn, 'Signing in…', () => license.verifyCode(pendingEmail, code))) {
            pendingEmail = null;
            codeInput.value = '';
            UI.toast('Signed in to your Aventurine account.');
        }
    });

    restartBtn.addEventListener('click', () => {
        pendingEmail = null;
        showError(null);
        render(current || { signedIn: false });
        emailInput.focus();
    });

    checkBtn.addEventListener('click', () => {
        showError(null);
        license.check().catch(err => console.error('[account] check failed:', err));
    });

    signOutBtn.addEventListener('click', async () => {
        showError(null);
        try {
            await license.signOut();
            emailInput.value = '';
            UI.toast('Signed out. Subscriber features are locked on this computer.');
        } catch (err) {
            console.error('[account] sign-out failed:', err);
            showError('server');
        }
    });

    pricingBtns.forEach(btn => btn.addEventListener('click', () => {
        license.openPricingPage().catch(err => {
            console.error('[account] opening the pricing page failed:', err);
            UI.toast('Couldn’t open the pricing page.', { type: 'error' });
        });
    }));

    Subscription.onState(render);
}());
