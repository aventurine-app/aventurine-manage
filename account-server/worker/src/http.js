// ─── http.js ────────────────────────────────────────────────────────────────
// Request and response helpers shared by every route: JSON replies, cookies,
// the same-origin check for anything that changes state, a bounded JSON body
// reader, and the security headers every response carries.

export class HttpError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

// The same policy the app's own pages carry in a <meta> tag, sent as a header
// too (a header also covers frame-ancestors, which a meta tag cannot).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; "
    + "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; "
    + "frame-ancestors 'none'";

// How long a file named by its content hash (scripts/assemble.js, `?v=`) may
// be kept: the URL changes with the file, so the copy can never go stale.
const YEAR_SECONDS = 365 * 24 * 60 * 60;

// What each `cache` kind means as a Cache-Control header.
//   private     a browser may keep a copy but must ask before using it, so a
//               lapsed subscription is noticed on the next load
//   none        never kept (API answers, refusals)
//   versioned   a content-addressed file: kept for a year without asking, in
//               the browser only (the app's code) or any cache (public files)
const CACHE_CONTROL = {
    private: 'private, no-cache',
    none: 'no-store',
    'versioned-private': `private, max-age=${YEAR_SECONDS}, immutable`,
    'versioned-public': `public, max-age=${YEAR_SECONDS}, immutable`,
};

/** Add the headers every response should have. `secure` adds HSTS (https only). */
export function withSecurityHeaders(response, { secure, cache }) {
    const out = new Response(response.body, response);
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('X-Frame-Options', 'DENY');
    out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    // Nothing here is for another site to embed or read.
    out.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    if (secure) out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    if (CACHE_CONTROL[cache]) out.headers.set('Cache-Control', CACHE_CONTROL[cache]);
    return out;
}

export function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
}

export const redirect = (location, status = 302) => new Response(null, { status, headers: { Location: location } });

/**
 * Refuse a state-changing request that did not come from our own page. Browsers
 * always send Origin on a cross-site POST, so a missing or different Origin is
 * rejected. (SameSite=Lax on the cookie is the first line; this is the second.)
 */
export function requireSameOrigin(request, appOrigin) {
    if (request.headers.get('Origin') !== appOrigin) throw new HttpError(403, 'forbidden');
}

/** Read a small JSON object body. */
export async function readJsonBody(request, maxBytes = 4096) {
    const type = request.headers.get('Content-Type') || '';
    if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
    // Refuse an oversized body before reading it, when it says how big it is.
    if (Number(request.headers.get('Content-Length') || 0) > maxBytes) throw new HttpError(413, 'too_large');
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, 'too_large');
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw new HttpError(400, 'bad_json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json');
    return body;
}
