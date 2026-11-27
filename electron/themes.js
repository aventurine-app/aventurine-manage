'use strict';

// ─── themes.js ──────────────────────────────────────────────────────────────
// Theme files: the user's themes folder (<userData>/themes), its seeding from
// the built-in files (static/themes/), the picker's IPC, and a watcher that
// tells open windows when a file changes, so an edit repaints the app as soon
// as it is saved. The rules (file names, names, swatches) are themePolicy.js.
//
// The page loads the chosen file from app://aventurine/themes/<id>.css; the
// protocol handler in main.js calls readThemeFile() below, which reads only
// theme files directly inside the folder. The Default theme is not a file: it
// is static/css/theme.css, always loaded under whichever file is chosen.

const { app, ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const {
    MAX_THEME_BYTES, themeIdFromFile, describeTheme, compareThemes, builtinsToSeed,
} = require('./themePolicy');

/** The record of built-ins already copied in, so a deleted one stays deleted. */
const SEEDED_FILE = '.seeded.json';

let themesDir = null;

function readSeeded() {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(themesDir, SEEDED_FILE), 'utf8'));
        return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
    } catch { return []; }
}

/** Copy in each built-in not seeded before. Never overwrites a file the user
 *  already has under the same name. */
function seed(builtinDir) {
    fs.mkdirSync(themesDir, { recursive: true });
    let builtins = [];
    try { builtins = fs.readdirSync(builtinDir); } catch { return; }
    const seeded = readSeeded();
    const todo = builtinsToSeed(builtins, seeded);
    if (!todo.length) return;
    for (const file of todo) {
        try {
            fs.copyFileSync(path.join(builtinDir, file), path.join(themesDir, file), fs.constants.COPYFILE_EXCL);
        } catch (err) {
            if (err.code !== 'EEXIST') console.error('[themes] seeding', file, 'failed:', err.message);
        }
    }
    fs.writeFileSync(path.join(themesDir, SEEDED_FILE), JSON.stringify([...seeded, ...todo], null, 2));
}

/** Every theme in the folder, sorted for the picker. A file that cannot be
 *  read is left out rather than failing the list. */
async function listThemes() {
    let names = [];
    try { names = await fs.promises.readdir(themesDir); } catch { return []; }
    const themes = [];
    for (const file of names) {
        const id = themeIdFromFile(file);
        if (!id) continue;
        const css = await readThemeFile(file);
        if (css !== null) themes.push(describeTheme(id, css));
    }
    return themes.sort(compareThemes);
}

/** A theme file's text by file name, or null: not a theme file name, not in
 *  the folder, too big, or unreadable. Shared by the list and app://. */
async function readThemeFile(fileName) {
    if (!themesDir || !themeIdFromFile(fileName)) return null;
    const file = path.join(themesDir, fileName);
    if (path.dirname(file) !== themesDir) return null;
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > MAX_THEME_BYTES) return null;
        return await fs.promises.readFile(file, 'utf8');
    } catch { return null; }
}

/** Tell every window the folder changed, once per burst of events (an editor's
 *  save is often several). */
function watch() {
    let timer = null;
    const notify = () => {
        timer = null;
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('themes:changed');
        }
    };
    try {
        const watcher = fs.watch(themesDir, (_event, file) => {
            if (file && !themeIdFromFile(String(file))) return;
            clearTimeout(timer);
            timer = setTimeout(notify, 150);
        });
        watcher.on('error', (err) => console.error('[themes] watcher stopped:', err.message));
        app.on('will-quit', () => watcher.close());
    } catch (err) {
        console.error('[themes] cannot watch the themes folder:', err.message);
    }
}

/** Call once the app is ready (userData is final by then). */
function initThemes({ builtinDir }) {
    themesDir = path.join(app.getPath('userData'), 'themes');
    try { seed(builtinDir); } catch (err) { console.error('[themes] seeding failed:', err.message); }

    ipcMain.handle('themes:list', () => listThemes());
    // shell.openPath resolves to '' on success, else an error message.
    ipcMain.handle('themes:open-folder', async () => {
        fs.mkdirSync(themesDir, { recursive: true });
        const err = await shell.openPath(themesDir);
        return err ? { ok: false, error: err } : { ok: true };
    });
    watch();
}

module.exports = { initThemes, readThemeFile };
