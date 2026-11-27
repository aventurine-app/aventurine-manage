'use strict';

// ─── themePolicy.js ─────────────────────────────────────────────────────────
// The pure rules behind theme files (electron/themes.js does the I/O). A theme
// is one .css file in the user's themes folder; its id is the file name less
// ".css", its display name the file's `@name` line (the id, title-cased, when
// there is none), and its picker swatch the page, card and accent colours its
// light and dark halves declare:
//
//   :root[data-mode="light"] { --color-bg-layout: …; --color-bg-container: …;
//                              --color-primary: …; }
//   :root[data-mode="dark"]  { … }
//
// Nothing here runs the CSS. The swatch colours are read with a deliberately
// small parser (top-level rules, custom properties, var() chains within the
// same half), and any value it cannot read is left null, so the picker shows
// the Default theme's colour for it rather than guessing.

/** A theme file name: not hidden, no path separators, ends in .css. */
const THEME_FILE_RE = /^[^./\\][^/\\]{0,79}\.css$/i;

/** Largest theme file read or served, in bytes. */
const MAX_THEME_BYTES = 1024 * 1024;

/** The keys a swatch is drawn from, and the token each is read from. */
const PREVIEW_TOKENS = {
    bg:      '--color-bg-layout',
    surface: '--color-bg-container',
    accent:  '--color-primary',
};

/** A colour value safe to set as an inline custom property: a hex, a colour
 *  function with no quotes or braces in it, or a bare keyword. */
const SAFE_COLOR_RE = /^(#[0-9a-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^;{}<>"'\\]*\)|[a-z]+)$/i;

/** The theme id for a file name, or null when it is not a theme file. */
function themeIdFromFile(fileName) {
    return THEME_FILE_RE.test(fileName) ? fileName.slice(0, -4) : null;
}

/** "my-theme_2" → "My Theme 2". */
function prettifyId(id) {
    return id.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()) || id;
}

/** The file's `@name` value (first 4 KB, inside a comment), else null. */
function readName(css) {
    const m = /@name[ \t]+([^\n\r]*?)[ \t]*(?:\*\/|[\r\n])/.exec(css.slice(0, 4096));
    if (!m) return null;
    const name = m[1].replace(/^\*+\s*/, '').trim().slice(0, 60);
    return name || null;
}

/** Custom properties per mode, from the top-level `:root[data-mode=…]` rules.
 *  Later declarations win, as in the cascade. */
function readModeTokens(css) {
    const out = { light: new Map(), dark: new Map() };
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const RULE_RE = /([^{}]+)\{([^{}]*)\}/g;
    let rule;
    while ((rule = RULE_RE.exec(bare))) {
        const modes = rule[1].split(',')
            .map((s) => /^:root\[data-mode=(["']?)(light|dark)\1\]$/.exec(s.trim().replace(/\s+/g, '')))
            .filter(Boolean)
            .map((m) => m[2]);
        if (!modes.length) continue;
        const DECL_RE = /(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g;
        let decl;
        while ((decl = DECL_RE.exec(rule[2]))) {
            for (const mode of modes) out[mode].set(decl[1], decl[2].replace(/\s*!important$/i, ''));
        }
    }
    return out;
}

/** Follow var() chains within one half; null when the chain leaves the file
 *  or runs too deep. */
function resolveToken(tokens, name, depth = 0) {
    if (depth > 8) return null;
    const value = tokens.get(name);
    if (value === undefined) return null;
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value);
    if (!ref) return value;
    const inner = resolveToken(tokens, ref[1], depth + 1);
    return inner ?? (ref[2] ? ref[2].trim() : null);
}

/** { bg, surface, accent } for one half, each a safe colour string or null. */
function previewFor(tokens) {
    const out = {};
    for (const [key, token] of Object.entries(PREVIEW_TOKENS)) {
        const v = resolveToken(tokens, token);
        out[key] = v && SAFE_COLOR_RE.test(v) ? v : null;
    }
    return out;
}

/** Everything the picker needs about one theme file. */
function describeTheme(id, css) {
    const tokens = readModeTokens(css);
    return {
        id,
        name: readName(css) ?? prettifyId(id),
        preview: { light: previewFor(tokens.light), dark: previewFor(tokens.dark) },
    };
}

/** Sort for the picker: by display name, then id. */
function compareThemes(a, b) {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

/** The built-in files to copy into the themes folder on this launch: those
 *  never seeded before. A built-in the user has deleted stays deleted; one
 *  added in a later version arrives once. */
function builtinsToSeed(builtinFiles, alreadySeeded) {
    const done = new Set(alreadySeeded);
    return builtinFiles.filter((f) => THEME_FILE_RE.test(f) && !done.has(f));
}

module.exports = {
    THEME_FILE_RE,
    MAX_THEME_BYTES,
    themeIdFromFile,
    prettifyId,
    readName,
    readModeTokens,
    resolveToken,
    describeTheme,
    compareThemes,
    builtinsToSeed,
};
