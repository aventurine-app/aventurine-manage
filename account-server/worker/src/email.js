// ─── email.js ───────────────────────────────────────────────────────────────
// Sends email through Resend's HTTP API: Aventurine Manage's sign-in code and
// the privacy messages. Isolated here so changing provider means changing this
// file only.

export class EmailError extends Error {}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The 6-digit code that signs Aventurine Manage in (devices.js). `code` is digits only. */
export function deviceCodeMessage(code, minutes) {
    const foot = `It expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`;
    return {
        subject: `${code} is your Aventurine Manage sign-in code`,
        text: `Enter this code in Aventurine Manage to sign in:\n\n${code}\n\n${foot}`,
        html: `<p>Enter this code in Aventurine Manage to sign in:</p>`
            + `<p style="font-size:24px;font-weight:600;letter-spacing:4px">${code}</p><p>${foot}</p>`,
    };
}

/** Sent once, when someone takes a beta spot (beta.js). */
export function betaWelcomeMessage({ downloadUrl, holdDays }) {
    const lead = 'You have a spot in the Aventurine beta. It comes with a free Pro license: '
        + 'Aventurine Manage, the Planner and every later Pro feature.';
    const steps = `Download Aventurine and sign in with this email address within ${holdDays} days to keep your spot. `
        + 'After that it is yours, with no end date.';
    const foot = 'If you did not sign up, you can ignore this email and the spot will be released.';
    return {
        subject: 'Your Aventurine beta spot',
        text: `${lead}\n\n${steps}\n\n${downloadUrl}\n\n${foot}`,
        html: `<p>${lead}</p><p>${steps}</p><p><a href="${escapeHtml(downloadUrl)}">Download Aventurine</a></p><p>${foot}</p>`,
    };
}

/** A date as people read it, in UTC (the day the daily job runs on): 'January 4, 2027'. */
const longDate = (ms) => new Date(ms).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });

/** The link that proves someone owns an address, so they can see or delete its data. */
export function privacyLinkMessage(link, minutes) {
    const lead = 'Someone asked to see or delete the data Aventurine holds for this email address.';
    const foot = `The link expires in ${minutes} minutes. Nothing has changed yet, and nothing is deleted until you confirm it. `
        + 'If you did not ask for this, you can ignore this email.';
    return {
        subject: 'Your Aventurine privacy request',
        text: `${lead} Open this link to continue:\n\n${link}\n\n${foot}`,
        html: `<p>${lead}</p><p><a href="${escapeHtml(link)}">See or delete your data</a></p><p>${foot}</p>`,
    };
}

export const PADDLE_DELETION_URL = 'https://preferences.paddle.com/form/deletion';

/** The confirmation that a deletion finished. The last email sent to this address. */
export function erasureReceiptMessage() {
    const lead = 'We have deleted your Aventurine account data: your email address, your subscription record '
        + 'and your sign-in records. Any subscription is cancelled, so you will not be charged again.';
    const support = 'If you have emailed us or bought from us before, we will find and delete those records within 30 days, '
        + 'keeping only what the law requires.';
    const backups = 'Copies in our providers\' backups and email logs expire on their own within 30 days.';
    const paddle = 'Paddle, which took your payments, keeps its own records and decides on its own what to delete. '
        + 'To ask it to delete yours, use its form:';
    const foot = 'This is the last email we will send you.';
    return {
        subject: 'Your Aventurine data has been deleted',
        text: `${lead}\n\n${support}\n\n${backups}\n\n${paddle}\n${PADDLE_DELETION_URL}\n\n${foot}`,
        html: `<p>${lead}</p><p>${support}</p><p>${backups}</p>`
            + `<p>${paddle} <a href="${PADDLE_DELETION_URL}">${PADDLE_DELETION_URL}</a></p><p>${foot}</p>`,
    };
}

/**
 * The owner's checklist for one deletion: the steps no code can do. Sent before
 * the address is erased, and it is the only place the address survives, so
 * PRIVACY.md ends by deleting this email. Plain text, read only by the owner.
 */
export function erasureOpsMessage({ email, requestedAt, dueBy, cancelled, stuck, complimentary }) {
    const billing = stuck.length
        ? `NOT FINISHED. Cancel ${stuck.join(', ')} in the Paddle dashboard. Nothing is deleted until that is done; `
            + 'the worker retries daily and finishes by itself, and this email repeats until then.'
        : `${cancelled} subscription(s) cancelled. Nothing further to do in Paddle.`;
    const steps = [
        'Support inbox: search for the address and delete what you find.',
        complimentary
            ? 'COMPLIMENTARY_EMAILS: this address is on the list. Remove it with wrangler secret put.'
            : null,
        'Delete this email, including from Sent and Trash.',
    ].filter(Boolean).map((step, i) => `${i + 1}. ${step}`).join('\n');
    return {
        subject: `Privacy: finish deleting ${email} by ${longDate(dueBy)}`,
        text: `A deletion was confirmed on ${longDate(requestedAt)}. Finish the steps below by ${longDate(dueBy)}.\n\n`
            + `Address: ${email}\nBilling: ${billing}\n\n${steps}\n\nDetails are in account-server/worker/PRIVACY.md in the aventurine-manage repo.`,
    };
}

/** Send `message` ({ subject, text, html }) to `to`. Throws EmailError if it was not accepted. */
export async function sendEmail({ apiKey, from, to, message, fetchImpl = fetch }) {
    if (!apiKey || !from) throw new EmailError('email is not configured');
    const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], ...message }),
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new EmailError(`the email service answered ${response.status}`);
}

