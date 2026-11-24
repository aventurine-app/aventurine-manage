'use strict';

// ─── auth/common.js ─────────────────────────────────────────────────────────
// The sign-in pages' only helper: a JSON call to this site's own API. These
// pages are public, so nothing in static/js/auth/ may hold app code.

(function () {
    /** POST `body` as JSON. Resolves { status, body }; status 0 means the network failed. */
    async function authPost(path, body = {}) {
        try {
            const response = await fetch(path, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json().catch(() => ({})) };
        } catch {
            return { status: 0, body: {} };
        }
    }

    window.authPost = authPost;
}());
