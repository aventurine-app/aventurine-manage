// What the account server answers. Aventurine is a desktop app and nothing of
// it is hosted: the worker serves the privacy page and the files it names, the
// APIs for Paddle, Aventurine Manage and privacy requests, and nothing else.
// Anything that goes wrong is a refusal.

import assert from 'node:assert/strict';
import test from 'node:test';

import { hasAccess, summarize, tierFor } from '../../worker/src/access.js';
import { ConfigError, parseEmailList, parsePriceList, readConfig } from '../../worker/src/config.js';
import { createWorker } from '../../worker/src/index.js';
import { APP_CODE, createSite, ORIGIN } from './harness.mjs';

const YEAR = 'max-age=31536000, immutable';

function setup(t, options) {
    const site = createSite(options);
    t.after(site.restore);
    return site;
}

// ── What is served ─────────────────────────────────────────────────────────

test('the privacy page and its files are served to anyone', async (t) => {
    const site = setup(t);
    const page = await site.call('/auth/privacy');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /your data/);
    assert.equal((await site.call('/static/js/auth/privacy.js')).status, 200);
    assert.equal((await site.call('/static/css/style.css')).status, 200);
});

test('nothing of the app is hosted: the web Planner, its sign-in, the sandbox and the export page are gone', async (t) => {
    const site = setup(t);
    for (const path of ['/', '/index.html', '/auth/login', '/auth/confirm', '/auth/inactive', '/demo', '/demo/',
        '/export', '/static/js/app/store.js']) {
        const r = await site.call(path);
        assert.equal(r.status, 404, path);
        assert.ok(!(await r.text()).includes(APP_CODE), path);
    }
    for (const [method, path] of [['POST', '/api/auth/request'], ['POST', '/api/auth/verify'], ['GET', '/api/me'],
        ['POST', '/api/billing/portal'], ['GET', '/api/vault'], ['PUT', '/api/vault/items/p_one']]) {
        assert.equal((await site.call(path, { method, json: method === 'GET' ? undefined : {} })).status, 404, path);
    }
});

test('dot-segment tricks cannot reach a file outside /static/', async (t) => {
    const site = setup(t);
    for (const path of ['/static/../index.html', '/static/%2e%2e/index.html', '/auth/../index.html',
        '/static/js/auth/../../../index.html']) {
        const r = await site.call(path);
        assert.notEqual(r.status, 200, path);
        assert.ok(!(await r.text()).includes(APP_CODE), path);
    }
});

test('nothing but GET reaches a file', async (t) => {
    const site = setup(t);
    for (const method of ['POST', 'PUT', 'DELETE']) {
        assert.equal((await site.call('/static/css/style.css', { method })).status, 405);
        assert.equal((await site.call('/auth/privacy', { method })).status, 405);
    }
});

test('a file named by its content may be kept for a year; the page and a plain name revalidate', async (t) => {
    const site = setup(t);
    assert.equal((await site.call('/static/css/style.css?v=0123456789')).headers.get('Cache-Control'), `public, ${YEAR}`);
    assert.equal((await site.call('/static/css/style.css?v=latest')).headers.get('Cache-Control'), null);
    assert.equal((await site.call('/auth/privacy?v=0123456789')).headers.get('Cache-Control'), null);
    const missing = await site.call('/static/css/missing.css?v=0123456789');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('Cache-Control'), 'no-store');
});

// ── Every response ─────────────────────────────────────────────────────────

test('every response carries the security headers', async (t) => {
    const site = setup(t);
    for (const r of [await site.call('/'), await site.call('/auth/privacy'), await site.call('/api/nothing')]) {
        assert.match(r.headers.get('Content-Security-Policy'), /default-src 'self'.*frame-ancestors 'none'/);
        assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
        assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
        assert.equal(r.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
        assert.match(r.headers.get('Strict-Transport-Security'), /max-age=31536000/);
    }
    assert.equal((await site.call('/api/nothing')).headers.get('Cache-Control'), 'no-store');
});

test('another hostname is sent to the real one, except the desktop app and Paddle', async (t) => {
    const site = setup(t);
    const worker = createWorker({ now: () => site.clock.now });
    const other = (path, init) => worker.fetch(new Request(`https://aventurine-planner.someone.workers.dev${path}`, init), site.env, { waitUntil() {} });

    const page = await other('/auth/privacy?x=1');
    assert.equal(page.status, 308);
    assert.equal(page.headers.get('Location'), `${ORIGIN}/auth/privacy?x=1`);
    assert.equal((await other('/api/device/license', { method: 'POST' })).status, 401);
    assert.equal((await other('/api/paddle/webhook', { method: 'POST', body: '{}' })).status !== 308, true);
});

test('if the database fails, no detail leaks', async (t) => {
    const site = setup(t);
    site.env.DB = { prepare() { throw new Error('D1_ERROR: secret internals'); }, batch() { throw new Error('D1_ERROR: secret internals'); } };
    const original = console.error;
    console.error = () => {};
    try {
        const r = await site.call('/api/privacy/request', { method: 'POST', json: { email: 'a@example.com' } });
        assert.equal(r.status, 500);
        assert.ok(!(await r.text()).includes('secret internals'));
    } finally {
        console.error = original;
    }
});

// ── Rules ──────────────────────────────────────────────────────────────────

test('a misconfigured origin stops the worker instead of guessing', () => {
    assert.throws(() => readConfig({ APP_ORIGIN: 'http://app.example.com' }), ConfigError);
    assert.throws(() => readConfig({ APP_ORIGIN: 'not a url' }), ConfigError);
    assert.equal(readConfig({ APP_ORIGIN: 'http://127.0.0.1:8787' }).secure, false);
    assert.equal(readConfig({ APP_ORIGIN: ORIGIN }).secure, true);
});

test('the complimentary list is read loosely', () => {
    assert.deepEqual([...parseEmailList(' A@x.co, b@x.co  C@X.CO\n')].sort(), ['a@x.co', 'b@x.co', 'c@x.co']);
    assert.equal(parseEmailList(undefined).size, 0);
});

test('the Pro price list keeps only Paddle price ids', () => {
    assert.deepEqual([...parsePriceList(' pri_01abc, pri_02def\nnope PRI_UPPER ')], ['pri_01abc', 'pri_02def']);
    assert.equal(parsePriceList(undefined).size, 0);
});

test('the access rule', () => {
    const none = new Set();
    const sub = (status, updated_at = 1) => ({ status, updated_at, period_end: null, cancel_at: null });
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [], complimentary: none }), false);
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [sub('canceled'), sub('active')], complimentary: none }), true);
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [], complimentary: new Set(['a@x.co']) }), true);
    const pro = new Set(['pri_pro']);
    const priced = (status, price_id) => ({ ...sub(status), price_id });
    const tier = (subscriptions, complimentary = none) => tierFor({ email: 'a@x.co', subscriptions, complimentary, proPrices: pro });
    assert.equal(tier([]), 'none');
    assert.equal(tier([priced('canceled', 'pri_pro')]), 'none', 'a lapsed Pro price grants nothing');
    assert.equal(tier([priced('active', 'pri_basic')]), 'basic');
    assert.equal(tier([priced('past_due', null)]), 'basic', 'an unknown price is Basic');
    assert.equal(tier([priced('trialing', 'pri_pro')]), 'pro');
    assert.equal(tier([priced('active', 'pri_basic'), priced('active', 'pri_pro')]), 'pro', 'the best one wins');
    assert.equal(tier([], new Set(['a@x.co'])), 'pro', 'complimentary is Pro');
    assert.equal(summarize([]), null);
    assert.equal(summarize([sub('canceled', 9), sub('active', 1)]).status, 'active', 'one with access wins');
    assert.equal(summarize([sub('canceled', 1), sub('paused', 9)]).status, 'paused', 'else the newest');
});
