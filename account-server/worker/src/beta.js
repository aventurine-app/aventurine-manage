// ─── beta.js ────────────────────────────────────────────────────────────────
// The beta signup on aventurine-app.com/pricing.html: the first BETA_LIMIT
// people get a free Pro license with no end date.
//
//   GET  /api/beta          { open, limit, remaining }   for the pricing card
//   POST /api/beta/join     { email }                    reserve a spot
//
// After joining, the person downloads Aventurine Manage and signs in with
// that email as usual (devices.js); a spot counts as access there, and the
// first sign-in claims it. A spot not claimed within BETA_HOLD_MS is freed by
// the daily job (store.js pruneExpired).
//
// Choices that matter:
//   • The pricing page is on another origin (SITE_ORIGIN), so these routes
//     answer CORS for that origin only. Joining also requires that Origin, so
//     other sites cannot use their visitors to spend the spots or our limits.
//   • Joining answers the same for a new and an existing member, so the form
//     cannot be used to find out who is in the beta. Only a new member is
//     emailed, so it cannot be used to flood an inbox either; each IP is also
//     rate limited.
//   • The count and the insert are one statement (store.js joinBeta), so the
//     limit holds when people join at the same moment.
//   • A spot grants nothing until its address proves itself with an emailed
//     sign-in code, so joining with someone else's address gains nothing.
//   • BETA_LIMIT of 0, or no SITE_ORIGIN, closes the beta. Lowering the limit
//     takes no spot away; it only stops new ones.

import { betaWelcomeMessage } from './email.js';
import { normalizeEmail } from './email-address.js';
import { HttpError, json, readJsonBody } from './http.js';
import { BETA_HOLD_MS, countBetaMembers, joinBeta } from './store.js';

const DAY = 24 * 60 * 60 * 1000;

export const isBetaPath = (path) => path === '/api/beta' || path.startsWith('/api/beta/');

/** The CORS headers for the site, or none when the beta has no site to answer. */
function corsHeaders(config) {
    if (!config.siteOrigin) return {};
    return { 'Access-Control-Allow-Origin': config.siteOrigin, Vary: 'Origin' };
}

const isOpen = (config) => Boolean(config.siteOrigin) && config.betaLimit > 0;

async function status(deps) {
    const { config } = deps;
    if (!isOpen(config)) return { open: false, limit: 0, remaining: 0 };
    const taken = await countBetaMembers(deps.db);
    const remaining = Math.max(0, config.betaLimit - taken);
    return { open: remaining > 0, limit: config.betaLimit, remaining };
}

async function join(deps, request, ip) {
    const { config } = deps;
    if (!isOpen(config)) return { status: 'closed' };
    if (request.headers.get('Origin') !== config.siteOrigin) throw new HttpError(403, 'forbidden');
    if (!(await deps.rateLimit(`beta:${ip}`))) throw new HttpError(429, 'rate_limited');

    const body = await readJsonBody(request);
    const email = normalizeEmail(body.email);
    if (!email) throw new HttpError(400, 'invalid_email');

    const result = await joinBeta(deps.db, { email, now: deps.now(), limit: config.betaLimit });
    if (result === 'full') return { status: 'full' };
    if (result === 'joined') {
        const message = betaWelcomeMessage({
            downloadUrl: `${config.siteOrigin}/downloads.html`,
            holdDays: BETA_HOLD_MS / DAY,
        });
        deps.defer(deps.mail({ to: email, message }).catch((e) => console.error('[beta] welcome email failed:', e.message)));
    }
    // A new member and an existing one get the same answer.
    return { status: 'joined' };
}

/** Route a /api/beta request. `deps` is index.js's dependencies. */
export async function handleBeta(request, deps, path, ip) {
    const cors = corsHeaders(deps.config);
    try {
        if (path === '/api/beta') {
            if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, { ...cors, Allow: 'GET' });
            return json({ ok: true, ...(await status(deps)) }, 200, cors);
        }
        if (path === '/api/beta/join') {
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: {
                        ...cors,
                        'Access-Control-Allow-Methods': 'POST',
                        'Access-Control-Allow-Headers': 'Content-Type',
                        'Access-Control-Max-Age': '86400',
                    },
                });
            }
            if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
            return json({ ok: true, ...(await join(deps, request, ip)) }, 200, cors);
        }
        return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (e) {
        // Refusals carry the CORS headers too, so the page can say what went wrong.
        if (e instanceof HttpError) return json({ ok: false, error: e.code }, e.status, cors);
        throw e;
    }
}
