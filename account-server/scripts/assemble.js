'use strict';

// ─── assemble.js ────────────────────────────────────────────────────────────
// Builds the account server's one page (pages/auth/privacy.html): each
// <!-- @include name --> marker is replaced by pages/partials/name.html, and
// the version from package.json is written in as <meta name="prism-version">.
//
// Every script, stylesheet and icon the page names gets its content's hash as
// a query (`/static/js/auth/privacy.js?v=3f9a…`). The worker lets the browser
// keep such a file for a year, because a change to the file changes its
// address; the page itself is always fetched fresh.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(APP_ROOT, 'pages');
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');
const STATIC_DIR = path.join(APP_ROOT, 'static');

const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

/** The version, from package.json. */
function readVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version);
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The page with its partials spliced in. A missing partial throws, so a bad build fails loudly. */
function assembleSource(page, version) {
    const source = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    const html = source.replace(INCLUDE_RE, (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'));
    return html.replace('</head>', `    <meta name="prism-version" content="${escapeAttr(version)}">\n</head>`);
}

/** The finished page as a string. */
function assemblePage({ page = 'auth/privacy.html', version = readVersion() } = {}) {
    return versionAssets(assembleSource(page, version));
}

// ── Versioned files ─────────────────────────────────────────────────────────

const ASSET_RE = /((?:src|href)=")(\/static\/[^"?]+)(")/g;
const HASH_LENGTH = 10;

/** The file on disk that a page's `/static/…` address names. */
const assetFile = (urlPath) => path.join(STATIC_DIR, urlPath.slice('/static/'.length));

/** The first HASH_LENGTH hex digits of the SHA-256 of `file`'s content, or null if it is missing. */
function assetHash(file) {
    if (!fs.existsSync(file)) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, HASH_LENGTH);
}

/** `html` with each file it names given its content's hash as `?v=`. A missing file is left for build.js to catch. */
function versionAssets(html) {
    return html.replace(ASSET_RE, (match, lead, urlPath, tail) => {
        const hash = assetHash(assetFile(urlPath));
        return hash ? `${lead}${urlPath}?v=${hash}${tail}` : match;
    });
}

/** A page address without its version: '/static/js/auth/privacy.js?v=3f9a…' → '/static/js/auth/privacy.js'. */
const unversioned = (urlPath) => urlPath.replace(/\?v=[0-9a-f]+$/, '');

module.exports = { assemblePage, assetFile, readVersion, unversioned, APP_ROOT };
