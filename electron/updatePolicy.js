'use strict';

// ─── Update policy ──────────────────────────────────────────────────────────
//
// The decisions behind software updates, kept free of Electron so the test
// suite can run them under plain Node (backend/__tests__/updatePolicy.test.js).
// electron/updater.js does the I/O and the IPC; this file answers:
//
//   • How can this install take an update?            resolveUpdateMode
//   • Is a published version newer than this one?     isNewerVersion
//   • What did the latest-release API answer?         parseLatestRelease
//   • Does the user want automatic updates?           read/writeUpdatePreferences
//   • Which command installs a downloaded .deb/.rpm?   packageInstallCommand
//
// The preference lives in its own small JSON file in the profile, not in the
// database's app_settings table: it belongs to the install rather than to any
// one database, and the first automatic check runs before a database is
// unlocked.

const fs = require('fs');
const path = require('path');

// The feed. electron-builder.yml's `publish:` block names the same repository;
// change both together or the in-place updater and the notify-only check will
// read different release lists.
const RELEASE_OWNER = 'aventurine-app';
const RELEASE_REPO = 'aventurine-manage';

const LATEST_RELEASE_API =
    `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
// Fixed, not taken from the API response: this URL is opened in the user's
// browser, so nothing a server sends can change where that goes.
const DOWNLOAD_PAGE_URL =
    `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;

// How this install can apply an update:
//   'replace'  Swap the app in place with no prompt: the per-user Windows
//              installer, or an AppImage replacing its own file.
//   'package'  Hand a .deb/.rpm to the system package manager. That needs an
//              administrator password, so it only ever runs when the user
//              clicks Restart & Install, never silently on quit.
//   'notify'   Can't update itself, so say a new version exists and link to
//              the download page. macOS lands here because the builds are
//              ad-hoc signed and the macOS updater refuses anything without a
//              Developer ID signature; so do dev runs and unrecognised Linux
//              installs (an unpacked directory, a distro repackage).
//
// The Linux checks mirror how electron-updater picks its own updater (its
// main.js): a `package-type` file written by electron-builder's deb/rpm
// targets wins, otherwise the APPIMAGE variable the AppImage runtime sets.
function resolveUpdateMode({ platform, isPackaged, env = {}, packageType = null }) {
    if (!isPackaged) return 'notify';
    if (platform === 'win32') return 'replace';
    if (platform === 'linux') {
        if (packageType === 'deb' || packageType === 'rpm') return 'package';
        if (env.APPIMAGE) return 'replace';
    }
    return 'notify';
}

// Release tags are plain MAJOR.MINOR.PATCH with an optional leading "v"
// (release.yml cuts them from `v*` tags). Anything else, including
// pre-release suffixes, is not something this app offers as an update, so it
// parses to null rather than being guessed at.
const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

function parseVersion(text) {
    if (typeof text !== 'string') return null;
    const m = VERSION_RE.exec(text.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

// The one field read from GitHub's /releases/latest answer. That endpoint
// already skips drafts and pre-releases, which is what keeps an unpublished
// draft from reaching anyone. Throws on a body that doesn't carry a version
// we understand, so a changed or broken API shows up as a failed check
// rather than as "up to date".
function parseLatestRelease(body) {
    const version = parseVersion(body && body.tag_name);
    if (!version) throw new Error('latest release has no usable version tag');
    return { version: version.join('.') };
}

// ── Preferences ─────────────────────────────────────────────────────────────

const PREFERENCES_FILE = 'update-preferences.json';

// On by default: the point of the feature is that people stay current
// without having to remember to look.
const DEFAULT_PREFERENCES = Object.freeze({ autoUpdate: true });

// A missing file is the normal first-run case. An unreadable or malformed one
// falls back to the defaults too, but is reported, because it means a
// preference the user set has been lost.
function readUpdatePreferences(dir, { onError = () => {} } = {}) {
    const file = path.join(dir, PREFERENCES_FILE);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code !== 'ENOENT') onError(err);
        return { ...DEFAULT_PREFERENCES };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            autoUpdate: typeof parsed.autoUpdate === 'boolean'
                ? parsed.autoUpdate
                : DEFAULT_PREFERENCES.autoUpdate,
        };
    } catch (err) {
        onError(err);
        return { ...DEFAULT_PREFERENCES };
    }
}

// Write-then-rename, so a crash mid-write leaves the previous file intact
// instead of a truncated one that would read back as the defaults. Throws, so
// the caller can tell the user the change wasn't saved.
function writeUpdatePreferences(dir, prefs) {
    if (typeof prefs.autoUpdate !== 'boolean') {
        throw new TypeError('autoUpdate must be a boolean');
    }
    const file = path.join(dir, PREFERENCES_FILE);
    const tmp = `${file}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ autoUpdate: prefs.autoUpdate }));
    fs.renameSync(tmp, file);
}

// ─── Package install command ────────────────────────────────────────────────
//
// In 'package' mode the downloaded .deb/.rpm goes to the system package manager.
// electron-updater does that with spawnSync, which freezes the main process for
// the whole password prompt and transaction; GNOME and KDE then flag the window
// as not responding. updater.js runs this command asynchronously instead.
//
// The same package managers, in the same order, as electron-updater's
// RpmUpdater/DebUpdater. The file path goes in as "$1", never spliced into the
// script, so no character in it can change the command. A failed dpkg is
// followed by apt-get -f in the same shell, so the user is asked for their
// password once rather than twice.
//
// Returns the argv to spawn, or null when this system has no package manager
// for the type, or no graphical way to ask for a password (updater.js then falls
// back to electron-updater's own install).
//   hasCommand(name) → boolean: is `name` on PATH?
//   isRoot: already running as root, so no pkexec

const PACKAGE_INSTALL_SCRIPTS = {
    rpm: [
        ['zypper', 'zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$1"'],
        ['dnf',    'dnf install --nogpgcheck -y "$1"'],
        ['yum',    'yum install --nogpgcheck -y "$1"'],
        ['rpm',    'rpm -Uvh --replacepkgs --replacefiles --nodeps "$1"'],
    ],
    deb: [
        ['dpkg', 'dpkg -i "$1" || apt-get install -f -y'],
        ['apt',  'apt install -y --allow-unauthenticated --allow-downgrades --allow-change-held-packages "$1"'],
    ],
};

function packageInstallCommand({ packageType, installerPath, hasCommand, isRoot = false }) {
    const candidates = PACKAGE_INSTALL_SCRIPTS[packageType];
    if (!candidates || typeof installerPath !== 'string' || !path.isAbsolute(installerPath)) return null;
    const found = candidates.find(([name]) => hasCommand(name));
    if (!found) return null;
    const shell = ['/bin/bash', '-c', found[1], 'bash', installerPath];
    if (isRoot) return shell;
    // --disable-internal-agent: never fall back to a text prompt on a terminal
    // nobody is looking at; the desktop's polkit agent asks instead.
    return hasCommand('pkexec') ? ['pkexec', '--disable-internal-agent', ...shell] : null;
}

module.exports = {
    packageInstallCommand,
    LATEST_RELEASE_API,
    DOWNLOAD_PAGE_URL,
    DEFAULT_PREFERENCES,
    PREFERENCES_FILE,
    resolveUpdateMode,
    parseVersion,
    isNewerVersion,
    parseLatestRelease,
    readUpdatePreferences,
    writeUpdatePreferences,
};
