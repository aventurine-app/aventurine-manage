// ─── privacy.js ─────────────────────────────────────────────────────────────
// Lets anyone see what we hold about their email address, take a copy, and have
// it deleted (GDPR articles 15, 17 and 20; the CCPA's rights to know and delete).
// The page is /auth/privacy; PRIVACY.md is what the owner does by hand.
//
//   POST /api/privacy/request   { email }           emails a link; same answer for everyone
//   POST /api/privacy/report    { token }           what we hold for that link's address
//   POST /api/privacy/erase     { token, confirm }  deletes it
//
// Choices that matter:
//   • There is no account to sign in to here, because a lapsed subscriber or
//     someone who only ever emailed support has the same rights. Proof is
//     opening a link sent to the address. So strangers are emailed too, unlike
//     sign-in, and the limits below are what stops the form being used to spam.
//   • The link's token sits after a #, and nothing happens until someone presses
//     a button, so a mail scanner cannot read a report or delete anything. It
//     can be used more than once until it expires, so the same link can show
//     the report and then delete. It grants nothing else, and never app access.
//   • Billing comes first. A subscription still running when its record is
//     deleted would keep charging someone we can no longer identify, so if it
//     cannot be cancelled, nothing is deleted yet.
//   • The owner's checklist is sent before the address is deleted. After that,
//     nothing would be left to say whose support emails to remove.
//   • Both of those can fail, so a deletion is queued first and the daily job
//     retries it until it finishes. Running it twice is harmless.

import { randomToken, sha256Hex, TOKEN_SHAPE } from './crypto.js';
import { erasureOpsMessage, erasureReceiptMessage, privacyLinkMessage } from './email.js';
import { normalizeEmail } from './email-address.js';
import { HttpError, json, readJsonBody, requireSameOrigin } from './http.js';
import {
    countPrivacyLinks, createPrivacyLink, emailForPrivacyLink, eraseAccount, erasureQueue, logPrivacyRequest,
    markErasureNotified, privacyRecords, queueErasure,
} from './store.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const PRIVACY_LINK_TTL_MS = 30 * MINUTE;
export const MAX_PRIVACY_LINKS_PER_DAY = 3;
// GDPR allows one month and the CCPA 45 days. This is the shorter of the two.
const MANUAL_STEPS_DUE_MS = 30 * DAY;
const CONFIRM_WORD = 'DELETE';

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export const isPrivacyPath = (path) => path.startsWith('/api/privacy/');

// ── Proving an address ──────────────────────────────────────────────────────

async function requestLink(deps, rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new HttpError(400, 'invalid_email');

    const now = deps.now();
    // Past the limit there is no email and no error, as with sign-in links.
    if (await countPrivacyLinks(deps.db, { email, since: now - DAY }) >= MAX_PRIVACY_LINKS_PER_DAY) return;

    const token = randomToken();
    await createPrivacyLink(deps.db, { tokenHash: await sha256Hex(token), email, now, ttlMs: PRIVACY_LINK_TTL_MS });
    const link = `${deps.config.appOrigin}/auth/privacy#t=${token}`;
    deps.defer(
        deps.mail({ to: email, message: privacyLinkMessage(link, PRIVACY_LINK_TTL_MS / MINUTE) })
            .catch((e) => console.error('[privacy] link email failed:', e.message)),
    );
}

/** The address a token proves, or an HttpError. */
async function provenEmail(deps, token) {
    const email = typeof token === 'string' && TOKEN_SHAPE.test(token)
        ? await emailForPrivacyLink(deps.db, { tokenHash: await sha256Hex(token), now: deps.now() })
        : null;
    if (!email) throw new HttpError(400, 'invalid_or_expired');
    return email;
}

// ── Seeing what we hold ─────────────────────────────────────────────────────

/**
 * Everything the database holds for `email`, in a form a person can read.
 * Plans are never here: Aventurine keeps them on the user's own computer.
 */
async function report(deps, email) {
    const now = deps.now();
    const held = await privacyRecords(deps.db, { email, now });
    const complimentary = deps.config.complimentary.has(email);
    await logPrivacyRequest(deps.db, { kind: 'access', receivedAt: now, completedAt: now });
    return json({
        ok: true,
        email,
        generatedAt: iso(now),
        holdsData: Boolean(complimentary || held.beta || held.customers.length || held.devices.length),
        complimentary,
        erasurePending: held.erasurePending,
        customers: held.customers.map((c) => ({ id: c.id, updatedAt: iso(c.updated_at) })),
        subscriptions: held.subscriptions.map((s) => ({
            id: s.id,
            status: s.status,
            priceId: s.price_id,
            periodEnd: iso(s.period_end),
            cancelsAt: iso(s.cancel_at),
            updatedAt: iso(s.updated_at),
        })),
        devices: held.devices.map((d) => ({ createdAt: iso(d.created_at), lastUsedAt: iso(d.last_seen_at) })),
        beta: held.beta ? { joinedAt: iso(held.beta.joined_at), claimedAt: iso(held.beta.claimed_at) } : null,
    });
}

// ── Deleting it ─────────────────────────────────────────────────────────────

/** Is this subscription going to charge again unless we stop it? */
const willRenew = (s) => s.status !== 'canceled' && s.cancel_at == null;

/**
 * Take one queued deletion as far as it will go. Resolves true if it finished,
 * false if it stays queued for the daily job. `queued` is a row of erasure_queue.
 */
export async function runErasure(deps, queued) {
    const { db, config, now, mail, paddle } = deps;
    const { email, requested_at: requestedAt, notified_at: notifiedAt } = queued;
    const { customers, subscriptions } = await privacyRecords(db, { email, now: now() });

    const renewing = subscriptions.filter(willRenew);
    const stuck = [];
    for (const { id } of renewing) {
        try {
            await paddle.cancelSubscription(id);
        } catch (e) {
            console.error(`[privacy] could not cancel a subscription: ${e.message}`);
            stuck.push(id);
        }
    }

    // A stuck cancellation repeats the email each day, because it needs a person.
    if (notifiedAt == null || stuck.length) {
        const message = erasureOpsMessage({
            email,
            requestedAt,
            dueBy: requestedAt + MANUAL_STEPS_DUE_MS,
            cancelled: renewing.length - stuck.length,
            stuck,
            complimentary: config.complimentary.has(email),
        });
        try {
            await mail({ to: config.privacyEmail, message });
            await markErasureNotified(db, { email, at: now() });
        } catch (e) {
            console.error(`[privacy] the erasure checklist could not be sent; will retry: ${e.message}`);
            return false;
        }
    }
    if (stuck.length) return false;

    const customerHashes = await Promise.all(customers.map((c) => sha256Hex(c.id)));
    await eraseAccount(db, { email, customerHashes, requestedAt, now: now() });

    // The address is gone now, so a failure here cannot be retried. The person
    // saw the result on the page unless this ran from the daily job.
    await mail({ to: email, message: erasureReceiptMessage() })
        .catch((e) => console.error(`[privacy] the erasure receipt could not be sent: ${e.message}`));
    return true;
}

async function erase(deps, email, body) {
    if (body.confirm !== CONFIRM_WORD) throw new HttpError(400, 'not_confirmed');
    const queued = await queueErasure(deps.db, { email, now: deps.now() });
    if (!(await runErasure(deps, queued))) return json({ ok: true, status: 'pending' }, 202);
    return json({ ok: true, status: 'done' });
}

/** The daily job: finish whatever a failed step left queued. Returns how many finished. */
export async function processErasureQueue(deps) {
    let finished = 0;
    for (const queued of await erasureQueue(deps.db)) {
        try {
            if (await runErasure(deps, queued)) finished++;
        } catch (e) {
            console.error(`[privacy] a queued erasure failed; will retry: ${e.message}`);
        }
    }
    return finished;
}

// ── Routing ─────────────────────────────────────────────────────────────────

/** Handle a request under /api/privacy/. `deps` is the worker's { db, config, now, … }. */
export async function handlePrivacy(request, deps, path, ip) {
    const action = { '/api/privacy/request': 'request', '/api/privacy/report': 'report', '/api/privacy/erase': 'erase' }[path];
    if (!action) return json({ ok: false, error: 'not_found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    requireSameOrigin(request, deps.config.appOrigin);
    if (!(await deps.rateLimit(`privacy:${ip}`))) throw new HttpError(429, 'rate_limited');

    const body = await readJsonBody(request);
    if (action === 'request') {
        await requestLink(deps, body.email);
        return json({ ok: true }, 202);
    }
    const email = await provenEmail(deps, body.token);
    return action === 'report' ? report(deps, email) : erase(deps, email, body);
}
