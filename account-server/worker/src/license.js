// ─── license.js ─────────────────────────────────────────────────────────────
// Signs the license that Aventurine Manage keeps on disk (devices.js).
//
// The desktop app has to keep working offline, so it cannot ask this server
// every time it wants to know whether features are unlocked. Instead it keeps
// the last answer, signed here with an Ed25519 key, and trusts it until
// `validUntil`. The signature means the saved answer cannot be edited by hand
// to unlock features or to stretch the offline period. The public half of the
// key is built into the app (electron/licensePolicy.js in the Manage repo).
//
// A license is `<payload>.<signature>`, both unpadded URL-safe base64. The
// payload is UTF-8 JSON:
//   v           1, the format
//   email       who signed in
//   active      does this email have any paid access right now (access.js)
//   tier        what that access is: 'none', 'basic' or 'pro' (access.js)
//   status      the subscription status shown in the app, or 'complimentary'
//   renewsAt    end of the paid period, or null
//   cancelsAt   when a scheduled cancellation takes effect, or null
//   issuedAt    when this was signed, ms
//   validUntil  how long the app may rely on it without checking again, ms
//
// The key is LICENSE_SIGNING_KEY: a PKCS#8 Ed25519 private key, base64. Make
// one with `node scripts/make-license-key.mjs`.

const encoder = new TextEncoder();

/** How long a signed license unlocks features without a fresh check. */
export const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export class LicenseKeyError extends Error {}

function base64Url(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(text) {
    const binary = atob(text.trim());
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// Importing a key is not free; one worker instance signs with the same key
// until the secret changes.
let cached = { source: null, key: null };

async function signingKey(secret) {
    if (!secret) throw new LicenseKeyError('LICENSE_SIGNING_KEY is not set');
    if (cached.source === secret) return cached.key;
    let key;
    try {
        key = await crypto.subtle.importKey('pkcs8', fromBase64(secret), { name: 'Ed25519' }, false, ['sign']);
    } catch (e) {
        throw new LicenseKeyError(`LICENSE_SIGNING_KEY is not a PKCS#8 Ed25519 key: ${e.message}`);
    }
    cached = { source: secret, key };
    return key;
}

/** The payload for `email`, from the tier access.js gave it. */
export function licensePayload({ email, tier, subscription, complimentary, now }) {
    const active = tier !== 'none';
    return {
        v: 1,
        email,
        active,
        tier,
        status: complimentary ? 'complimentary' : (subscription?.status ?? 'none'),
        renewsAt: subscription?.renewsAt ?? null,
        cancelsAt: subscription?.cancelsAt ?? null,
        issuedAt: now,
        // An inactive license unlocks nothing, so it needs no offline period.
        validUntil: active ? now + OFFLINE_GRACE_MS : now,
    };
}

/** Sign `payload` with the key in `secret`. Throws LicenseKeyError on a bad key. */
export async function signLicense(payload, secret) {
    const key = await signingKey(secret);
    const body = encoder.encode(JSON.stringify(payload));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, body));
    return `${base64Url(body)}.${base64Url(signature)}`;
}
