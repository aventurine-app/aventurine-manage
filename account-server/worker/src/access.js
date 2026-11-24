// ─── access.js ──────────────────────────────────────────────────────────────
// Who may use the app. One rule, in one place, with no I/O so it is easy to test.
//
// A subscription grants access while Paddle says it is:
//   active     paid up
//   trialing   in a free trial
//   past_due   a renewal payment failed and Paddle is retrying. Cutting someone
//              off during that window would punish an expired card.
// It does not while it is paused or canceled. A cancellation the customer asked
// for stays `active` until the paid period ends (Paddle flips it to `canceled`
// then), so access runs to the end of what they paid for.
//
// What it grants is its tier, read from the Paddle price it is on:
//   pro     Aventurine Manage plus Planner and every later Pro feature. The
//           prices in PRO_PRICE_IDS (config.js).
//   basic   Aventurine Manage. Every other price.
// Someone with several subscriptions gets the best of them. Someone on the
// complimentary list, or holding a beta spot (beta.js), gets pro.

export const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** 'pro', 'basic' or 'none'. `subscriptions` are rows from the subscriptions table. */
export function tierFor({ email, subscriptions, complimentary, proPrices, beta = false }) {
    if (beta || complimentary.has(email)) return 'pro';
    const paying = subscriptions.filter((s) => ACCESS_STATUSES.has(s.status));
    if (!paying.length) return 'none';
    return paying.some((s) => proPrices.has(s.price_id)) ? 'pro' : 'basic';
}

/** Does this email have any paid access, Basic or Pro? */
export function hasAccess({ email, subscriptions, complimentary, beta = false }) {
    if (beta || complimentary.has(email)) return true;
    return subscriptions.some((s) => ACCESS_STATUSES.has(s.status));
}

/** May this email use Planner (a Pro feature)? */
export function hasPro(who) {
    return tierFor(who) === 'pro';
}

/**
 * What to tell the account page: the subscription that matters most. One that
 * grants access wins; otherwise the most recently updated.
 */
export function summarize(subscriptions) {
    if (!subscriptions.length) return null;
    const ranked = [...subscriptions].sort((a, b) => {
        const byAccess = Number(ACCESS_STATUSES.has(b.status)) - Number(ACCESS_STATUSES.has(a.status));
        return byAccess || b.updated_at - a.updated_at;
    });
    const best = ranked[0];
    return { status: best.status, renewsAt: best.period_end ?? null, cancelsAt: best.cancel_at ?? null };
}
