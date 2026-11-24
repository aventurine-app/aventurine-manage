// ─── devices.js ─────────────────────────────────────────────────────────────
// Signing in from the Aventurine Manage desktop app, and telling it whether
// what its subscription unlocks: Basic opens Manage, Pro adds Planner and
// every later Pro feature (access.js).
//
//   POST /api/device/code      { email }        email a 6-digit code
//   POST /api/device/verify    { email, code }  spend it: { token, license }
//   POST /api/device/license   Bearer token     a fresh signed license
//   POST /api/device/signout   Bearer token     forget this device
//
// Why a code and not a link: an emailed link opens a browser, and handing the
// result back to a desktop app needs a custom URL scheme, which Linux
// AppImage and Flatpak installs do not register reliably. Six digits typed
// into the app work everywhere.
//
// Choices that matter:
//   • Requesting a code answers the same for everyone, and only emails an
//     address that has access, so the form cannot probe for customers.
//   • A code has a million values, so guessing is limited three ways: each code
//     takes MAX_CODE_ATTEMPTS wrong guesses before it is burned, an address gets
//     MAX_CODES_PER_WINDOW codes per CODE_TTL_MS, and each IP is rate limited.
//     That allows about 15 guesses per address per 10 minutes.
//   • Only hashes of codes and device tokens are stored.
//   • A beta spot (beta.js) counts as access. Its first successful sign-in
//     claims it, which is the first proof the address is really theirs.
//   • The device token only asks for a license. It opens nothing else.
//   • These routes carry no cookie, so a forged cross-site request gains
//     nothing. A request from a web page must still come from our own origin,
//     so other sites cannot use their visitors to spend our rate limits.
//   • They answer on any of the worker's hostnames (index.js), so moving the
//     app to its own domain does not sign out installed copies: a redirect to
//     another host would drop the Authorization header.

import { hasAccess, summarize, tierFor } from './access.js';
import { randomToken, sha256Hex, timingSafeEqual, TOKEN_SHAPE } from './crypto.js';
import { deviceCodeMessage } from './email.js';
import { normalizeEmail } from './email-address.js';
import { HttpError, json, readJsonBody } from './http.js';
import { licensePayload, signLicense } from './license.js';
import {
    claimBetaSpot, claimDeviceCodeAttempt, countDeviceCodes, createDeviceCode, createDeviceToken, deleteDeviceToken,
    isBetaMember, subscriptionsFor, touchDevice, useDeviceCode,
} from './store.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const CODE_TTL_MS = 10 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3;
// A device that has not checked in for this long is signed out. The app checks
// every few hours while it is open.
export const DEVICE_IDLE_MS = 180 * DAY;

const CODE_SHAPE = /^\d{6}$/;
const DEVICE_PREFIX = '/api/device/';

export const isDevicePath = (path) => path.startsWith(DEVICE_PREFIX);

/** A uniformly random 6-digit code, leading zeros kept. */
function randomCode() {
    // Reject the top of the 32-bit range so every code is equally likely.
    const limit = Math.floor(0x100000000 / 1e6) * 1e6;
    const buffer = new Uint32Array(1);
    do {
        crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);
    return String(buffer[0] % 1e6).padStart(6, '0');
}

const codeHash = (email, code) => sha256Hex(`${email}:${code}`);

/** A browser may call these only from our own pages; the desktop app sends no Origin. */
function requireOwnOriginIfAny(request, appOrigin) {
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== appOrigin) throw new HttpError(403, 'forbidden');
}

function bearerToken(request) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') || '');
    return match && TOKEN_SHAPE.test(match[1]) ? match[1] : null;
}

/** A signed license for `email`, given its subscriptions. A beta spot shows in the app as complimentary. */
async function issueLicense(deps, { email, subscriptions }) {
    const beta = await isBetaMember(deps.db, email);
    const complimentary = beta || deps.config.complimentary.has(email);
    const payload = licensePayload({
        email,
        tier: tierFor({ email, subscriptions, complimentary: deps.config.complimentary, proPrices: deps.config.proPrices, beta }),
        subscription: summarize(subscriptions),
        complimentary,
        now: deps.now(),
    });
    return signLicense(payload, deps.licenseKey);
}

async function requestCode(deps, rawEmail, ip) {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new HttpError(400, 'invalid_email');
    if (!(await deps.rateLimit(`device-code:${ip}`))) throw new HttpError(429, 'rate_limited');

    const subscriptions = await subscriptionsFor(deps.db, email);
    const beta = await isBetaMember(deps.db, email);
    if (!hasAccess({ email, subscriptions, complimentary: deps.config.complimentary, beta })) return;
    deps.defer(sendCode(deps, email).catch((e) => console.error('[device] sign-in code failed:', e.message)));
}

async function sendCode(deps, email) {
    const now = deps.now();
    if (await countDeviceCodes(deps.db, { email, since: now - CODE_TTL_MS }) >= MAX_CODES_PER_WINDOW) return;
    const code = randomCode();
    await createDeviceCode(deps.db, { email, codeHash: await codeHash(email, code), now, ttlMs: CODE_TTL_MS });
    await deps.mail({ to: email, message: deviceCodeMessage(code, CODE_TTL_MS / MINUTE) });
}

/** Spend a code and register the device. Returns { token, license } or null. */
async function verifyCode(deps, rawEmail, rawCode, ip) {
    if (!(await deps.rateLimit(`device-verify:${ip}`))) throw new HttpError(429, 'rate_limited');
    const email = normalizeEmail(rawEmail);
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s/g, '') : '';
    if (!email || !CODE_SHAPE.test(code)) return null;

    const now = deps.now();
    const candidate = await claimDeviceCodeAttempt(deps.db, { email, now, maxAttempts: MAX_CODE_ATTEMPTS });
    if (!candidate || !timingSafeEqual(candidate.code_hash, await codeHash(email, code))) return null;
    // Signed before the code is spent, so a missing signing key fails without
    // costing the person their code.
    const license = await issueLicense(deps, { email, subscriptions: await subscriptionsFor(deps.db, email) });
    if (!(await useDeviceCode(deps.db, { id: candidate.id, now }))) return null;
    await claimBetaSpot(deps.db, { email, now });

    const token = randomToken();
    await createDeviceToken(deps.db, { tokenHash: await sha256Hex(token), email, now, ttlMs: DEVICE_IDLE_MS });
    return { token, license };
}

/** The device for this request's bearer token, kept alive, or null. */
async function currentDevice(deps, request) {
    const token = bearerToken(request);
    if (!token) return null;
    return touchDevice(deps.db, { tokenHash: await sha256Hex(token), now: deps.now(), ttlMs: DEVICE_IDLE_MS });
}

/** Route a /api/device/* request. `deps` is index.js's dependencies plus `licenseKey`. */
export async function handleDevice(request, deps, path, ip) {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    requireOwnOriginIfAny(request, deps.config.appOrigin);

    if (path === '/api/device/code') {
        const body = await readJsonBody(request);
        await requestCode(deps, body.email, ip);
        return json({ ok: true }, 202);
    }

    if (path === '/api/device/verify') {
        const body = await readJsonBody(request);
        const result = await verifyCode(deps, body.email, body.code, ip);
        return result ? json({ ok: true, ...result }) : json({ ok: false, error: 'invalid_code' }, 400);
    }

    if (path === '/api/device/license') {
        if (!(await deps.rateLimit(`device-license:${ip}`))) throw new HttpError(429, 'rate_limited');
        const device = await currentDevice(deps, request);
        if (!device) return json({ ok: false, error: 'signed_out' }, 401);
        return json({ ok: true, license: await issueLicense(deps, device) });
    }

    if (path === '/api/device/signout') {
        const token = bearerToken(request);
        if (token) await deleteDeviceToken(deps.db, await sha256Hex(token));
        return json({ ok: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
}
