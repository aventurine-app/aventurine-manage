// The beta signup on the pricing page (worker/src/beta.js): a capped number of
// spots, each a free Pro license once its address signs in to Aventurine Manage.

import assert from 'node:assert/strict';
import test from 'node:test';

import { BETA_HOLD_MS } from '../../worker/src/store.js';
import { createSite, SITE } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;

const join = (site, email, { origin = SITE } = {}) => site.call('/api/beta/join', { method: 'POST', origin, json: { email } });
const status = async (site) => (await site.call('/api/beta')).json();
const codeIn = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];
const devicePost = (site, path, json) => site.call(path, { method: 'POST', origin: null, json });

/** Read a license's payload (its signature is checked in device.test.mjs). */
const payloadOf = (license) => JSON.parse(Buffer.from(license.split('.')[0], 'base64url').toString('utf8'));

async function signIn(site, email) {
    await devicePost(site, '/api/device/code', { email });
    const mail = site.sent.emails.at(-1);
    assert.match(mail.subject, /sign-in code/);
    const response = await devicePost(site, '/api/device/verify', { email, code: codeIn(mail) });
    assert.equal(response.status, 200);
    return response.json();
}

test('the pricing page can read how many spots are left, from its own origin', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const response = await site.call('/api/beta');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.deepEqual(await response.json(), { ok: true, open: true, limit: 3, remaining: 3 });
});

test('joining reserves a spot and emails a download link, once', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const response = await join(site, 'Bea@Example.com');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.deepEqual(await response.json(), { ok: true, status: 'joined' });
    assert.equal(site.sent.emails.length, 1);
    assert.deepEqual(site.sent.emails[0].to, ['bea@example.com']);
    assert.match(site.sent.emails[0].text, /https:\/\/site\.example\.test\/downloads\.html/);
    assert.match(site.sent.emails[0].text, /within 14 days/);
    assert.equal((await status(site)).remaining, 2);

    // Joining again answers the same, takes no second spot and sends nothing.
    assert.deepEqual(await (await join(site, 'bea@example.com')).json(), { ok: true, status: 'joined' });
    assert.equal(site.sent.emails.length, 1);
    assert.equal((await status(site)).remaining, 2);
});

test('the spots run out at BETA_LIMIT, but a member still gets the same answer', async (t) => {
    const site = createSite({ betaLimit: '2' });
    t.after(site.restore);
    await join(site, 'a@example.com');
    await join(site, 'b@example.com');
    assert.deepEqual(await (await join(site, 'c@example.com')).json(), { ok: true, status: 'full' });
    assert.deepEqual(await (await join(site, 'a@example.com')).json(), { ok: true, status: 'joined' });
    assert.deepEqual(await status(site), { ok: true, open: false, limit: 2, remaining: 0 });
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM beta_members').get().n, 2);
    assert.equal(site.sent.emails.length, 2);
});

test('only the site may join: other origins, no origin, and a bad address are refused', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal((await join(site, 'x@example.com', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await join(site, 'x@example.com', { origin: null })).status, 403);
    const bad = await join(site, 'not an email');
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('Access-Control-Allow-Origin'), SITE, 'a refusal is readable by the page');
    assert.equal((await status(site)).remaining, 3);
    assert.equal(site.sent.emails.length, 0);
});

test('the preflight allows a JSON POST from the site', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const response = await site.call('/api/beta/join', { method: 'OPTIONS', origin: SITE });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
});

test('joining is rate limited per IP', async (t) => {
    const site = createSite();
    t.after(site.restore);
    site.limit('beta:unknown');
    assert.equal((await join(site, 'x@example.com')).status, 429);
    assert.equal((await status(site)).remaining, 3);
});

test('a zero limit or no site origin closes the beta', async (t) => {
    for (const options of [{ betaLimit: '0' }, { betaLimit: 'lots' }, { siteOrigin: '' }]) {
        const site = createSite(options);
        t.after(site.restore);
        assert.deepEqual(await status(site), { ok: true, open: false, limit: 0, remaining: 0 });
        assert.deepEqual(await (await join(site, 'x@example.com')).json(), { ok: true, status: 'closed' });
        assert.equal(site.sent.emails.length, 0);
    }
});

test('a beta member signs in to Manage with a complimentary Pro license, which claims the spot', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await join(site, 'bea@example.com');
    const { license } = await signIn(site, 'bea@example.com');
    const payload = payloadOf(license);
    assert.equal(payload.active, true);
    assert.equal(payload.tier, 'pro');
    assert.equal(payload.status, 'complimentary');
    const row = site.db.sqlite.prepare('SELECT claimed_at FROM beta_members WHERE email = ?').get('bea@example.com');
    assert.equal(row.claimed_at, site.clock.now);
});

test('an unclaimed spot is freed after the hold; a claimed one is kept with no end date', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await join(site, 'claimed@example.com');
    await join(site, 'idle@example.com');
    const { token } = await signIn(site, 'claimed@example.com');

    site.advance(BETA_HOLD_MS + DAY);
    await site.cron();
    const left = site.db.sqlite.prepare('SELECT email FROM beta_members').all().map((r) => r.email);
    assert.deepEqual(left, ['claimed@example.com']);
    assert.equal((await status(site)).remaining, 2);

    // A year on, checking in as the app does, the claimed spot still unlocks Pro.
    for (let i = 0; i < 4; i++) {
        site.advance(100 * DAY);
        await site.cron();
        const response = await site.call('/api/device/license', { method: 'POST', origin: null, headers: { Authorization: `Bearer ${token}` } });
        assert.equal(payloadOf((await response.json()).license).tier, 'pro');
    }

    // The freed address no longer gets a sign-in code.
    const before = site.sent.emails.length;
    await devicePost(site, '/api/device/code', { email: 'idle@example.com' });
    assert.equal(site.sent.emails.length, before);
});
