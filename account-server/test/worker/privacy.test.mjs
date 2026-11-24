// Seeing and deleting an address's data: the emailed link, the report, the
// deletion and its order of steps, the retries, and keeping the deleted deleted.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSite, customerEvent, ORIGIN, OWNER, PRIVACY_INBOX, SITE, subscriptionEvent } from './harness.mjs';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ALICE = 'alice@example.com';

const setup = (t, options) => {
    const site = createSite(options);
    t.after(site.restore);
    return site;
};

const request = (site, email) => site.call('/api/privacy/request', { method: 'POST', json: { email } });
const report = (site, token) => site.call('/api/privacy/report', { method: 'POST', json: { token } });
const erase = (site, token, { confirm = 'DELETE' } = {}) =>
    site.call('/api/privacy/erase', { method: 'POST', json: { token, confirm } });

/** Ask for a link and return its token. */
async function tokenFor(site, email) {
    await request(site, email);
    return /auth\/privacy#t=([A-Za-z0-9_-]{43})/.exec(site.sent.emails.at(-1).text)[1];
}

/** A subscriber with Aventurine Manage signed in on one computer. Returns its device token. */
async function signedInSubscriber(site, email = ALICE, ids = {}) {
    await site.subscribe({ email, ...ids });
    return site.signInDevice(email);
}

const count = (site, table) => site.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const mailTo = (site, address) => site.sent.emails.filter((m) => m.to[0] === address);

/** Every value in every table, as one string, to search for what should be gone. */
function wholeDatabase(site) {
    const tables = site.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    return JSON.stringify(tables.map(({ name }) => site.db.sqlite.prepare(`SELECT * FROM ${name}`).all()));
}

// ── The link ────────────────────────────────────────────────────────────────

test('a customer and a stranger get the same answer, and both are emailed', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE });
    const known = await request(site, ALICE);
    const stranger = await request(site, 'nobody@example.com');
    assert.equal(known.status, 202);
    assert.equal(known.status, stranger.status);
    assert.deepEqual(await known.json(), await stranger.json());
    assert.equal(mailTo(site, ALICE).length, 1);
    assert.equal(mailTo(site, 'nobody@example.com').length, 1);
});

test('the link is on our origin with the token after the #, and only its hash is stored', async (t) => {
    const site = setup(t);
    const token = await tokenFor(site, ALICE);
    assert.ok(site.sent.emails[0].text.includes(`${ORIGIN}/auth/privacy#t=${token}`));
    assert.ok(!wholeDatabase(site).includes(token));
});

test('an address is emailed at most three links a day, with no sign of being stopped', async (t) => {
    const site = setup(t);
    for (let i = 0; i < 3; i++) assert.equal((await request(site, ALICE)).status, 202);
    assert.equal((await request(site, ALICE)).status, 202);
    assert.equal(mailTo(site, ALICE).length, 3);

    site.advance(DAY + MINUTE);
    await request(site, ALICE);
    assert.equal(mailTo(site, ALICE).length, 4);
});

test('requests from another site, bad addresses and floods are refused', async (t) => {
    const site = setup(t);
    const foreign = await site.call('/api/privacy/request', { method: 'POST', origin: 'https://evil.example', json: { email: ALICE } });
    assert.equal(foreign.status, 403);
    assert.equal((await request(site, 'not-an-email')).status, 400);
    site.limit('privacy:unknown');
    assert.equal((await request(site, ALICE)).status, 429);
    assert.equal(site.sent.emails.length, 0);
});

test('only POST is answered', async (t) => {
    const site = setup(t);
    assert.equal((await site.call('/api/privacy/report')).status, 405);
    assert.equal((await site.call('/api/privacy/nope', { method: 'POST', json: {} })).status, 404);
});

test('the privacy page is public', async (t) => {
    const site = setup(t);
    const page = await site.call('/auth/privacy');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /your data/);
});

test('a privacy link cannot sign Aventurine Manage in', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE });
    const token = await tokenFor(site, ALICE);
    assert.equal(await site.deviceLicense(token), 401);
});

// ── The report ──────────────────────────────────────────────────────────────

test('the report lists what is held, and never the key or the ciphertext', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    const r = await report(site, await tokenFor(site, ALICE));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.email, ALICE);
    assert.equal(body.holdsData, true);
    assert.deepEqual(body.customers.map((c) => c.id), ['ctm_01alice']);
    assert.deepEqual(body.subscriptions.map((s) => [s.id, s.status]), [['sub_01alice', 'active']]);
    assert.equal(body.devices.length, 1);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('wrapped.key'));
    assert.ok(!text.includes('cipher.text'));
});

test('a stranger is told nothing is held, and a complimentary address that something is', async (t) => {
    const site = setup(t);
    const nobody = await (await report(site, await tokenFor(site, 'nobody@example.com'))).json();
    assert.equal(nobody.holdsData, false);
    const owner = await (await report(site, await tokenFor(site, OWNER))).json();
    assert.equal(owner.holdsData, true);
    assert.equal(owner.complimentary, true);
});

test('a link shows only its own address, and stops working after 30 minutes', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    const token = await tokenFor(site, 'nobody@example.com');
    const body = await (await report(site, token)).json();
    assert.equal(body.email, 'nobody@example.com');
    assert.deepEqual(body.customers, []);

    site.advance(31 * MINUTE);
    assert.equal((await report(site, token)).status, 400);
    assert.equal((await report(site, 'x'.repeat(43))).status, 400);
    assert.equal((await report(site, undefined)).status, 400);
});

test('a report is logged without saying whose it was', async (t) => {
    const site = setup(t);
    await report(site, await tokenFor(site, ALICE));
    const rows = site.db.sqlite.prepare('SELECT * FROM privacy_requests').all();
    assert.deepEqual(rows.map((r) => r.kind), ['access']);
    assert.ok(!JSON.stringify(rows).includes(ALICE));
});

// ── Deleting ────────────────────────────────────────────────────────────────

test('nothing is deleted without the confirmation word', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    const token = await tokenFor(site, ALICE);
    for (const confirm of ['delete', '', 'YES']) {
        assert.equal((await erase(site, token, { confirm })).status, 400);
    }
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(site.sent.paddle.length, 0);
});

test('a deletion leaves no trace of the address, and spares everyone else', async (t) => {
    const site = setup(t);
    const device = await signedInSubscriber(site);
    await signedInSubscriber(site, 'bob@example.com', { customerId: 'ctm_01bob', subscriptionId: 'sub_01bob' });

    const response = await erase(site, await tokenFor(site, ALICE));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'done');

    const everything = wholeDatabase(site);
    for (const gone of [ALICE, 'ctm_01alice', 'sub_01alice']) assert.ok(!everything.includes(gone), `${gone} survived`);
    assert.equal(count(site, 'erasure_queue'), 0);
    assert.ok(everything.includes('bob@example.com'));
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(count(site, 'subscriptions'), 1);

    assert.equal(await site.deviceLicense(device), 401, 'Aventurine Manage is signed out');
});

test('a deletion cancels a renewing subscription at once, before anything is deleted', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    await erase(site, await tokenFor(site, ALICE));
    assert.deepEqual(site.sent.paddle.map((c) => [c.method, c.path, c.body]), [
        ['POST', '/subscriptions/sub_01alice/cancel', { effective_from: 'immediately' }],
    ]);
    assert.equal(site.sent.paddle[0].headers.Authorization, 'Bearer pdl_test_key');
});

test('a subscription already ending or ended is left alone', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE, cancelAt: site.iso(10 * DAY) });
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01old', customerId: 'ctm_01alice', status: 'canceled', at: site.iso() }));
    assert.equal((await erase(site, await tokenFor(site, ALICE))).status, 200);
    assert.equal(site.sent.paddle.length, 0);
    assert.equal(count(site, 'subscriptions'), 0);
});

test('the owner gets the checklist and the person a receipt', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    await erase(site, await tokenFor(site, ALICE));

    const [checklist, ...others] = mailTo(site, PRIVACY_INBOX);
    assert.equal(others.length, 0);
    assert.ok(checklist.text.includes(ALICE));
    assert.match(checklist.text, /Support inbox/);
    assert.match(checklist.text, /1 subscription\(s\) cancelled/);
    assert.doesNotMatch(checklist.text, /COMPLIMENTARY_EMAILS/);

    const receipt = mailTo(site, ALICE).at(-1);
    assert.match(receipt.subject, /has been deleted/);
    assert.match(receipt.text, /preferences\.paddle\.com/);
});

test('someone we have no account for still reaches the owner, who holds the support inbox', async (t) => {
    const site = setup(t);
    const response = await erase(site, await tokenFor(site, 'nobody@example.com'));
    assert.equal(response.status, 200);
    assert.ok(mailTo(site, PRIVACY_INBOX)[0].text.includes('nobody@example.com'));
});

test('a complimentary address is flagged, since only the owner can edit that list', async (t) => {
    const site = setup(t);
    await erase(site, await tokenFor(site, OWNER));
    assert.match(mailTo(site, PRIVACY_INBOX)[0].text, /COMPLIMENTARY_EMAILS/);
});

test('a deletion is logged without saying whose it was, and the link is spent', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE });
    const token = await tokenFor(site, ALICE);
    await erase(site, token);
    const rows = site.db.sqlite.prepare("SELECT * FROM privacy_requests WHERE kind = 'delete'").all();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].completed_at >= rows[0].received_at);
    assert.ok(!JSON.stringify(rows).includes(ALICE));
    assert.equal((await erase(site, token)).status, 400);
});

// ── When a step fails ───────────────────────────────────────────────────────

test('if Paddle refuses, nothing is deleted, the owner is told, and the daily job finishes it', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    site.behavior.paddleCancelStatus = 500;
    const token = await tokenFor(site, ALICE);

    const response = await erase(site, token);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'pending');
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(count(site, 'customers'), 1);
    assert.equal(count(site, 'erasure_queue'), 1);
    assert.match(mailTo(site, PRIVACY_INBOX)[0].text, /NOT FINISHED.*sub_01alice/);
    assert.equal((await (await report(site, token)).json()).erasurePending, true);

    await site.cron();
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(mailTo(site, PRIVACY_INBOX).length, 2, 'the owner is reminded each day');

    site.behavior.paddleCancelStatus = 200;
    await site.cron();
    assert.equal(count(site, 'device_tokens'), 0);
    assert.equal(count(site, 'customers'), 0);
    assert.equal(count(site, 'erasure_queue'), 0);
    assert.match(mailTo(site, ALICE).at(-1).subject, /has been deleted/);
});

test('a retried confirmation keeps the original request date and one queue row', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    site.behavior.paddleCancelStatus = 500;
    const token = await tokenFor(site, ALICE);
    await erase(site, token);
    const first = site.db.sqlite.prepare('SELECT requested_at FROM erasure_queue').get().requested_at;
    site.advance(MINUTE);
    await erase(site, token);
    assert.equal(count(site, 'erasure_queue'), 1);
    assert.equal(site.db.sqlite.prepare('SELECT requested_at FROM erasure_queue').get().requested_at, first);
});

test('a subscription Paddle already cancelled does not hold a deletion up', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    site.behavior.paddleCancelStatus = 400;
    site.behavior.paddleSubscriptionStatus = 'canceled';
    assert.equal((await erase(site, await tokenFor(site, ALICE))).status, 200);
    assert.equal(count(site, 'device_tokens'), 0);
});

test('with no API key the deletion waits, and a cancellation by hand lets it finish', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    delete site.env.PADDLE_API_KEY;
    assert.equal((await erase(site, await tokenFor(site, ALICE))).status, 202);
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(site.sent.paddle.length, 0);

    site.advance(MINUTE);
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso(),
    }));
    await site.cron();
    assert.equal(count(site, 'device_tokens'), 0);
    assert.equal(count(site, 'erasure_queue'), 0);
});

test('if the checklist cannot be sent nothing is deleted, because the address would be lost', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    const token = await tokenFor(site, ALICE);
    site.behavior.resendStatus = 500;
    assert.equal((await erase(site, token)).status, 202);
    assert.equal(count(site, 'device_tokens'), 1);
    assert.equal(count(site, 'erasure_queue'), 1);

    site.behavior.resendStatus = 200;
    await site.cron();
    assert.equal(count(site, 'device_tokens'), 0);
    assert.equal(mailTo(site, PRIVACY_INBOX).length, 2, 'the refused attempt, then the one that went through');
});

test('a lost receipt does not undo or repeat the deletion', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    const token = await tokenFor(site, ALICE);
    site.behavior.refusedAddress = ALICE;
    assert.equal((await erase(site, token)).status, 200);
    assert.equal(count(site, 'device_tokens'), 0);
    assert.equal(count(site, 'erasure_queue'), 0);
});

// ── Staying deleted ─────────────────────────────────────────────────────────

test('Paddle\'s late events do not write a deleted customer back', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    await erase(site, await tokenFor(site, ALICE));
    site.advance(MINUTE);

    const events = [
        subscriptionEvent({ subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso() }),
        customerEvent({ customerId: 'ctm_01alice', email: ALICE, type: 'customer.updated', at: site.iso() }),
        // An event from before the deletion, retried after it.
        subscriptionEvent({ subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'active', type: 'subscription.updated', at: site.iso(-10 * MINUTE) }),
    ];
    for (const event of events) {
        const response = await site.webhook(event);
        assert.equal(response.status, 200, 'answered 200, or Paddle would keep retrying');
        assert.equal((await response.json()).ignored, true);
    }
    assert.equal(count(site, 'customers'), 0);
    assert.equal(count(site, 'subscriptions'), 0);
});

test('a subscription already set to end does not count as coming back', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE, cancelAt: site.iso(10 * DAY) });
    await erase(site, await tokenFor(site, ALICE));
    site.advance(DAY);
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'active', type: 'subscription.updated',
        at: site.iso(), cancelAt: site.iso(9 * DAY),
    }));
    assert.equal(count(site, 'subscriptions'), 0);
});

test('someone who subscribes again after deleting can sign in', async (t) => {
    const site = setup(t);
    await signedInSubscriber(site);
    await erase(site, await tokenFor(site, ALICE));
    site.advance(DAY);

    // Paddle reuses the customer and sends only the subscription event.
    site.behavior.paddleCustomerEmail = ALICE;
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_02alice', customerId: 'ctm_01alice', at: site.iso() }));

    assert.equal(count(site, 'customers'), 1);
    assert.equal(count(site, 'erased_customers'), 0);
    const device = await site.signInDevice(ALICE);
    assert.equal((await site.deviceLicense(device)).active, true);
});

test('coming back after the hold has expired works the same way', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE });
    await erase(site, await tokenFor(site, ALICE));
    site.advance(31 * DAY);
    await site.cron();
    assert.equal(count(site, 'erased_customers'), 0);

    site.behavior.paddleCustomerEmail = ALICE;
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_02alice', customerId: 'ctm_01alice', at: site.iso() }));
    assert.equal(count(site, 'customers'), 1);
});

test('a failed customer lookup still stores the subscription', async (t) => {
    const site = setup(t);
    site.behavior.paddleCustomerEmail = 'not-an-email';
    const response = await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01x', customerId: 'ctm_01x', at: site.iso() }));
    assert.equal(response.status, 200);
    assert.equal(count(site, 'subscriptions'), 1);
    assert.equal(count(site, 'customers'), 0);
});

test('a subscription that arrives before its customer event is matched by the lookup', async (t) => {
    const site = setup(t);
    site.behavior.paddleCustomerEmail = ALICE;
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01x', customerId: 'ctm_01x', at: site.iso() }));
    assert.equal(site.sent.paddle.at(-1).path, '/customers/ctm_01x');
    assert.equal(count(site, 'customers'), 1);
});

// ── Keeping tables small ────────────────────────────────────────────────────

test('the daily job drops links after a day, holds after 30 days, and the log after 24 months', async (t) => {
    const site = setup(t);
    await site.subscribe({ email: ALICE });
    await tokenFor(site, 'nobody@example.com');
    await erase(site, await tokenFor(site, ALICE));
    assert.equal(count(site, 'privacy_links'), 1);
    assert.equal(count(site, 'erased_customers'), 1);

    site.advance(DAY + MINUTE);
    await site.cron();
    assert.equal(count(site, 'privacy_links'), 0);
    assert.equal(count(site, 'erased_customers'), 1);

    site.advance(30 * DAY);
    await site.cron();
    assert.equal(count(site, 'erased_customers'), 0);
    assert.equal(count(site, 'privacy_requests'), 1);

    site.advance(700 * DAY);
    await site.cron();
    assert.equal(count(site, 'privacy_requests'), 1, 'kept past 24 months');

    site.advance(30 * DAY);
    await site.cron();
    assert.equal(count(site, 'privacy_requests'), 0);
});
