// ─── paddle.js ──────────────────────────────────────────────────────────────
// Everything that hears from Paddle.
//
// Webhooks: Paddle POSTs events as customers sign up and pay. We check each one
// really came from Paddle (a signature over the exact bytes received), then
// copy the parts we need into the database. Two events matter:
//
//   customer.created / customer.updated   the customer's id and email
//   subscription.*                        the subscription's id, owner, status and dates
//
// A subscription event carries only a customer id, never an email, so the two
// are joined later by customer id. Paddle may deliver events out of order or
// more than once; store.js applies each only if it is newer than what it holds.
//
// Someone who has had their data deleted (privacy.js) must stay deleted, so
// Paddle's later events about them are dropped, including the cancellation the
// deletion itself caused. Paying again is the exception. Paddle keeps the same
// customer and may send no customer event, so the email is fetched from its API.
//
// The API is only used for those two things: cancelling a subscription and
// looking up a customer's email. It needs PADDLE_API_KEY.

import { ACCESS_STATUSES } from './access.js';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto.js';
import { normalizeEmail } from './email-address.js';
import { erasedAt, forgetErased, hasCustomerId, upsertCustomer, upsertSubscription } from './store.js';
import { json } from './http.js';

const MAX_BODY_BYTES = 512 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 60;

// ── Signature ───────────────────────────────────────────────────────────────

/** Read `ts=…;h1=…` (h1 may repeat while Paddle rotates a secret). Null if malformed. */
export function parseSignatureHeader(header) {
    if (typeof header !== 'string') return null;
    let ts = null;
    const signatures = [];
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) return null;
        const key = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (key === 'ts' && /^\d{1,12}$/.test(value)) ts = Number(value);
        else if (key === 'h1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
    }
    return ts === null || !signatures.length ? null : { ts, signatures };
}

/**
 * Did Paddle send this? The signature is an HMAC-SHA-256 of `ts:` + the raw
 * body, so the body must be checked exactly as received, before any parsing.
 * A timestamp far from now is refused, so a captured request cannot be replayed.
 */
export async function verifySignature({ rawBody, header, secret, nowMs }) {
    const parsed = parseSignatureHeader(header);
    if (!parsed || !secret) return false;
    if (Math.abs(nowMs / 1000 - parsed.ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
    const expected = await hmacSha256Hex(secret, `${parsed.ts}:${rawBody}`);
    // Compare against every h1, without stopping early at a match.
    let ok = false;
    for (const candidate of parsed.signatures) ok = timingSafeEqual(expected, candidate) || ok;
    return ok;
}

// ── Events ──────────────────────────────────────────────────────────────────

export class EventError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dateMs = (v) => {
    const ms = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isNaN(ms) ? null : ms;
};

/**
 * What to store for an event, or null if it is one we do not use. Throws
 * EventError if it is one we use but it is malformed, so Paddle's dashboard
 * shows the failure instead of us silently storing nonsense.
 */
export function parseEvent(event) {
    if (!isObject(event) || typeof event.event_type !== 'string' || !isObject(event.data)) {
        throw new EventError('not a Paddle event');
    }
    const type = event.event_type;
    const isCustomer = type === 'customer.created' || type === 'customer.updated';
    if (!isCustomer && !type.startsWith('subscription.')) return null;

    const occurredAt = dateMs(event.occurred_at);
    if (occurredAt === null) throw new EventError('missing occurred_at');
    const data = event.data;

    if (isCustomer) {
        const email = normalizeEmail(data.email);
        if (!/^ctm_[a-z0-9]+$/.test(data.id) || !email) throw new EventError('bad customer');
        return { kind: 'customer', id: data.id, email, occurredAt };
    }

    if (!/^sub_[a-z0-9]+$/.test(data.id) || !/^ctm_[a-z0-9]+$/.test(data.customer_id)
        || typeof data.status !== 'string' || !/^[a-z_]{1,24}$/.test(data.status)) {
        throw new EventError('bad subscription');
    }
    const priceId = data.items?.[0]?.price?.id;
    const change = data.scheduled_change;
    return {
        kind: 'subscription',
        id: data.id,
        customerId: data.customer_id,
        status: data.status,
        priceId: typeof priceId === 'string' ? priceId.slice(0, 64) : null,
        periodEnd: dateMs(data.current_billing_period?.ends_at),
        cancelAt: isObject(change) && change.action === 'cancel' ? dateMs(change.effective_at) : null,
        occurredAt,
    };
}

// ── API ─────────────────────────────────────────────────────────────────────

export class PaddleApiError extends Error {}

/** Paddle's API. `enabled` is false until PADDLE_API_KEY is set, and calls then throw. */
export function paddleApi({ apiKey, baseUrl, fetchImpl = fetch }) {
    const enabled = Boolean(apiKey && baseUrl);

    async function call(method, path, body) {
        if (!enabled) throw new PaddleApiError('PADDLE_API_KEY is not set');
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(8000),
        });
        return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
    }

    return {
        enabled,

        /** Stop a subscription now. Throws unless it ends up cancelled. */
        async cancelSubscription(id) {
            const cancel = await call('POST', `/subscriptions/${id}/cancel`, { effective_from: 'immediately' });
            if (cancel.ok) return;
            // Our copy can lag behind Paddle, and cancelling twice is an error.
            const current = await call('GET', `/subscriptions/${id}`);
            if (current.body?.data?.status === 'canceled') return;
            throw new PaddleApiError(`Paddle answered ${cancel.status} when cancelling ${id}`);
        },

        /** The email Paddle holds for a customer, or null. */
        async customerEmail(id) {
            const customer = await call('GET', `/customers/${id}`);
            if (!customer.ok) throw new PaddleApiError(`Paddle answered ${customer.status} for ${id}`);
            return normalizeEmail(customer.body?.data?.email);
        },
    };
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/** Does this event show someone who was erased paying for access again? */
const isReturning = (change, erased) => change.kind === 'subscription'
    && ACCESS_STATUSES.has(change.status)
    && change.cancelAt == null
    && change.occurredAt > erased;

/** A paying subscription with no customer row cannot sign in. Fetch the customer. */
async function restoreCustomer({ db, paddle, change, logger }) {
    if (!paddle.enabled || await hasCustomerId(db, change.customerId)) return;
    try {
        const email = await paddle.customerEmail(change.customerId);
        if (email) await upsertCustomer(db, { id: change.customerId, email, occurredAt: change.occurredAt });
    } catch (e) {
        // Paddle's own customer event may still arrive, so the subscription stands.
        logger.error(`[paddle] could not look up a customer: ${e.message}`);
    }
}

/** The webhook endpoint. Answers 200 only once the event is safely stored. */
export async function handleWebhook({ request, db, secret, nowMs, paddle, logger = console }) {
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);

    const header = request.headers.get('Paddle-Signature');
    if (!(await verifySignature({ rawBody, header, secret, nowMs }))) {
        logger.warn('[paddle] webhook refused: bad signature');
        return json({ ok: false, error: 'invalid_signature' }, 401);
    }

    let change;
    try {
        change = parseEvent(JSON.parse(rawBody));
    } catch (e) {
        logger.warn(`[paddle] webhook refused: ${e instanceof EventError ? e.message : 'unreadable body'}`);
        return json({ ok: false, error: 'bad_event' }, 400);
    }
    if (!change) return json({ ok: true, ignored: true });

    const customerHash = await sha256Hex(change.kind === 'customer' ? change.id : change.customerId);
    const erased = await erasedAt(db, customerHash);
    if (erased !== null) {
        if (!isReturning(change, erased)) return json({ ok: true, ignored: true });
        await forgetErased(db, customerHash);
    }

    if (change.kind === 'customer') {
        await upsertCustomer(db, change);
    } else {
        await upsertSubscription(db, change);
        if (ACCESS_STATUSES.has(change.status)) await restoreCustomer({ db, paddle, change, logger });
    }
    return json({ ok: true });
}
