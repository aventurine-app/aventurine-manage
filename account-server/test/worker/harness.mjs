// Shared setup for the worker tests: the real worker running on an in-memory
// SQLite database (through a small D1-shaped wrapper), a fake asset store, a
// clock the test controls, a license signing key, and a capture of what the
// worker sends out (emails, calls to Paddle).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createWorker } from '../../worker/src/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker', 'migrations');

export const ORIGIN = 'https://app.example.test';
export const WEBHOOK_SECRET = 'pdl_ntfset_test_secret';
export const OWNER = 'owner@example.test';
export const PADDLE_API = 'https://paddle-api.example.test';
export const PRIVACY_INBOX = 'privacy@example.test';
// The marketing site, whose pricing page calls the beta signup (beta.js).
export const SITE = 'https://site.example.test';

// The pair the worker signs Aventurine Manage's licenses with (license.js).
export const LICENSE_KEYS = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const SIGNING_KEY = Buffer.from(await crypto.subtle.exportKey('pkcs8', LICENSE_KEYS.privateKey)).toString('base64');

// What dist/ holds (scripts/build.js): the privacy page and the files it names.
// The app's code is here too, as a file the worker must never serve.
export const APP_CODE = 'secret app code';

/** A D1-shaped wrapper (prepare/bind/first/all/run, batch) over node:sqlite. */
export function createTestDb() {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
        sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    const statement = (sql, params) => {
        const stmt = sqlite.prepare(sql);
        return {
            bind: (...p) => statement(sql, p),
            first: async () => stmt.get(...params) ?? null,
            all: async () => ({ results: stmt.all(...params) }),
            run: async () => ({ meta: { changes: stmt.run(...params).changes } }),
        };
    };
    return {
        sqlite,
        prepare: (sql) => statement(sql, []),
        async batch(statements) {
            sqlite.exec('BEGIN');
            try {
                const results = [];
                for (const s of statements) results.push(await s.run());
                sqlite.exec('COMMIT');
                return results;
            } catch (e) {
                sqlite.exec('ROLLBACK');
                throw e;
            }
        },
    };
}

/** Sign a webhook body the way Paddle does. */
export function signWebhook(body, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
}

// The harness's Pro price; any other price id is Basic (access.js).
export const PRO_PRICE = 'pri_monthly';
export const BASIC_PRICE = 'pri_basic_monthly';

let counter = 0;
const id = (prefix) => `${prefix}_${String(++counter).padStart(8, '0')}abcdef`;

export function customerEvent({ customerId, email, type = 'customer.created', at }) {
    return { event_id: id('evt'), event_type: type, occurred_at: at, data: { id: customerId, email, status: 'active' } };
}

export function subscriptionEvent({
    subscriptionId, customerId, status = 'active', type = 'subscription.created', at, periodEnd, cancelAt, priceId = PRO_PRICE,
}) {
    return {
        event_id: id('evt'),
        event_type: type,
        occurred_at: at,
        data: {
            id: subscriptionId,
            customer_id: customerId,
            status,
            items: [{ price: { id: priceId } }],
            current_billing_period: periodEnd ? { starts_at: at, ends_at: periodEnd } : null,
            scheduled_change: cancelAt ? { action: 'cancel', effective_at: cancelAt } : null,
        },
    };
}

/** The worker, wired to fakes. `clock.now` is the current time in ms. */
export function createSite({
    complimentary = OWNER, files, rateLimit, origin = ORIGIN, resendKey = 're_test_key', siteOrigin = SITE, betaLimit = '3',
} = {}) {
    const db = createTestDb();
    const clock = { now: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const worker = createWorker({ now: () => clock.now });

    const assets = files ?? {
        '/index.html': APP_CODE,
        '/static/css/style.css': 'body{}',
        '/static/js/shell/theme-init.js': 'theme',
        '/static/js/auth/privacy.js': 'privacy page script',
        '/auth/privacy.html': '<!doctype html><title>your data</title>',
    };
    const limited = new Set();
    const env = {
        DB: db,
        ASSETS: {
            fetch: async (request) => {
                const body = assets[new URL(request.url).pathname];
                return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
            },
        },
        APP_ORIGIN: origin,
        EMAIL_FROM: 'Aventurine Planner <signin@example.test>',
        PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        PADDLE_API_URL: PADDLE_API,
        PADDLE_API_KEY: 'pdl_test_key',
        PRIVACY_EMAIL: PRIVACY_INBOX,
        RESEND_API_KEY: resendKey,
        COMPLIMENTARY_EMAILS: complimentary,
        LICENSE_SIGNING_KEY: SIGNING_KEY,
        PRO_PRICE_IDS: `${PRO_PRICE} pri_other_pro`,
        SITE_ORIGIN: siteOrigin,
        BETA_LIMIT: betaLimit,
        RATE_LIMIT: rateLimit ?? { limit: async ({ key }) => ({ success: !limited.has(key) }) },
    };

    const pending = [];
    const ctx = { waitUntil: (p) => { pending.push(p); } };
    const sent = { emails: [], paddle: [] };
    // paddleCancelStatus: what cancelling answers. paddleSubscriptionStatus: what
    // Paddle says a subscription's status is. paddleCustomerEmail: who a customer is.
    const behavior = { resendStatus: 200, paddleCancelStatus: 200, paddleSubscriptionStatus: 'active', paddleCustomerEmail: null };

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        const body = init.body ? JSON.parse(init.body) : null;
        if (target.startsWith('https://api.resend.com/')) {
            const status = behavior.refusedAddress === body.to[0] ? 500 : behavior.resendStatus;
            sent.emails.push({ headers: init.headers, ...body });
            return new Response('{}', { status });
        }
        if (target.startsWith(PADDLE_API)) {
            const path = target.slice(PADDLE_API.length);
            sent.paddle.push({ method: init.method, path, body, headers: init.headers });
            if (path.endsWith('/cancel')) return new Response('{}', { status: behavior.paddleCancelStatus });
            if (path.startsWith('/customers/')) return Response.json({ data: { email: behavior.paddleCustomerEmail } });
            return Response.json({ data: { status: behavior.paddleSubscriptionStatus } });
        }
        throw new Error(`unexpected outbound request to ${target}`);
    };

    /** Make a request to the worker and wait for anything it deferred. */
    // `base` sends the request to another hostname than APP_ORIGIN.
    async function call(pathname, { method = 'GET', headers = {}, body, cookie, origin: requestOrigin = origin, json, base = origin } = {}) {
        const h = new Headers(headers);
        if (cookie) h.set('Cookie', cookie);
        let payload = body;
        if (json !== undefined) {
            payload = JSON.stringify(json);
            h.set('Content-Type', 'application/json');
        }
        if (method !== 'GET' && !h.has('Origin') && requestOrigin) h.set('Origin', requestOrigin);
        const response = await worker.fetch(new Request(`${base}${pathname}`, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
        await Promise.all(pending.splice(0));
        return response;
    }

    const site = {
        env, db, clock, sent, behavior, call, files: assets, limit: (key) => limited.add(key),
        restore: () => { globalThis.fetch = realFetch; },
        advance: (ms) => { clock.now += ms; },
        iso: (offsetMs = 0) => new Date(clock.now + offsetMs).toISOString(),

        /** Run the daily scheduled job and wait for it. */
        async cron() {
            const work = [];
            worker.scheduled({}, env, { waitUntil: (p) => { work.push(p); } });
            await Promise.all(work);
        },

        /** Deliver a signed webhook, as Paddle would. */
        async webhook(event, { secret, ts } = {}) {
            const body = JSON.stringify(event);
            return call('/api/paddle/webhook', {
                method: 'POST',
                body,
                origin: null,
                headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signWebhook(body, { secret, ts: ts ?? Math.floor(clock.now / 1000) }) },
            });
        },

        /** A paying customer, as Paddle's events would create one. */
        async subscribe({ email, customerId = 'ctm_01alice', subscriptionId = 'sub_01alice', status = 'active', periodEnd, cancelAt, priceId }) {
            const at = site.iso();
            await site.webhook(customerEvent({ customerId, email, at }));
            await site.webhook(subscriptionEvent({ subscriptionId, customerId, status, at, periodEnd, cancelAt, priceId }));
        },

        /** Sign Aventurine Manage in as `email` (devices.js) and return its device token. */
        async signInDevice(email) {
            await call('/api/device/code', { method: 'POST', origin: null, json: { email } });
            const code = /\b(\d{6})\b/.exec(sent.emails.at(-1).text)[1];
            const response = await call('/api/device/verify', { method: 'POST', origin: null, json: { email, code } });
            return (await response.json()).token;
        },

        /** The device's current license payload, or the HTTP status if refused. */
        async deviceLicense(token) {
            const response = await call('/api/device/license', { method: 'POST', origin: null, json: {}, headers: { Authorization: `Bearer ${token}` } });
            if (response.status !== 200) return response.status;
            return JSON.parse(Buffer.from((await response.json()).license.split('.')[0], 'base64url').toString('utf8'));
        },
    };
    return site;
}
