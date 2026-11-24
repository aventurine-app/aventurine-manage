// ─── email-address.js ───────────────────────────────────────────────────────
// One definition of "an email address we will accept", used wherever an address
// comes in (the sign-in form, Paddle customer events). The check is deliberately
// loose: the real test of an address is that a message reaches it.

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The address trimmed and lower-cased, or null if it cannot be one. */
export function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && SHAPE.test(email) ? email : null;
}
