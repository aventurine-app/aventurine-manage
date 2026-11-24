// ─── config.js ──────────────────────────────────────────────────────────────
// Reads and checks the worker's settings once per request. A bad setting is an
// error here, not a surprise later: the worker refuses to run on a half-set-up
// environment rather than guess (for example, an emailed privacy link that
// points at the wrong host).
//
//   APP_ORIGIN              this server's address, where the privacy page lives
//   EMAIL_FROM              the From address of sign-in codes and privacy emails
//   PADDLE_API_URL          Paddle's API (https://api.paddle.com, or the sandbox's)
//   PRIVACY_EMAIL           where the checklist for a deletion goes (privacy.js)
//   PRO_PRICE_IDS           the Paddle prices that buy Pro (access.js), comma or space
//                           separated; every other price is Basic
//   COMPLIMENTARY_EMAILS    (secret, optional) emails with free access, comma or space separated
//   SITE_ORIGIN             the marketing site (https://aventurine-app.com), the one
//                           other origin that may call the beta signup (beta.js)
//   BETA_LIMIT              how many beta spots there are; 0 or unset closes the beta
//   PADDLE_WEBHOOK_SECRET, RESEND_API_KEY, PADDLE_API_KEY, LICENSE_SIGNING_KEY   (secrets)
//
// PADDLE_API_URL, PRIVACY_EMAIL, SITE_ORIGIN and BETA_LIMIT are the exception
// to refusing to run: without the first two only deletions fail, and a
// deletion waits in the queue until they are fixed; without the last two the
// beta is closed. So a missing or bad value is null (or 0), not an error.

import { normalizeEmail } from './email-address.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export class ConfigError extends Error {}

function parseOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ConfigError('APP_ORIGIN is not a URL');
    }
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        throw new ConfigError('APP_ORIGIN must be https (http is for localhost only)');
    }
    return { origin: url.origin, secure: url.protocol === 'https:' };
}

/** The value if it is an https URL, else null. */
function parseHttpsUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

const PRICE_SHAPE = /^pri_[a-z0-9_]+$/;

/** The Paddle price ids in a comma- or space-separated list; anything else is dropped. */
export function parsePriceList(value) {
    return new Set(String(value || '').split(/[\s,]+/).map((p) => p.trim()).filter((p) => PRICE_SHAPE.test(p)));
}

/** The emails in a comma- or space-separated list, lower-cased. */
export function parseEmailList(value) {
    return new Set(String(value || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/** A whole number of spots, or 0 (closed) for anything else. */
export function parseLimit(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,6}$/.test(text) ? Number(text) : 0;
}

export function readConfig(env) {
    const { origin, secure } = parseOrigin(env.APP_ORIGIN);
    return {
        appOrigin: origin,
        secure,
        emailFrom: env.EMAIL_FROM || '',
        paddleApiUrl: parseHttpsUrl(env.PADDLE_API_URL)?.replace(/\/$/, '') ?? null,
        privacyEmail: normalizeEmail(env.PRIVACY_EMAIL),
        complimentary: parseEmailList(env.COMPLIMENTARY_EMAILS),
        proPrices: parsePriceList(env.PRO_PRICE_IDS),
        siteOrigin: parseHttpsUrl(env.SITE_ORIGIN) ? new URL(env.SITE_ORIGIN).origin : null,
        betaLimit: parseLimit(env.BETA_LIMIT),
    };
}
