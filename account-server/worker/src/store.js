// ─── store.js ───────────────────────────────────────────────────────────────
// Every database statement the worker runs. All values are bound parameters;
// nothing is built from input by string concatenation. `db` is a D1 database
// (or anything with the same prepare/bind/first/all/run shape, which is how the
// tests run it on SQLite).

// ── Billing state, from Paddle webhooks ─────────────────────────────────────
// Paddle does not promise to deliver events in order, so each write carries the
// event's occurred_at and only takes effect if it is newer than what is stored.
// That also makes a repeated delivery a no-op.

/** Store a customer's email. */
export async function upsertCustomer(db, { id, email, occurredAt }) {
    await db.prepare(
        `INSERT INTO customers (id, email, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
         WHERE excluded.updated_at > customers.updated_at`,
    ).bind(id, email, occurredAt).run();
}

export async function upsertSubscription(db, s) {
    await db.prepare(
        `INSERT INTO subscriptions (id, customer_id, status, price_id, period_end, cancel_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
             customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
             period_end = excluded.period_end, cancel_at = excluded.cancel_at, updated_at = excluded.updated_at
         WHERE excluded.updated_at > subscriptions.updated_at`,
    ).bind(s.id, s.customerId, s.status, s.priceId, s.periodEnd, s.cancelAt, s.occurredAt).run();
}

/** The subscriptions of the customer with this email; none for a stranger. */
export async function subscriptionsFor(db, email) {
    const { results } = await db.prepare(
        `SELECT s.status, s.price_id FROM customers c JOIN subscriptions s ON s.customer_id = c.id WHERE c.email = ?`,
    ).bind(email).all();
    return results;
}

// ── Desktop sign-in (devices.js) ────────────────────────────────────────────

export async function createDeviceCode(db, { email, codeHash, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO device_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(email, codeHash, now, now + ttlMs).run();
}

/** How many codes were sent to this email since `since`. */
export async function countDeviceCodes(db, { email, since }) {
    const row = await db.prepare(
        'SELECT COUNT(*) AS n FROM device_codes WHERE email = ? AND created_at > ?',
    ).bind(email, since).first();
    return row.n;
}

/**
 * Count one guess against the newest live code for `email`. Counting happens
 * before the comparison, in one statement, so parallel guesses cannot get past
 * the limit. Returns { id, code_hash } of the code to compare against, or null
 * when there is none left to guess.
 */
export async function claimDeviceCodeAttempt(db, { email, now, maxAttempts }) {
    return db.prepare(
        `UPDATE device_codes SET attempts = attempts + 1
         WHERE id = (SELECT id FROM device_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1)
           AND used_at IS NULL AND attempts < ?
         RETURNING id, code_hash`,
    ).bind(email, now, maxAttempts).first();
}

/** Spend a code. Returns false if another request spent it first. */
export async function useDeviceCode(db, { id, now }) {
    const { meta } = await db.prepare('UPDATE device_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .bind(now, id).run();
    return meta.changes === 1;
}

export async function createDeviceToken(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO device_tokens (token_hash, email, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now, now + ttlMs).run();
}

/**
 * The live device for a token, with that email's subscriptions, and push its
 * expiry forward. Returns { email, subscriptions } or null.
 */
export async function touchDevice(db, { tokenHash, now, ttlMs }) {
    const device = await db.prepare(
        `UPDATE device_tokens SET last_seen_at = ?, expires_at = ?
         WHERE token_hash = ? AND expires_at > ?
         RETURNING email`,
    ).bind(now, now + ttlMs, tokenHash, now).first();
    if (!device) return null;
    return { email: device.email, subscriptions: await subscriptionDetailsFor(db, device.email) };
}

/** Like subscriptionsFor, with the dates the desktop app shows. */
async function subscriptionDetailsFor(db, email) {
    const { results } = await db.prepare(
        `SELECT s.status, s.price_id, s.period_end, s.cancel_at, s.updated_at
         FROM customers c JOIN subscriptions s ON s.customer_id = c.id WHERE c.email = ?`,
    ).bind(email).all();
    return results;
}

export async function deleteDeviceToken(db, tokenHash) {
    await db.prepare('DELETE FROM device_tokens WHERE token_hash = ?').bind(tokenHash).run();
}

// ── Beta signup (beta.js) ───────────────────────────────────────────────────

// How long a reserved beta spot waits for its first Manage sign-in before the
// daily job gives it to someone else.
export const BETA_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

/** How many beta spots are taken (reserved or claimed). */
export async function countBetaMembers(db) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM beta_members').first();
    return row.n;
}

/**
 * Reserve a spot for `email` if one is left. The count and the insert are one
 * statement, so two people cannot take the last spot at once. Returns
 * 'joined' (a new spot), 'member' (already had one) or 'full'.
 */
export async function joinBeta(db, { email, now, limit }) {
    const { meta } = await db.prepare(
        `INSERT INTO beta_members (email, joined_at)
         SELECT ?, ? WHERE (SELECT COUNT(*) FROM beta_members) < ?
         ON CONFLICT (email) DO NOTHING`,
    ).bind(email, now, limit).run();
    if (meta.changes === 1) return 'joined';
    return (await isBetaMember(db, email)) ? 'member' : 'full';
}

/** Does this address hold a beta spot (reserved or claimed)? */
export async function isBetaMember(db, email) {
    return (await db.prepare('SELECT 1 FROM beta_members WHERE email = ?').bind(email).first()) != null;
}

/** Mark the spot claimed on its first sign-in, so the daily job keeps it. */
export async function claimBetaSpot(db, { email, now }) {
    await db.prepare('UPDATE beta_members SET claimed_at = ? WHERE email = ? AND claimed_at IS NULL').bind(now, email).run();
}

// ── Privacy requests (privacy.js) ───────────────────────────────────────────

export async function createPrivacyLink(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO privacy_links (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now + ttlMs).run();
}

/** How many links were sent to this email since `since`. */
export async function countPrivacyLinks(db, { email, since }) {
    const row = await db.prepare(
        'SELECT COUNT(*) AS n FROM privacy_links WHERE email = ? AND created_at > ?',
    ).bind(email, since).first();
    return row.n;
}

/** The address a link was sent to, or null if it is unknown or expired. */
export async function emailForPrivacyLink(db, { tokenHash, now }) {
    const row = await db.prepare('SELECT email FROM privacy_links WHERE token_hash = ? AND expires_at > ?')
        .bind(tokenHash, now).first();
    return row ? row.email : null;
}

/** Every row that belongs to `email`, for its owner to see and for erasing. */
export async function privacyRecords(db, { email, now }) {
    const [customers, subscriptions, devices, queued, beta] = await Promise.all([
        db.prepare('SELECT id, updated_at FROM customers WHERE email = ?').bind(email).all(),
        db.prepare(
            `SELECT s.id, s.status, s.price_id, s.period_end, s.cancel_at, s.updated_at
             FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE c.email = ?`,
        ).bind(email).all(),
        db.prepare('SELECT created_at, last_seen_at FROM device_tokens WHERE email = ? AND expires_at > ?').bind(email, now).all(),
        db.prepare('SELECT 1 FROM erasure_queue WHERE email = ?').bind(email).first(),
        db.prepare('SELECT joined_at, claimed_at FROM beta_members WHERE email = ?').bind(email).first(),
    ]);
    return {
        customers: customers.results,
        subscriptions: subscriptions.results,
        devices: devices.results,
        erasurePending: queued != null,
        beta: beta ?? null,
    };
}

export async function logPrivacyRequest(db, { kind, receivedAt, completedAt }) {
    await db.prepare('INSERT INTO privacy_requests (kind, received_at, completed_at) VALUES (?, ?, ?)')
        .bind(kind, receivedAt, completedAt).run();
}

/** Queue a deletion, keeping the original date if one is already waiting. Returns its row. */
export async function queueErasure(db, { email, now }) {
    await db.prepare('INSERT INTO erasure_queue (email, requested_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING')
        .bind(email, now).run();
    return db.prepare('SELECT email, requested_at, notified_at FROM erasure_queue WHERE email = ?').bind(email).first();
}

export async function erasureQueue(db) {
    const { results } = await db.prepare('SELECT email, requested_at, notified_at FROM erasure_queue').all();
    return results;
}

export async function markErasureNotified(db, { email, at }) {
    await db.prepare('UPDATE erasure_queue SET notified_at = ? WHERE email = ?').bind(at, email).run();
}

/**
 * Delete everything held for `email`, in one transaction, so a failure leaves
 * the account whole and queued rather than half gone. What remains is the
 * anonymous log entry, and a hash of each customer id for ERASED_HOLD_MS.
 * Subscriptions go before customers, because they are found through them.
 */
export async function eraseAccount(db, { email, customerHashes, requestedAt, now }) {
    await db.batch([
        db.prepare('DELETE FROM device_tokens WHERE email = ?').bind(email),
        db.prepare('DELETE FROM device_codes WHERE email = ?').bind(email),
        db.prepare('DELETE FROM privacy_links WHERE email = ?').bind(email),
        db.prepare('DELETE FROM beta_members WHERE email = ?').bind(email),
        db.prepare('DELETE FROM subscriptions WHERE customer_id IN (SELECT id FROM customers WHERE email = ?)').bind(email),
        db.prepare('DELETE FROM customers WHERE email = ?').bind(email),
        db.prepare('DELETE FROM erasure_queue WHERE email = ?').bind(email),
        ...customerHashes.map((hash) => db.prepare(
            `INSERT INTO erased_customers (customer_hash, erased_at) VALUES (?, ?)
             ON CONFLICT (customer_hash) DO UPDATE SET erased_at = excluded.erased_at`,
        ).bind(hash, now)),
        db.prepare("INSERT INTO privacy_requests (kind, received_at, completed_at) VALUES ('delete', ?, ?)").bind(requestedAt, now),
    ]);
}

/** When the customer with this id hash was erased, or null if they were not. */
export async function erasedAt(db, customerHash) {
    const row = await db.prepare('SELECT erased_at FROM erased_customers WHERE customer_hash = ?').bind(customerHash).first();
    return row ? row.erased_at : null;
}

export async function forgetErased(db, customerHash) {
    await db.prepare('DELETE FROM erased_customers WHERE customer_hash = ?').bind(customerHash).run();
}

/** Do we have a customer with this Paddle id? */
export async function hasCustomerId(db, id) {
    return (await db.prepare('SELECT 1 FROM customers WHERE id = ?').bind(id).first()) != null;
}

// Paddle retries a webhook for about two days, so this is well past the last one.
const ERASED_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
// The privacy link rows also back the per-address daily limit.
const PRIVACY_LINK_KEEP_MS = 24 * 60 * 60 * 1000;
// California asks for at least 24 months of request records.
const PRIVACY_LOG_KEEP_MS = 750 * 24 * 60 * 60 * 1000;

/** Drop what has outlived its use. Run on a schedule so the tables stay small. */
export async function pruneExpired(db, now) {
    await db.batch([
        db.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM device_tokens WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM privacy_links WHERE created_at < ?').bind(now - PRIVACY_LINK_KEEP_MS),
        db.prepare('DELETE FROM erased_customers WHERE erased_at < ?').bind(now - ERASED_HOLD_MS),
        db.prepare('DELETE FROM privacy_requests WHERE completed_at < ?').bind(now - PRIVACY_LOG_KEEP_MS),
        db.prepare('DELETE FROM beta_members WHERE claimed_at IS NULL AND joined_at < ?').bind(now - BETA_HOLD_MS),
    ]);
}
