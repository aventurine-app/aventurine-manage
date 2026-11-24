// ─── index.js ───────────────────────────────────────────────────────────────
// The Aventurine account server. Aventurine Manage is a desktop app and nothing
// of it is hosted; this Worker only does what the desktop app and the billing
// need from a server:
//
//   /api/paddle/webhook     Paddle only (signature checked)       paddle.js
//   /api/device/*           Aventurine Manage's sign-in and
//                           license check (any of our hostnames)  devices.js
//   /api/privacy/*          see or delete an address's data       privacy.js
//   /api/beta, /api/beta/*  the beta signup on the pricing page
//                           (CORS for SITE_ORIGIN only)           beta.js
//   /auth/privacy           public page for /api/privacy (linked from
//                           aventurine-app.com/delete-me.html), and the
//                           files it loads
//
// Everything else is 404. `dist/` (scripts/build.js) holds only the privacy
// page and what it names, so nothing else can be served by mistake.
//
// Fail closed: any error is a refusal, never a free pass.

import { handleBeta, isBetaPath } from './beta.js';
import { ConfigError, readConfig } from './config.js';
import { handleDevice, isDevicePath } from './devices.js';
import { sendEmail } from './email.js';
import { HttpError, json, redirect, withSecurityHeaders } from './http.js';
import { handleWebhook, paddleApi } from './paddle.js';
import { handlePrivacy, isPrivacyPath, processErasureQueue } from './privacy.js';
import { pruneExpired } from './store.js';

const PRIVACY_PAGE = '/auth/privacy';
// A file named by its content (scripts/assemble.js appends `?v=<hash>`) may be
// kept by the browser for a year: a change to the file changes its address.
const ASSET_VERSION = /^[0-9a-f]{8,64}$/;

function clientIp(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** Sends `message` to `to`. Local development with no email provider prints it instead. */
function mailer(env, config) {
    return async ({ to, message }) => {
        if (!config.secure && !env.RESEND_API_KEY) {
            console.log(`[dev] email to ${to}: ${message.subject}\n${message.text}`);
            return;
        }
        await sendEmail({ apiKey: env.RESEND_API_KEY, from: config.emailFrom, to, message });
    };
}

const paddleFor = (env, config) => paddleApi({ apiKey: env.PADDLE_API_KEY, baseUrl: config.paddleApiUrl });

export function createWorker({ now = Date.now } = {}) {
    function dependencies(env, ctx, config) {
        return {
            db: env.DB,
            config,
            now,
            mail: mailer(env, config),
            paddle: paddleFor(env, config),
            defer: (promise) => ctx.waitUntil(promise),
            // Signs Aventurine Manage's licenses (license.js). Only devices.js uses it.
            licenseKey: env.LICENSE_SIGNING_KEY,
            // The rate-limit binding is optional so local development works without it.
            rateLimit: async (key) => (env.RATE_LIMIT ? (await env.RATE_LIMIT.limit({ key })).success : true),
        };
    }

    // ── API ────────────────────────────────────────────────────────────────

    async function api(request, env, ctx, config, path) {
        const deps = dependencies(env, ctx, config);
        const ip = clientIp(request);

        if (path === '/api/paddle/webhook') {
            return handleWebhook({ request, db: env.DB, secret: env.PADDLE_WEBHOOK_SECRET, nowMs: now(), paddle: deps.paddle });
        }
        if (isPrivacyPath(path)) return handlePrivacy(request, deps, path, ip);
        if (isDevicePath(path)) return handleDevice(request, deps, path, ip);
        if (isBetaPath(path)) return handleBeta(request, deps, path, ip);

        return json({ ok: false, error: 'not_found' }, 404);
    }

    // ── The privacy page and its files ─────────────────────────────────────

    /** Fetch a file from dist/ (bound as ASSETS). */
    const asset = (request, env, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

    async function pages(request, env, url) {
        const path = url.pathname;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return { response: json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' }), cache: 'none' };
        }
        if (path === PRIVACY_PAGE) return { response: await asset(request, env, `${PRIVACY_PAGE}.html`) };
        if (path.startsWith('/static/')) {
            const response = await asset(request, env, path);
            if (response.status !== 200) return { response: json({ ok: false, error: 'not_found' }, 404), cache: 'none' };
            const versioned = ASSET_VERSION.test(url.searchParams.get('v') || '');
            return { response, cache: versioned ? 'versioned-public' : undefined };
        }
        return { response: json({ ok: false, error: 'not_found' }, 404), cache: 'none' };
    }

    // ── Entry points ───────────────────────────────────────────────────────

    async function route(request, env, ctx) {
        const config = readConfig(env);
        const url = new URL(request.url);
        // One origin for the privacy page and the links it emails. The desktop
        // app's routes are left on every hostname, so a domain move does not
        // break installed copies, and Paddle's webhook is not redirected.
        const anyHost = isDevicePath(url.pathname) || url.pathname === '/api/paddle/webhook';
        if (url.origin !== config.appOrigin && !anyHost) {
            return { response: redirect(config.appOrigin + url.pathname + url.search, 308), config };
        }

        if (url.pathname.startsWith('/api/')) {
            return { response: await api(request, env, ctx, config, url.pathname), cache: 'none', config };
        }
        return { ...(await pages(request, env, url)), config };
    }

    async function fetchHandler(request, env, ctx) {
        let secure = true;
        try {
            const { response, cache, config } = await route(request, env, ctx);
            secure = config.secure;
            return withSecurityHeaders(response, { secure, cache });
        } catch (e) {
            let response;
            if (e instanceof HttpError) {
                response = json({ ok: false, error: e.code }, e.status);
            } else {
                // Never show the caller what went wrong; keep it for the logs.
                console.error('[worker] request failed:', e instanceof ConfigError ? `config: ${e.message}` : e);
                response = json({ ok: false, error: 'server_error' }, 500);
            }
            return withSecurityHeaders(response, { secure, cache: 'none' });
        }
    }

    /** Daily: drop expired codes and links, and finish queued deletions. */
    async function scheduled(env) {
        await pruneExpired(env.DB, now());
        let config;
        try {
            config = readConfig(env);
        } catch (e) {
            console.error('[privacy] queued deletions skipped: config:', e.message);
            return;
        }
        await processErasureQueue({ db: env.DB, config, now, mail: mailer(env, config), paddle: paddleFor(env, config) });
    }

    return {
        fetch: fetchHandler,
        scheduled: (_event, env, ctx) => ctx.waitUntil(scheduled(env)),
    };
}

export default createWorker();
