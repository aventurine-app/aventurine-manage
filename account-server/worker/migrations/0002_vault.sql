-- Aventurine Planner: end-to-end encrypted plan storage ("the vault").
--
-- The browser encrypts every plan before it is sent, with a data key that is
-- itself stored here only encrypted under the user's recovery key. Nothing in
-- these tables can be read without that recovery key, which never reaches the
-- server. What the server can see is listed in vault.js.
--
-- Times are integer milliseconds since the epoch (UTC).

-- One per account (keyed by the signed-in email, as sessions are).
CREATE TABLE vaults (
    email         TEXT PRIMARY KEY,
    id            TEXT NOT NULL,            -- random, new each time the vault is created
    wrapped_key   TEXT NOT NULL,            -- the data key, encrypted by the browser under the recovery key
    key_version   INTEGER NOT NULL,         -- bumped each time wrapped_key is replaced
    seq           INTEGER NOT NULL DEFAULT 0, -- change counter: each item write takes the next value
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL          -- last use with access; the retention clock (vault.js)
);

-- The encrypted records: one per plan, plus whatever else the app keeps (tab
-- order, goals). The id is chosen by the browser; data is ciphertext, or NULL
-- once the item is deleted, so other devices learn of the deletion.
CREATE TABLE vault_items (
    email       TEXT NOT NULL,
    id          TEXT NOT NULL,
    version     INTEGER NOT NULL,           -- bumped on each write; a write must name the version it replaces
    seq         INTEGER NOT NULL,           -- the vault's seq at this write; "what changed since N"
    data        TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (email, id)
);
CREATE INDEX vault_items_seq ON vault_items (email, seq);
