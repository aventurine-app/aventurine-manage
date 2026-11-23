'use strict';

// Subscription license policy (electron/licensePolicy.js). Pinned here: a
// license unlocks only when its signature is genuine, it says active, and its
// offline period hasn't run out; a packaged app can't be pointed at another
// server or key; and the saved sign-in reads back exactly or not at all.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../../licensePolicy');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 21, 12);
const TOKEN = 'a'.repeat(43);

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function payload(overrides = {}) {
  return {
    v: 1, email: 'alice@example.com', active: true, status: 'active',
    renewsAt: NOW + 20 * DAY, cancelsAt: null, issuedAt: NOW, validUntil: NOW + 30 * DAY,
    ...overrides,
  };
}

// Signs the way the worker does (aventurine-planner worker/src/license.js).
function sign(body, key = privateKey) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return `${bytes.toString('base64url')}.${crypto.sign(null, bytes, key).toString('base64url')}`;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aventurine-manage-account-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── parseLicense ────────────────────────────────────────────────────────────

test('license: a genuine license reads back as signed', () => {
  assert.deepEqual(policy.parseLicense(sign(payload()), PUBLIC_KEY), payload());
});

test('license: an edited payload, another key, or a malformed token is rejected', () => {
  const genuine = sign(payload({ active: false }));
  const forgedBody = Buffer.from(JSON.stringify(payload({ active: true }))).toString('base64url');
  const forged = `${forgedBody}.${genuine.split('.')[1]}`;
  assert.equal(policy.parseLicense(forged, PUBLIC_KEY), null);

  const otherKey = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(policy.parseLicense(sign(payload(), otherKey), PUBLIC_KEY), null);

  for (const bad of [null, '', 'nodot', 'a.b.c', '!!.??', 42]) {
    assert.equal(policy.parseLicense(bad, PUBLIC_KEY), null, String(bad));
  }
});

test('license: a signed payload of the wrong shape or version is rejected', () => {
  for (const overrides of [{ v: 2 }, { email: '' }, { active: 'yes' }, { validUntil: 'soon' }, { renewsAt: -1 }, { tier: 'gold' }]) {
    assert.equal(policy.parseLicense(sign(payload(overrides)), PUBLIC_KEY), null, JSON.stringify(overrides));
  }
});

test('license: the shipped public key is a valid Ed25519 key', () => {
  const key = crypto.createPublicKey({ key: Buffer.from(policy.LICENSE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});

// ── describeLicense ─────────────────────────────────────────────────────────

test('describe: signed out is locked', () => {
  assert.deepEqual(policy.describeLicense(null, NOW), { signedIn: false, tier: 'none', unlocked: false, pro: false });
});

test('describe: an active license unlocks until its offline period runs out', () => {
  const p = payload();
  assert.equal(policy.describeLicense(p, NOW).unlocked, true);
  assert.equal(policy.describeLicense(p, p.validUntil - 1).unlocked, true);
  const lapsed = policy.describeLicense(p, p.validUntil);
  assert.equal(lapsed.unlocked, false);
  assert.equal(lapsed.active, true, 'still says what the server last said');
  assert.equal(lapsed.signedIn, true);
});

test('describe: an inactive license never unlocks', () => {
  const s = policy.describeLicense(payload({ active: false, status: 'canceled', validUntil: NOW + DAY }), NOW);
  assert.equal(s.unlocked, false);
  assert.equal(s.status, 'canceled');
  assert.equal(s.email, 'alice@example.com');
});

test('describe: the tier comes from the license, and runs out with it', () => {
  const basic = policy.describeLicense(payload({ tier: 'basic' }), NOW);
  assert.deepEqual([basic.tier, basic.unlocked, basic.pro], ['basic', true, false]);
  const pro = policy.describeLicense(payload({ tier: 'pro' }), NOW);
  assert.deepEqual([pro.tier, pro.unlocked, pro.pro], ['pro', true, true]);

  const expired = policy.describeLicense(payload({ tier: 'pro' }), NOW + 30 * DAY);
  assert.deepEqual([expired.tier, expired.unlocked, expired.pro, expired.paidTier], ['none', false, false, 'pro']);

  // Signed before tiers existed: Basic, never more, until the next check.
  assert.equal(policy.describeLicense(payload(), NOW).tier, 'basic');
  // A lapsed subscription is no tier whatever the license names.
  assert.equal(policy.describeLicense(payload({ active: false, tier: 'pro' }), NOW).tier, 'none');
});

// ── resolveLicenseConfig ────────────────────────────────────────────────────

test('config: a packaged app ignores the environment', () => {
  const env = {
    AVENTURINE_ACCOUNT_URL: 'http://127.0.0.1:8787',
    AVENTURINE_LICENSE_PUBLIC_KEY: PUBLIC_KEY,
    AVENTURINE_DEV_UNLOCK: '1',
  };
  assert.deepEqual(policy.resolveLicenseConfig({ isPackaged: true, env }), {
    origin: policy.ACCOUNT_ORIGIN, publicKey: policy.LICENSE_PUBLIC_KEY, devUnlock: null,
  });
  assert.deepEqual(policy.resolveLicenseConfig({ isPackaged: false, env }), {
    origin: 'http://127.0.0.1:8787', publicKey: PUBLIC_KEY, devUnlock: 'pro',
  });
  assert.deepEqual(policy.resolveLicenseConfig({ isPackaged: false, env: {} }), {
    origin: policy.ACCOUNT_ORIGIN, publicKey: policy.LICENSE_PUBLIC_KEY, devUnlock: null,
  });
  // Only exactly '1' (Pro) or 'basic' unlocks a dev run, and never a packaged app.
  assert.equal(policy.resolveLicenseConfig({ isPackaged: false, env: { AVENTURINE_DEV_UNLOCK: 'true' } }).devUnlock, null);
  assert.equal(policy.resolveLicenseConfig({ isPackaged: false, env: { AVENTURINE_DEV_UNLOCK: 'basic' } }).devUnlock, 'basic');
  assert.equal(policy.resolveLicenseConfig({ isPackaged: true, env: { AVENTURINE_DEV_UNLOCK: 'basic' } }).devUnlock, null);
  assert.equal(policy.resolveLicenseConfig({ isPackaged: false, env: { AVENTURINE_DEV_UNLOCK: 'constructor' } }).devUnlock, null);
});

test('config: the account server is https', () => {
  assert.match(policy.ACCOUNT_ORIGIN, /^https:\/\/[^/]+$/);
  assert.match(policy.PRICING_URL, /^https:\/\//);
});

// ── The saved sign-in ───────────────────────────────────────────────────────

test('account file: missing reads as signed out, silently', (t) => {
  const errors = [];
  assert.equal(policy.readAccountFile(tempDir(t), { onError: (e) => errors.push(e) }), null);
  assert.equal(errors.length, 0);
});

test('account file: round-trips, readable by this user only', (t) => {
  const dir = tempDir(t);
  const saved = { token: TOKEN, license: sign(payload()) };
  policy.writeAccountFile(dir, saved);
  assert.deepEqual(policy.readAccountFile(dir), saved);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, policy.ACCOUNT_FILE)).mode & 0o777, 0o600);
  }
  policy.deleteAccountFile(dir);
  assert.equal(policy.readAccountFile(dir), null);
  policy.deleteAccountFile(dir);
});

test('account file: a malformed file reads as signed out and is reported', (t) => {
  const dir = tempDir(t);
  for (const body of ['{not json', JSON.stringify({ token: 'short', license: 'x.y' }), JSON.stringify({ token: TOKEN })]) {
    fs.writeFileSync(path.join(dir, policy.ACCOUNT_FILE), body);
    const errors = [];
    assert.equal(policy.readAccountFile(dir, { onError: (e) => errors.push(e) }), null, body);
    assert.equal(errors.length, 1, body);
  }
});

test('account file: refuses to save a malformed token', (t) => {
  assert.throws(() => policy.writeAccountFile(tempDir(t), { token: 'nope', license: 'x.y' }), TypeError);
});
