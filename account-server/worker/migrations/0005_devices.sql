-- Desktop sign-in for Aventurine Manage (devices.js).
--
-- The desktop app cannot hold a browser cookie, so it signs in with a 6-digit
-- code sent by email and is given a device token instead. Like the sign-in
-- links and sessions, only hashes of codes and tokens are kept.

-- Emailed 6-digit codes. Only the newest unexpired code for an address can be
-- used, and it is burned after MAX_CODE_ATTEMPTS wrong guesses.
CREATE TABLE device_codes (
    id          INTEGER PRIMARY KEY,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);
CREATE INDEX device_codes_email ON device_codes (email, created_at);

-- Signed-in desktop installs. The token asks "is this subscription still
-- active?"; it opens nothing else. expires_at moves forward on every check,
-- so an install that stops checking in is forgotten after DEVICE_IDLE_MS.
CREATE TABLE device_tokens (
    token_hash    TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL
);
CREATE INDEX device_tokens_email ON device_tokens (email);
