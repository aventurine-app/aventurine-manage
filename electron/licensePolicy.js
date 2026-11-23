'use strict';

// ─── License policy ─────────────────────────────────────────────────────────
//
// The decisions behind the Aventurine subscription check, kept free of Electron
// so the test suite can run them under plain Node
// (backend/__tests__/licensePolicy.test.js). electron/license.js does the
// network, the file and the IPC; this file answers:
//
//   • Where is the account server, and which key signs licenses?  resolveLicenseConfig
//   • Is this license genuine, and what does it say?               parseLicense
//   • Is the subscription unlocked right now?                      describeLicense
//   • What is saved on this computer?                              read/writeAccountFile
//
// One Aventurine subscription unlocks the Planner and Manage. The account
// server is the Planner's worker (aventurine-planner repo, worker/src/devices.js
// and license.js). It answers a check with a license signed by its Ed25519 key;
// the app keeps the last one and trusts it until its `validUntil`, which the
// server sets 30 days ahead for an active subscription. So Manage keeps
// working offline for a month after its last successful check, and an edit to
// the saved file cannot unlock anything, because it breaks the signature.
//
// Nothing here ever locks the user's data. A lapsed or missing license only
// decides whether subscriber features are offered.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The Planner worker. Its /api/device/* routes answer on any of its hostnames,
// so this keeps working after the Planner moves to its own domain.
const ACCOUNT_ORIGIN = 'https://aventurine-planner.aventurine-app.workers.dev';

// The public half of the worker's LICENSE_SIGNING_KEY (SPKI, base64). Made with
// the Planner repo's scripts/make-license-key.mjs; change both together.
const LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAu9vc7WziU1RPmZnxB7M4Xxd/RGNFmH2ozQGKjOt5doc=';

// Fixed, not taken from any server answer: it is opened in the user's browser.
const PRICING_URL = 'https://aventurine-app.com/#pricing';

const ACCOUNT_FILE = 'account.json';

// The worker's device token: 32 random bytes as unpadded URL-safe base64.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LICENSE_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// A dev run (npm start) may point at `wrangler dev` with its own key, or set
// AVENTURINE_DEV_UNLOCK to open the app with no account at all: '1' as Pro
// (npm start, verify-e2e), 'basic' as Basic (to see Pro features locked).
// devUnlock is then that tier, otherwise null. A packaged app never reads these,
// so nothing in the environment can steer a real install to another server,
// make it trust another key or unlock it.
const DEV_UNLOCK_TIERS = { 1: 'pro', basic: 'basic' };  // value → tier

function resolveLicenseConfig({ isPackaged, env = {} }) {
    const dev = !isPackaged;
    return {
        origin:    (dev && env.AVENTURINE_ACCOUNT_URL) || ACCOUNT_ORIGIN,
        publicKey: (dev && env.AVENTURINE_LICENSE_PUBLIC_KEY) || LICENSE_PUBLIC_KEY,
        devUnlock: dev && Object.hasOwn(DEV_UNLOCK_TIERS, env.AVENTURINE_DEV_UNLOCK)
            ? DEV_UNLOCK_TIERS[env.AVENTURINE_DEV_UNLOCK] : null,
    };
}

function publicKeyFrom(base64) {
    return crypto.createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

const isTime = (v) => Number.isFinite(v) && v >= 0;
const isTimeOrNull = (v) => v === null || isTime(v);

// Checks the signature, then the shape. Returns the payload, or null for
// anything that isn't a genuine license this version understands. Never
// throws: a bad license is a normal answer ("not unlocked"), not a crash.
function parseLicense(license, publicKeyBase64) {
    if (typeof license !== 'string' || !LICENSE_SHAPE.test(license)) return null;
    const [body, signature] = license.split('.').map((part) => Buffer.from(part, 'base64url'));
    let payload;
    try {
        if (!crypto.verify(null, body, publicKeyFrom(publicKeyBase64), signature)) return null;
        payload = JSON.parse(body.toString('utf8'));
    } catch {
        return null;
    }
    const valid = payload && payload.v === 1
        && typeof payload.email === 'string' && payload.email.length > 0
        && typeof payload.active === 'boolean'
        // Licenses signed before tiers have no `tier`; tierOf reads them.
        && (payload.tier === undefined || TIERS.includes(payload.tier))
        && typeof payload.status === 'string'
        && isTime(payload.issuedAt) && isTime(payload.validUntil)
        && isTimeOrNull(payload.renewsAt) && isTimeOrNull(payload.cancelsAt);
    return valid ? payload : null;
}

// What a subscription buys (the worker's access.js decides it from the Paddle
// price):
//   none    nothing: the app shows only the sign-in page
//   basic   Aventurine Manage
//   pro     Manage plus Plan and every later Pro feature
const TIERS = ['none', 'basic', 'pro'];

// The tier a license grants while it is valid. A license from before tiers
// existed has none written down; it counts as Basic, never more, and the next
// check (at most 6 hours away) brings the real one.
function tierOf(payload) {
    if (!payload.active) return 'none';
    return payload.tier || 'basic';
}

// What the app shows and decides from. `payload` is parseLicense's answer, or
// null when signed out. `tier` is the one value features should read:
// `unlocked` (Basic or better, the app opens) and `pro` follow from it.
function describeLicense(payload, now) {
    if (!payload) return { signedIn: false, tier: 'none', unlocked: false, pro: false };
    const tier = now < payload.validUntil ? tierOf(payload) : 'none';
    return {
        signedIn:   true,
        email:      payload.email,
        tier,
        unlocked:   tier !== 'none',
        pro:        tier === 'pro',
        // What the subscription is, even past validUntil (the Account tab
        // says "not confirmed for 30 days" from it).
        paidTier:   tierOf(payload),
        active:     payload.active,
        status:     payload.status,
        renewsAt:   payload.renewsAt,
        cancelsAt:  payload.cancelsAt,
        checkedAt:  payload.issuedAt,
        validUntil: payload.validUntil,
    };
}

// ── The saved sign-in ───────────────────────────────────────────────────────
// { token, license } in the profile, beside update-preferences.json: it
// belongs to the install, not to a database, and the first check runs before
// any database is unlocked.
//
// The token is stored as plain text, readable only by this OS user. It can do
// one thing, fetch this email's subscription status, so it isn't worth the OS
// keychain, which on Linux can ask for a password at every launch.

// Missing is the normal signed-out case. Unreadable or malformed is reported
// and treated as signed out, so the user can sign in again.
function readAccountFile(dir, { onError = () => {} } = {}) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(dir, ACCOUNT_FILE), 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') onError(err);
        return null;
    }
    try {
        const { token, license } = JSON.parse(raw);
        if (typeof token !== 'string' || !TOKEN_SHAPE.test(token) || typeof license !== 'string') {
            throw new Error('account file has no usable token');
        }
        return { token, license };
    } catch (err) {
        onError(err);
        return null;
    }
}

// Write-then-rename, as with the update preferences. Throws, so the caller can
// say the sign-in wasn't saved.
function writeAccountFile(dir, { token, license }) {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) throw new TypeError('token is malformed');
    if (typeof license !== 'string') throw new TypeError('license must be a string');
    const file = path.join(dir, ACCOUNT_FILE);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ token, license }), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

function deleteAccountFile(dir) {
    fs.rmSync(path.join(dir, ACCOUNT_FILE), { force: true });
}

module.exports = {
    ACCOUNT_ORIGIN,
    LICENSE_PUBLIC_KEY,
    PRICING_URL,
    ACCOUNT_FILE,
    TOKEN_SHAPE,
    TIERS,
    resolveLicenseConfig,
    parseLicense,
    describeLicense,
    readAccountFile,
    writeAccountFile,
    deleteAccountFile,
};
