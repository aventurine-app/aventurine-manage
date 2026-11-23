'use strict';

// ─── Aventurine subscription ────────────────────────────────────────────────
//
// Signs the app in to an Aventurine account and keeps track of what its
// subscription buys: nothing (the app shows only its sign-in page), Basic
// (Aventurine Manage) or Pro (Manage plus Plan and later Pro features). The rules
// (which server, which key, what a license means, the saved file) are in
// licensePolicy.js; this file does the requests, the timers and the IPC. The
// renderer reaches it through window.electronLicense (preload.js); the UI is
// static/js/shell/account.js, and features ask static/js/core/subscription.js.
//
// Signing in: the user types their email, the server emails a 6-digit code to
// an address with an active subscription, and the user types the code here.
// The server answers with a device token and a signed license, both saved in
// the profile (licensePolicy.js, account.json).
//
// Checking: while signed in, the app asks for a fresh license 10 seconds after
// launch (at once if the saved one no longer opens the app) and every 6 hours. A failed check changes nothing: the saved license
// keeps features unlocked until its validUntil (30 days after the last good
// check). A 401 means the server no longer knows this device, so the app signs
// out.
//
// NETWORK CONTRACT: signed out, this file makes no request at all. Signed in,
// it talks only to the account server, and sends only the email being signed
// in (once), the code, and the device token. Nothing about the user's money or
// database ever leaves the computer.

const { app, ipcMain, net, shell } = require('electron');
const policy = require('./licensePolicy');

const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const MAX_EMAIL_LENGTH = 254;

// What went wrong, as codes the renderer turns into sentences (account.js).
//   offline       the server could not be reached
//   server        it answered with something unexpected
//   rate_limited  too many tries; wait a minute
//   invalid_email, invalid_code
//   bad_license   the server's signature doesn't match this build's key
class AccountError extends Error {
    constructor(code, detail) {
        super(detail || code);
        this.code = code;
    }
}

function initLicense({ getWindow, onTierChange = () => {} }) {
    const dir = app.getPath('userData');
    const config = policy.resolveLicenseConfig({ isPackaged: app.isPackaged, env: process.env });

    let saved = policy.readAccountFile(dir, {
        onError: (err) => console.error('[license] saved sign-in unreadable, signed out:', err.message),
    });
    let payload = saved ? policy.parseLicense(saved.license, config.publicKey) : null;
    // A token with a license this build can't read (the key changed, say) is
    // still a sign-in: the next check fetches a license it can.
    let checking = false;
    let lastError = null;

    function snapshot() {
        const described = policy.describeLicense(payload, Date.now());
        if (saved && !payload) Object.assign(described, { signedIn: true, email: null });
        if (config.devUnlock) Object.assign(described, { tier: config.devUnlock, unlocked: true, pro: config.devUnlock === 'pro' });
        return { ...described, checking, error: lastError };
    }

    // The main process swaps between the sign-in page and the app when the
    // tier changes (main.js), so it hears about every change, not only the
    // window.
    let lastTier = snapshot().tier;

    // A license runs out at its validUntil without any check happening (a
    // month offline, say). Push the state at that moment too, so an open
    // Plan section locks then rather than at the next launch.
    let expiryTimer = null;
    function watchExpiry() {
        clearTimeout(expiryTimer);
        expiryTimer = null;
        if (!payload || !payload.active) return;
        const wait = payload.validUntil - Date.now();
        if (wait <= 0) return;
        // setTimeout overflows past 2^31-1 ms (~24.8 days); re-arm from there.
        const MAX_WAIT = 2 ** 31 - 1;
        expiryTimer = setTimeout(() => (wait > MAX_WAIT ? watchExpiry() : push()), Math.min(wait + 1000, MAX_WAIT));
    }

    function push() {
        watchExpiry();
        const state = snapshot();
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('license:status', state);
        if (state.tier !== lastTier) {
            lastTier = state.tier;
            onTierChange(state.tier);
        }
    }

    // ── Requests ────────────────────────────────────────────────────────────

    async function post(path, body, token) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        let res;
        try {
            res = await net.fetch(`${config.origin}${path}`, {
                method:      'POST',
                headers,
                body:        JSON.stringify(body),
                credentials: 'omit',
                signal:      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (err) {
            throw new AccountError('offline', err.message);
        }
        let answer = null;
        try {
            answer = await res.json();
        } catch {
            // Read as "unexpected" below.
        }
        return { status: res.status, answer: answer || {} };
    }

    function unexpected(path, { status, answer }) {
        if (status === 429) return new AccountError('rate_limited');
        return new AccountError('server', `${path} answered HTTP ${status} ${answer.error || ''}`.trim());
    }

    // Saves a license the server just sent. Refuses one this build can't
    // verify rather than saving something that would never unlock anything.
    function accept(token, license) {
        const parsed = policy.parseLicense(license, config.publicKey);
        if (!parsed) throw new AccountError('bad_license', 'license signature or shape not accepted');
        policy.writeAccountFile(dir, { token, license });
        saved = { token, license };
        payload = parsed;
    }

    function forget() {
        policy.deleteAccountFile(dir);
        saved = null;
        payload = null;
    }

    // ── Actions ─────────────────────────────────────────────────────────────
    // Each IPC action answers { ok, error } and pushes the new state, so the
    // renderer draws from one place (the 'license:status' push).

    async function requestCode(email) {
        if (typeof email !== 'string' || !email.trim() || email.length > MAX_EMAIL_LENGTH) {
            throw new AccountError('invalid_email');
        }
        const reply = await post('/api/device/code', { email: email.trim() });
        if (reply.status === 202) return;
        if (reply.status === 400 && reply.answer.error === 'invalid_email') throw new AccountError('invalid_email');
        throw unexpected('code', reply);
    }

    async function verifyCode(email, code) {
        if (typeof email !== 'string' || typeof code !== 'string') throw new AccountError('invalid_code');
        const reply = await post('/api/device/verify', { email: email.trim(), code: code.replace(/\s/g, '') });
        if (reply.status === 400) throw new AccountError('invalid_code');
        if (reply.status !== 200 || !policy.TOKEN_SHAPE.test(reply.answer.token || '')) throw unexpected('verify', reply);
        accept(reply.answer.token, reply.answer.license);
        lastError = null;
        startChecks(CHECK_INTERVAL_MS);
    }

    let checkInFlight = null;

    // Never rejects: a failure becomes `error` in the state, and the saved
    // license keeps doing its job until it runs out.
    function check() {
        if (!saved) return Promise.resolve();
        if (checkInFlight) return checkInFlight;
        checking = true;
        push();
        checkInFlight = (async () => {
            const token = saved.token;
            try {
                const reply = await post('/api/device/license', {}, token);
                // Signed out (or in again) while this was in flight: the
                // answer is about a sign-in that no longer exists.
                if (!saved || saved.token !== token) return;
                if (reply.status === 401) {
                    forget();
                    stopChecks();
                } else if (reply.status === 200) {
                    accept(token, reply.answer.license);
                } else {
                    throw unexpected('license', reply);
                }
                lastError = null;
            } catch (err) {
                console.error('[license] check failed:', err.message);
                lastError = err instanceof AccountError ? err.code : 'server';
            }
        })().finally(() => {
            checking = false;
            checkInFlight = null;
            push();
        });
        return checkInFlight;
    }

    async function signOut() {
        const token = saved && saved.token;
        forget();
        stopChecks();
        lastError = null;
        push();
        // Tell the server to forget the device too. If it can't be reached the
        // token is gone from here anyway, and the server drops it after 180
        // days without a check.
        if (token) {
            try {
                await post('/api/device/signout', {}, token);
            } catch (err) {
                console.error('[license] sign-out not sent to the server:', err.message);
            }
        }
    }

    // ── Automatic checks ────────────────────────────────────────────────────

    let firstTimer = null;
    let intervalTimer = null;

    function stopChecks() {
        clearTimeout(firstTimer);
        clearInterval(intervalTimer);
        firstTimer = null;
        intervalTimer = null;
    }

    function startChecks(delayMs) {
        stopChecks();
        firstTimer = setTimeout(() => {
            check();
            intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
        }, delayMs);
    }

    // ── IPC ─────────────────────────────────────────────────────────────────
    // Registered before the window loads, like the updater's. Only the email
    // and code come from the renderer; the server and the pricing page are
    // constants.

    // Runs an action and turns its failure into { ok: false, error: code }.
    async function answer(action) {
        try {
            await action();
            return { ok: true };
        } catch (err) {
            if (!(err instanceof AccountError)) {
                console.error('[license] unexpected failure:', err);
                return { ok: false, error: 'server' };
            }
            if (err.code === 'server' || err.code === 'bad_license' || err.code === 'offline') {
                console.error(`[license] ${err.code}:`, err.message);
            }
            return { ok: false, error: err.code };
        } finally {
            push();
        }
    }

    ipcMain.handle('license:get-state', () => snapshot());
    ipcMain.handle('license:request-code', (_e, email) => answer(() => requestCode(email)));
    ipcMain.handle('license:verify-code', (_e, email, code) => answer(() => verifyCode(email, code)));
    ipcMain.handle('license:check', async () => { await check(); return snapshot(); });
    ipcMain.handle('license:sign-out', async () => { await signOut(); return snapshot(); });
    ipcMain.handle('license:open-pricing', () => shell.openExternal(policy.PRICING_URL));

    // A saved sign-in that no longer opens the app (a month offline, say) is
    // checked at once: the user is looking at the sign-in page meanwhile.
    if (saved) startChecks(snapshot().unlocked ? FIRST_CHECK_DELAY_MS : 0);
    watchExpiry();
    if (config.devUnlock) console.log(`[license] AVENTURINE_DEV_UNLOCK: ${config.devUnlock} unlocked for this dev run`);

    // For the main process: the tier right now. The protocol handler serves
    // the sign-in page below Basic, and the backend asks before every request
    // (conn.setSubscriptionCheck).
    return { tier: () => snapshot().tier };
}

module.exports = { initLicense };
