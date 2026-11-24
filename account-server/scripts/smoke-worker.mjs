// End-to-end check of the account server in Cloudflare's real local runtime
// (workerd), with a throwaway local D1 database and a throwaway license key.
// Drives signed Paddle webhooks, Aventurine Manage's sign-in code and its
// signed license (Basic and Pro), the privacy page, and checks that nothing of
// the app is hosted. Needs no secrets and touches none of your local state.
//
//   npm run smoke
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8787';
const SECRET = 'pdl_ntfset_local_dev';
const PRO_PRICE = 'pri_smoke_pro';
const cwd = new URL('..', import.meta.url).pathname;
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'aventurine-worker-smoke-'));
const keys = crypto.generateKeyPairSync('ed25519');
const signingKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
// Settings passed on the command line, so no .dev.vars file is needed or read.
const vars = ['APP_ORIGIN:http://127.0.0.1:8787', `PADDLE_WEBHOOK_SECRET:${SECRET}`, 'COMPLIMENTARY_EMAILS:test@example.com',
    `PRO_PRICE_IDS:${PRO_PRICE}`, `LICENSE_SIGNING_KEY:${signingKey}`].flatMap((v) => ['--var', v]);
let failed = false;
const check = (label, ok, extra = '') => { console.log(`${ok ? 'ok ' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(spawnSync('npm', ['run', 'build'], { cwd, env }).stdout.toString().trim().split('\n').pop());
const mig = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'aventurine-prism', '--local', '--persist-to', state, '--config', 'worker/wrangler.toml'], { cwd, env });
console.log('migrations:', mig.status === 0 ? 'applied' : mig.stderr.toString().slice(-400));

let log = '';
const dev = spawn('npx', ['wrangler', 'dev', '--config', 'worker/wrangler.toml', '--port', '8787', '--local', '--persist-to', state, ...vars], { cwd, env });
dev.stdout.on('data', (d) => { log += d; });
dev.stderr.on('data', (d) => { log += d; });

async function waitReady() {
    for (let i = 0; i < 120; i++) {
        try { const r = await fetch(`${BASE}/auth/privacy`, { redirect: 'manual' }); if (r.status) return true; } catch { /* not up yet */ }
        await sleep(500);
    }
    return false;
}

const req = (p, { method = 'GET', json, headers = {}, body } = {}) => fetch(`${BASE}${p}`, {
    method, redirect: 'manual',
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
});

/** Sign Aventurine Manage in as `email`. The dev server prints the code instead of emailing it. */
async function signInDevice(email) {
    const before = log.length;
    const r = await req('/api/device/code', { method: 'POST', json: { email } });
    await sleep(400);
    const m = new RegExp(`email to ${email.replace(/[.]/g, '\\.')}: (\\d{6}) is your`).exec(log.slice(before));
    if (!m) return { status: r.status, token: null };
    const v = await req('/api/device/verify', { method: 'POST', json: { email, code: m[1] } });
    const answer = await v.json();
    return { status: v.status, token: answer.token, license: answer.license };
}

/** The license's payload, if its signature is the throwaway key's. */
function readLicense(license) {
    const [body, signature] = license.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!crypto.verify(null, body, keys.publicKey, signature)) return null;
    return JSON.parse(body.toString('utf8'));
}

async function webhook(event) {
    const body = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
    return req('/api/paddle/webhook', { method: 'POST', body, headers: { 'Paddle-Signature': `ts=${ts};h1=${h1}`, 'Content-Type': 'application/json' } });
}

const at = () => new Date().toISOString();
const customerEvent = (n, email) => ({ event_id: `evt_c${n}`, event_type: 'customer.created', occurred_at: at(), data: { id: `ctm_0${n}smoke`, email } });
const subscriptionEvent = (n, price, status = 'active') => ({
    event_id: `evt_s${n}_${status}`, event_type: 'subscription.created', occurred_at: at(),
    data: { id: `sub_0${n}smoke`, customer_id: `ctm_0${n}smoke`, status, items: [{ price: { id: price } }],
        current_billing_period: { ends_at: new Date(Date.now() + 30 * 864e5).toISOString() } },
});

try {
    check('wrangler dev starts', await waitReady(), log.slice(-600));

    // Nothing of the app is hosted.
    for (const p of ['/', '/auth/login', '/demo', '/export', '/static/js/app/store.js']) {
        const r = await req(p);
        check(`${p} is not served`, r.status === 404, `${r.status}`);
    }
    for (const p of ['/api/me', '/api/vault']) check(`${p} is gone`, (await req(p)).status === 404);

    // The privacy page and what it loads.
    let r = await req('/auth/privacy');
    const privacy = await r.text();
    check('the privacy page is public', r.status === 200 && privacy.includes('See or delete your data'), `${r.status}`);
    check('and the page is HTML', (r.headers.get('content-type') || '').startsWith('text/html'), r.headers.get('content-type'));
    check('security headers are sent', (r.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'") && r.headers.get('x-content-type-options') === 'nosniff');
    const files = [...privacy.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
    const served = await Promise.all(files.map((p) => req(p)));
    check('every file the privacy page names is served', files.length > 5 && served.every((x) => x.status === 200), served.map((x, i) => `${x.status} ${files[i]}`).filter((l) => !l.startsWith('200')).join(', '));

    // Buyers, as Paddle would announce them.
    r = await webhook(customerEvent(1, 'basic@example.com'));
    check('a signed customer webhook is accepted', r.status === 200, `${r.status} ${await r.text()}`);
    r = await webhook(subscriptionEvent(1, 'pri_smoke_basic'));
    check('a signed subscription webhook is accepted', r.status === 200);
    await webhook(customerEvent(2, 'pro@example.com'));
    await webhook(subscriptionEvent(2, PRO_PRICE));
    r = await req('/api/paddle/webhook', { method: 'POST', body: '{}', headers: { 'Paddle-Signature': 'ts=1;h1=' + '0'.repeat(64) } });
    check('a forged webhook is refused', r.status === 401);

    // Aventurine Manage signs in.
    const stranger = await signInDevice('stranger@example.com');
    check('a stranger gets the same answer and no code', stranger.status === 202 && stranger.token === null, JSON.stringify(stranger));

    const basic = await signInDevice('basic@example.com');
    const basicLicense = basic.license && readLicense(basic.license);
    check('a Basic buyer signs in with a signed Basic license', basic.status === 200 && basicLicense?.tier === 'basic' && basicLicense.active, JSON.stringify(basicLicense));

    const pro = await signInDevice('pro@example.com');
    const proLicense = pro.license && readLicense(pro.license);
    check('a Pro buyer signs in with a signed Pro license', pro.status === 200 && proLicense?.tier === 'pro', JSON.stringify(proLicense));

    const owner = await signInDevice('test@example.com');
    check('the complimentary address is Pro', readLicense(owner.license)?.tier === 'pro');

    r = await req('/api/device/license', { method: 'POST', headers: { Authorization: `Bearer ${basic.token}` } });
    check('a signed-in device gets a fresh license', r.status === 200 && readLicense((await r.json()).license)?.tier === 'basic');

    await webhook({ ...subscriptionEvent(1, 'pri_smoke_basic', 'canceled'), event_type: 'subscription.updated', occurred_at: new Date(Date.now() + 1000).toISOString() });
    r = await req('/api/device/license', { method: 'POST', headers: { Authorization: `Bearer ${basic.token}` } });
    const lapsed = readLicense((await r.json()).license);
    check('a cancelled subscription is no tier on the next check', lapsed?.tier === 'none' && lapsed.active === false, JSON.stringify(lapsed));

    r = await req('/api/device/signout', { method: 'POST', headers: { Authorization: `Bearer ${pro.token}` } });
    check('signing out', r.status === 200);
    r = await req('/api/device/license', { method: 'POST', headers: { Authorization: `Bearer ${pro.token}` } });
    check('forgets the device', r.status === 401);
} catch (e) {
    check('smoke run', false, e.stack);
} finally {
    dev.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(state, { recursive: true, force: true });
}

console.log(failed ? '\nWORKER SMOKE FAILED' : '\nWORKER SMOKE PASSED');
process.exit(failed ? 1 : 0);
