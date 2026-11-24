// ─── build.js ───────────────────────────────────────────────────────────────
// Writes what the account server (worker/) serves to dist/: the privacy page
// and only the files it names.
//
//   auth/privacy.html   see or delete an address's data (worker/src/privacy.js)
//   static/…            each file that page names, and each file its
//                       stylesheets name with url()
//
// There is no bundling or minifying. Run it with `npm run build`.

const fs = require('fs');
const path = require('path');
const { assemblePage, readVersion, unversioned, assetFile, APP_ROOT } = require('./assemble');

const DIST_DIR = path.join(APP_ROOT, 'dist');
const PUBLISHED_PAGES = ['auth/privacy.html'];

const NAMED_RE = /(?:src|href)="(\/static\/[^"]+)"/g;
const CSS_URL_RE = /url\(\s*['"]?(\/static\/[^'")]+)['"]?\s*\)/g;

/** Copy `urlPath` (a /static/ address) from the source tree into `outDir`. */
function copyAsset(outDir, urlPath) {
    const from = assetFile(urlPath);
    if (!fs.existsSync(from)) throw new Error(`a published page names ${urlPath}, which does not exist`);
    const to = path.join(outDir, urlPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function build({ outDir = DIST_DIR } = {}) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const named = new Set();
    for (const page of PUBLISHED_PAGES) {
        const html = assemblePage({ page });
        const to = path.join(outDir, page);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, html);
        for (const m of html.matchAll(NAMED_RE)) named.add(unversioned(m[1]));
    }
    for (const urlPath of [...named]) {
        if (!urlPath.endsWith('.css')) continue;
        const css = fs.readFileSync(assetFile(urlPath), 'utf8');
        for (const m of css.matchAll(CSS_URL_RE)) named.add(m[1]);
    }
    for (const urlPath of named) copyAsset(outDir, urlPath);
}

function sizeOf(dir) {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        files += 1;
        bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
    return { files, bytes };
}

if (require.main === module) {
    build();
    const { files, bytes } = sizeOf(DIST_DIR);
    console.log(`Built the account server's pages ${readVersion()} to ${DIST_DIR}: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
}

module.exports = { build, DIST_DIR };
