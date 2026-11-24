// Paddle's side: the signature check, which events we keep, and what the
// webhook endpoint does with them (including out-of-order and repeated delivery).

import assert from 'node:assert/strict';
import test from 'node:test';

import { EventError, parseEvent, parseSignatureHeader, verifySignature } from '../../worker/src/paddle.js';
import { createSite, customerEvent, signWebhook, subscriptionEvent, WEBHOOK_SECRET } from './harness.mjs';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const nowSeconds = Math.floor(NOW / 1000);
const BODY = '{"event_type":"customer.created"}';

const check = (overrides = {}) => verifySignature({
    rawBody: BODY, header: signWebhook(BODY, { ts: nowSeconds }), secret: WEBHOOK_SECRET, nowMs: NOW, ...overrides,
});

// ── Signature ──────────────────────────────────────────────────────────────

test('a correctly signed request is accepted', async () => {
    assert.equal(await check(), true);
});

test('the wrong secret, a changed body or a changed byte of whitespace is refused', async () => {
    assert.equal(await check({ secret: 'pdl_ntfset_other' }), false);
    assert.equal(await check({ rawBody: `${BODY} ` }), false);
    assert.equal(await check({ rawBody: BODY.replace('customer', 'customer ') }), false);
});

test('a timestamp too far from now is refused, in either direction', async () => {
    assert.equal(await check({ header: signWebhook(BODY, { ts: nowSeconds - 61 }) }), false);
    assert.equal(await check({ header: signWebhook(BODY, { ts: nowSeconds + 61 }) }), false);
    assert.equal(await check({ header: signWebhook(BODY, { ts: nowSeconds - 30 }) }), true);
});

test('while a secret is being rotated, any one valid h1 is enough', async () => {
    const good = signWebhook(BODY, { ts: nowSeconds });
    const stale = signWebhook(BODY, { ts: nowSeconds, secret: 'pdl_ntfset_old' });
    const oldH1 = stale.split('h1=')[1];
    assert.equal(await check({ header: `${good};h1=${oldH1}` }), true);
    assert.equal(await check({ header: `ts=${nowSeconds};h1=${oldH1};h1=${oldH1}` }), false);
});

test('missing, empty and malformed headers are refused', async () => {
    for (const header of [null, undefined, '', 'garbage', 'ts=abc;h1=00', `ts=${nowSeconds}`, `h1=${'0'.repeat(64)}`,
        `ts=${nowSeconds};h1=${'Z'.repeat(64)}`, `ts=${nowSeconds};h1`]) {
        assert.equal(await check({ header }), false, String(header));
    }
    assert.equal(parseSignatureHeader(`ts=${nowSeconds};h1=${'a'.repeat(64)}`).ts, nowSeconds);
});

test('with no secret configured, nothing is accepted', async () => {
    assert.equal(await check({ secret: '' }), false);
    assert.equal(await check({ secret: undefined }), false);
});

// ── Events ─────────────────────────────────────────────────────────────────

test('a customer event keeps the id and a normalised email', () => {
    const e = parseEvent(customerEvent({ customerId: 'ctm_01abc', email: '  Alice@Example.COM ', at: '2026-10-21T12:00:00.000Z' }));
    assert.deepEqual(e, { kind: 'customer', id: 'ctm_01abc', email: 'alice@example.com', occurredAt: Date.parse('2026-10-21T12:00:00.000Z') });
});

test('a subscription event keeps status, owner, price and dates; a cancellation date only when it is a cancellation', () => {
    const at = '2026-10-21T12:00:00.000Z';
    const e = parseEvent(subscriptionEvent({
        subscriptionId: 'sub_01abc', customerId: 'ctm_01abc', status: 'active', at,
        periodEnd: '2026-11-21T12:00:00.000Z', cancelAt: '2026-11-21T12:00:00.000Z',
    }));
    assert.equal(e.kind, 'subscription');
    assert.equal(e.status, 'active');
    assert.equal(e.priceId, 'pri_monthly');
    assert.equal(e.periodEnd, Date.parse('2026-11-21T12:00:00.000Z'));
    assert.equal(e.cancelAt, Date.parse('2026-11-21T12:00:00.000Z'));

    const paused = subscriptionEvent({ subscriptionId: 'sub_01abc', customerId: 'ctm_01abc', at });
    paused.data.scheduled_change = { action: 'pause', effective_at: '2026-11-21T12:00:00.000Z' };
    assert.equal(parseEvent(paused).cancelAt, null);
});

test('events we do not use are skipped, not errors', () => {
    assert.equal(parseEvent({ event_type: 'transaction.completed', occurred_at: '2026-10-21T12:00:00Z', data: { id: 'txn_1' } }), null);
    assert.equal(parseEvent({ event_type: 'product.created', data: {} }), null);
});

test('events we do use but that are malformed are errors', () => {
    const at = '2026-10-21T12:00:00.000Z';
    const sub = () => subscriptionEvent({ subscriptionId: 'sub_01abc', customerId: 'ctm_01abc', at });
    const cases = [
        null, 'text', { event_type: 5, data: {} }, { event_type: 'customer.created' },
        customerEvent({ customerId: 'ctm_01abc', email: 'not-an-email', at }),
        customerEvent({ customerId: "ctm_'; DROP TABLE customers;--", email: 'a@b.co', at }),
        customerEvent({ customerId: 'ctm_01abc', email: 'a@b.co', at: 'yesterday' }),
        { ...sub(), data: { ...sub().data, id: 'cus_1' } },
        { ...sub(), data: { ...sub().data, customer_id: 'x' } },
        { ...sub(), data: { ...sub().data, status: 'Active; DROP' } },
    ];
    for (const c of cases) assert.throws(() => parseEvent(c), EventError, JSON.stringify(c));
});

// ── The endpoint ───────────────────────────────────────────────────────────

test('a customer and their subscription are stored', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await site.subscribe({ email: 'Alice@Example.com', periodEnd: site.iso(30 * 86400000) });

    assert.deepEqual(site.db.sqlite.prepare('SELECT id, email FROM customers').all().map((r) => ({ ...r })), [{ id: 'ctm_01alice', email: 'alice@example.com' }]);
    const sub = site.db.sqlite.prepare('SELECT * FROM subscriptions').get();
    assert.equal(sub.status, 'active');
    assert.equal(sub.customer_id, 'ctm_01alice');
    assert.equal(sub.period_end, site.clock.now + 30 * 86400000);
});

test('the same event delivered twice changes nothing', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const event = subscriptionEvent({ subscriptionId: 'sub_01a', customerId: 'ctm_01a', at: site.iso() });
    assert.equal((await site.webhook(event)).status, 200);
    const before = JSON.stringify(site.db.sqlite.prepare('SELECT * FROM subscriptions').all());
    assert.equal((await site.webhook(event)).status, 200);
    assert.equal(JSON.stringify(site.db.sqlite.prepare('SELECT * FROM subscriptions').all()), before);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 1);
});

test('events arriving out of order never undo a newer one', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const base = { subscriptionId: 'sub_01a', customerId: 'ctm_01a' };
    // The cancellation (11:00) is delivered before the renewal (10:00) that preceded it.
    await site.webhook(subscriptionEvent({ ...base, status: 'canceled', type: 'subscription.canceled', at: '2026-10-21T11:00:00.000Z' }));
    await site.webhook(subscriptionEvent({ ...base, status: 'active', type: 'subscription.updated', at: '2026-10-21T10:00:00.000Z' }));
    assert.equal(site.db.sqlite.prepare('SELECT status FROM subscriptions').get().status, 'canceled');

    await site.webhook(customerEvent({ customerId: 'ctm_01a', email: 'new@example.com', type: 'customer.updated', at: '2026-10-21T11:00:00.000Z' }));
    await site.webhook(customerEvent({ customerId: 'ctm_01a', email: 'old@example.com', at: '2026-10-21T10:00:00.000Z' }));
    assert.equal(site.db.sqlite.prepare('SELECT email FROM customers').get().email, 'new@example.com');
});

test('a request with a bad signature is refused and stores nothing', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const body = JSON.stringify(subscriptionEvent({ subscriptionId: 'sub_01a', customerId: 'ctm_01a', at: site.iso() }));
    const response = await site.call('/api/paddle/webhook', {
        method: 'POST', body, origin: null,
        headers: { 'Paddle-Signature': signWebhook(body, { secret: 'attacker', ts: Math.floor(site.clock.now / 1000) }) },
    });
    assert.equal(response.status, 401);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n, 0);

    const unsigned = await site.call('/api/paddle/webhook', { method: 'POST', body, origin: null });
    assert.equal(unsigned.status, 401);
});

test('a signed but unreadable or malformed body is a 400, so Paddle shows the failure', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const send = (body) => site.call('/api/paddle/webhook', {
        method: 'POST', body, origin: null,
        headers: { 'Paddle-Signature': signWebhook(body, { ts: Math.floor(site.clock.now / 1000) }) },
    });
    assert.equal((await send('not json')).status, 400);
    assert.equal((await send(JSON.stringify({ event_type: 'subscription.created', occurred_at: site.iso(), data: { id: 'bad' } }))).status, 400);
});

test('an event we do not use is acknowledged and ignored', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const response = await site.webhook({ event_id: 'evt_1', event_type: 'transaction.completed', occurred_at: site.iso(), data: { id: 'txn_1' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, true);
});

test('only POST is accepted, and a huge body is refused', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal((await site.call('/api/paddle/webhook')).status, 405);
    const big = 'x'.repeat(600 * 1024);
    const response = await site.call('/api/paddle/webhook', {
        method: 'POST', body: big, origin: null, headers: { 'Paddle-Signature': signWebhook(big) },
    });
    assert.equal(response.status, 413);
});
