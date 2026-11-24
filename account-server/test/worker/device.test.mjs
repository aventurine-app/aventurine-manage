// Aventurine Manage's sign-in: the emailed code, the device token it buys, and
// the signed license the desktop app keeps (worker/src/devices.js, license.js).

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODE_TTL_MS, DEVICE_IDLE_MS, MAX_CODE_ATTEMPTS } from '../../worker/src/devices.js';
import { OFFLINE_GRACE_MS } from '../../worker/src/license.js';
import { BASIC_PRICE, createSite, OWNER } from './harness.mjs';

const MINUTE = 60 * 1000;

const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_KEY = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');

/** A site whose worker can sign licenses. The desktop app sends no Origin. */
function manageSite(options) {
    const site = createSite(options);
    site.env.LICENSE_SIGNING_KEY = SIGNING_KEY;
    return site;
}

const post = (site, path, { json, token, origin = null, base } = {}) => site.call(path, {
    method: 'POST',
    origin,
    base,
    json: json ?? {},
    headers: token ? { Authorization: `Bearer ${token}` } : {},
});

const requestCode = (site, email, options) => post(site, '/api/device/code', { json: { email }, ...options });
const verify = (site, email, code) => post(site, '/api/device/verify', { json: { email, code } });
const checkLicense = (site, token) => post(site, '/api/device/license', { token });
const codeIn = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];

/** Check a license's signature with the public key, as the app does, and read it. */
async function readLicense(license) {
    const [body, signature] = license.split('.').map((part) => Buffer.from(part, 'base64url'));
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, keys.publicKey, signature, body);
    assert.ok(valid, 'license signature');
    return JSON.parse(body.toString('utf8'));
}

async function signIn(site, email) {
    await requestCode(site, email);
    const response = await verify(site, email, codeIn(site.sent.emails.at(-1)));
    assert.equal(response.status, 200);
    return response.json();
}

test('a subscriber is emailed a code that signs the app in with an active, signed license', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });

    assert.equal((await requestCode(site, 'Alice@Example.com')).status, 202);
    assert.equal(site.sent.emails.length, 1);
    const mail = site.sent.emails[0];
    assert.deepEqual(mail.to, ['alice@example.com']);
    assert.match(mail.subject, /^\d{6} is your Aventurine Manage sign-in code$/);

    const response = await verify(site, 'alice@example.com', codeIn(mail));
    assert.equal(response.status, 200);
    const { token, license } = await response.json();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const payload = await readLicense(license);
    assert.equal(payload.email, 'alice@example.com');
    assert.equal(payload.active, true);
    assert.equal(payload.tier, 'pro');
    assert.equal(payload.status, 'active');
    assert.equal(payload.issuedAt, site.clock.now);
    assert.equal(payload.validUntil, site.clock.now + OFFLINE_GRACE_MS);

    const stored = site.db.sqlite.prepare('SELECT token_hash, email FROM device_tokens').all();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].token_hash, token, 'only a hash of the token is kept');
    const codes = site.db.sqlite.prepare('SELECT code_hash FROM device_codes').all();
    assert.ok(!codes[0].code_hash.includes(codeIn(mail)), 'only a hash of the code is kept');
});

test('complimentary addresses sign in too', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    const { license } = await signIn(site, OWNER);
    const payload = await readLicense(license);
    assert.equal(payload.active, true);
    assert.equal(payload.status, 'complimentary');
    assert.equal(payload.tier, 'pro');
});

test('a stranger or lapsed subscriber gets the same answer and no email', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'gone@example.com', status: 'canceled' });

    for (const email of ['stranger@example.com', 'gone@example.com']) {
        const response = await requestCode(site, email);
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal(site.sent.emails.length, 0);
});

test('a code is burned after too many wrong guesses', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    await requestCode(site, 'alice@example.com');
    const code = codeIn(site.sent.emails[0]);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
        assert.equal((await verify(site, 'alice@example.com', wrong)).status, 400);
    }
    assert.equal((await verify(site, 'alice@example.com', code)).status, 400);
});

test('a code works once, only for its own address, and only until it expires', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    await site.subscribe({ email: 'bob@example.com', customerId: 'ctm_01bob', subscriptionId: 'sub_01bob' });

    await requestCode(site, 'alice@example.com');
    const code = codeIn(site.sent.emails[0]);
    assert.equal((await verify(site, 'bob@example.com', code)).status, 400);
    assert.equal((await verify(site, 'alice@example.com', code)).status, 200);
    assert.equal((await verify(site, 'alice@example.com', code)).status, 400);

    await requestCode(site, 'alice@example.com');
    site.advance(CODE_TTL_MS + 1);
    assert.equal((await verify(site, 'alice@example.com', codeIn(site.sent.emails.at(-1)))).status, 400);
});

test('only the newest code counts, and an address gets three codes per window', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });

    for (let i = 0; i < 4; i++) await requestCode(site, 'alice@example.com');
    assert.equal(site.sent.emails.length, 3);
    const [first, , newest] = site.sent.emails.map(codeIn);
    if (first !== newest) assert.equal((await verify(site, 'alice@example.com', first)).status, 400);
    assert.equal((await verify(site, 'alice@example.com', newest)).status, 200);
});

test('the license follows the subscription, and signing out forgets the device', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const { token } = await signIn(site, 'alice@example.com');

    let response = await checkLicense(site, token);
    assert.equal(response.status, 200);
    assert.equal((await readLicense((await response.json()).license)).active, true);

    site.advance(MINUTE);
    await site.subscribe({ email: 'alice@example.com', status: 'canceled' });
    response = await checkLicense(site, token);
    const lapsed = await readLicense((await response.json()).license);
    assert.equal(lapsed.active, false);
    assert.equal(lapsed.tier, 'none');
    assert.equal(lapsed.status, 'canceled');
    assert.equal(lapsed.validUntil, site.clock.now, 'an inactive license has no offline period');

    assert.equal((await post(site, '/api/device/signout', { token })).status, 200);
    assert.equal((await checkLicense(site, token)).status, 401);
});

test('the license names the tier the Paddle price buys: Basic for Manage, Pro for Planner too', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com', priceId: BASIC_PRICE });
    const { token, license } = await signIn(site, 'alice@example.com');
    const basic = await readLicense(license);
    assert.equal(basic.active, true);
    assert.equal(basic.tier, 'basic');
    assert.ok(basic.validUntil > site.clock.now, 'Basic gets the offline period too');

    // An upgrade changes the price on the same subscription.
    site.advance(MINUTE);
    await site.subscribe({ email: 'alice@example.com', priceId: 'pri_other_pro' });
    const upgraded = await readLicense((await (await checkLicense(site, token)).json()).license);
    assert.equal(upgraded.tier, 'pro');

    // A second, Basic subscription alongside a Pro one does not lower the tier.
    await site.subscribe({ email: 'alice@example.com', subscriptionId: 'sub_01alice2', priceId: BASIC_PRICE });
    const both = await readLicense((await (await checkLicense(site, token)).json()).license);
    assert.equal(both.tier, 'pro');
});

test('a device token is refused when unknown, malformed or idle too long, and opens nothing else', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const { token } = await signIn(site, 'alice@example.com');

    assert.equal((await checkLicense(site, 'x'.repeat(43))).status, 401);
    assert.equal((await post(site, '/api/device/license', {})).status, 401);
    const asPrivacyLink = await site.call('/api/privacy/report', { method: 'POST', json: { token } });
    assert.notEqual(asPrivacyLink.status, 200, 'not a privacy link');

    site.advance(DEVICE_IDLE_MS - MINUTE);
    assert.equal((await checkLicense(site, token)).status, 200, 'a check pushes the expiry forward');
    site.advance(DEVICE_IDLE_MS + MINUTE);
    assert.equal((await checkLicense(site, token)).status, 401);
});

test('web pages on other sites cannot call the device routes; our own page and the app can', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });

    assert.equal((await requestCode(site, 'alice@example.com', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await requestCode(site, 'alice@example.com', { origin: site.env.APP_ORIGIN })).status, 202);
    assert.equal((await requestCode(site, 'alice@example.com')).status, 202);
    assert.equal((await site.call('/api/device/license')).status, 405);
});

test('the device routes answer on any hostname, so a domain move keeps the app signed in', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const { token } = await signIn(site, 'alice@example.com');

    const response = await post(site, '/api/device/license', { token, base: 'https://old-host.workers.dev' });
    assert.equal(response.status, 200);
    assert.equal((await site.call('/api/me', { base: 'https://old-host.workers.dev' })).status, 308);
});

test('without a signing key, verifying fails without spending the code', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    await requestCode(site, 'alice@example.com');
    const code = codeIn(site.sent.emails[0]);

    site.env.LICENSE_SIGNING_KEY = '';
    const errors = t.mock.method(console, 'error', () => {});
    assert.equal((await verify(site, 'alice@example.com', code)).status, 500);
    assert.equal(errors.mock.callCount(), 1);

    site.env.LICENSE_SIGNING_KEY = SIGNING_KEY;
    assert.equal((await verify(site, 'alice@example.com', code)).status, 200);
});

test('deleting an account deletes its devices and codes, and the privacy report lists them', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    await signIn(site, 'alice@example.com');

    const { privacyRecords, eraseAccount } = await import('../../worker/src/store.js');
    const held = await privacyRecords(site.db, { email: 'alice@example.com', now: site.clock.now });
    assert.equal(held.devices.length, 1);

    await eraseAccount(site.db, { email: 'alice@example.com', customerHashes: [], requestedAt: site.clock.now, now: site.clock.now });
    for (const table of ['device_tokens', 'device_codes']) {
        assert.equal(site.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
});

test('the daily job drops expired codes and idle devices', async (t) => {
    const site = manageSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    await signIn(site, 'alice@example.com');
    await requestCode(site, 'alice@example.com');

    site.advance(DEVICE_IDLE_MS + MINUTE);
    await site.cron();
    for (const table of ['device_tokens', 'device_codes']) {
        assert.equal(site.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
});
