'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    themeIdFromFile, prettifyId, readName, describeTheme, compareThemes, builtinsToSeed,
} = require('../../themePolicy');

const BUILTIN_DIR = path.resolve(__dirname, '../../../static/themes');

test('theme file names: .css, not hidden, no separators', () => {
    assert.equal(themeIdFromFile('gruvbox.css'), 'gruvbox');
    assert.equal(themeIdFromFile('My Theme.CSS'), 'My Theme');
    assert.equal(themeIdFromFile('.seeded.json'), null);
    assert.equal(themeIdFromFile('.hidden.css'), null);
    assert.equal(themeIdFromFile('notes.txt'), null);
    assert.equal(themeIdFromFile('../evil.css'), null);
    assert.equal(themeIdFromFile('a\\b.css'), null);
    assert.equal(themeIdFromFile('.css'), null);
});

test('display name: @name line, else the id title-cased', () => {
    assert.equal(readName('/* @name Solarized Warm */\n:root{}'), 'Solarized Warm');
    assert.equal(readName('/*\n * @name  Night Owl\n * more\n */'), 'Night Owl');
    assert.equal(readName(':root{}'), null);
    assert.equal(prettifyId('my-cool_theme'), 'My Cool Theme');
    assert.equal(describeTheme('night-owl', ':root{}').name, 'Night Owl');
});

test('swatch colours come from each half, following var() chains', () => {
    const css = `
        /* :root[data-mode="light"] { --color-primary: #bad; } is a comment */
        :root[data-mode="light"] {
            --blue-6: #205ea6;
            --color-bg-layout: #f2f0e5;
            --color-bg-container: #fffcf0;
            --color-primary: var(--blue-6);
        }
        :root[data-mode='dark'], :root[data-mode="light"] .x { --color-bg-layout: #100f0f; }
        :root[data-mode="dark"] .card { --color-primary: #000; }
        :root[data-mode="dark"] {
            --color-primary: var(--missing, #4385be);
            --color-bg-container: url(evil);
        }`;
    const { preview } = describeTheme('t', css);
    assert.deepEqual(preview.light, { bg: '#f2f0e5', surface: '#fffcf0', accent: '#205ea6' });
    // url() is not a colour function the picker will inline; the descendant
    // rule is not the half itself.
    assert.deepEqual(preview.dark, { bg: '#100f0f', surface: null, accent: '#4385be' });
});

test('unsafe or unresolvable swatch values are left for the default', () => {
    const css = `:root[data-mode="light"] {
        --color-bg-layout: red; --color-bg-container: "x"; --color-primary: var(--a);
        --a: var(--b); --b: var(--a);
    }`;
    assert.deepEqual(describeTheme('t', css).preview.light, { bg: 'red', surface: null, accent: null });
});

test('picker order is by name, case-insensitive', () => {
    const list = [{ id: 'b', name: 'oblivion' }, { id: 'a', name: 'Flexoki' }, { id: 'c', name: 'Gruvbox' }];
    assert.deepEqual(list.sort(compareThemes).map((t) => t.id), ['a', 'c', 'b']);
});

test('built-ins are seeded once: a deleted one stays deleted, a new one arrives', () => {
    assert.deepEqual(builtinsToSeed(['a.css', 'b.css', 'README'], []), ['a.css', 'b.css']);
    assert.deepEqual(builtinsToSeed(['a.css', 'b.css', 'c.css'], ['a.css', 'b.css']), ['c.css']);
    assert.deepEqual(builtinsToSeed(['a.css'], ['a.css']), []);
});

test('every built-in theme has a name and both halves for the swatch', () => {
    const files = fs.readdirSync(BUILTIN_DIR).filter((f) => themeIdFromFile(f));
    assert.deepEqual(files.sort(), ['flexoki.css', 'gruvbox.css', 'oblivion.css']);
    for (const file of files) {
        const css = fs.readFileSync(path.join(BUILTIN_DIR, file), 'utf8');
        const theme = describeTheme(themeIdFromFile(file), css);
        assert.equal(readName(css), theme.name, `${file} has an @name`);
        for (const mode of ['light', 'dark']) {
            for (const [key, value] of Object.entries(theme.preview[mode])) {
                assert.match(value ?? '', /^#[0-9a-f]{6}$/i, `${file} ${mode} ${key}`);
            }
        }
        // Every rule is scoped to a half, so a file can never leak into the
        // other mode or into Default.
        const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+(?=\{)/g);
        for (const sel of selectors) {
            for (const part of sel.split(',')) {
                assert.match(part.trim(), /^:root\[data-mode="(light|dark)"\]/, `${file}: ${part.trim()}`);
            }
        }
    }
});
