-- Aventurine Planner: requests to see or delete personal data (privacy.js).
--
-- Times are integer milliseconds since the epoch (UTC).

-- Emailed links that prove someone owns an address. Only a hash of the token is
-- kept, as for sign-in links. Rows are dropped a day after they are made, which
-- is also how long the per-address limit counts them.
CREATE TABLE privacy_links (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX privacy_links_email ON privacy_links (email, created_at);

-- Confirmed deletions that have not finished. A row normally lasts a moment; it
-- stays only if a step failed, and the daily job tries again.
CREATE TABLE erasure_queue (
    email         TEXT PRIMARY KEY,
    requested_at  INTEGER NOT NULL,
    notified_at   INTEGER                   -- when the checklist reached the support inbox
);

-- A hash of each erased Paddle customer id, kept for 30 days so that Paddle's
-- late webhooks cannot write the customer back (paddle.js).
CREATE TABLE erased_customers (
    customer_hash  TEXT PRIMARY KEY,
    erased_at      INTEGER NOT NULL
);

-- The log of requests that California's rules ask us to keep for 24 months.
-- Deliberately holds nothing that says whose request it was.
CREATE TABLE privacy_requests (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL,            -- access, delete
    received_at   INTEGER NOT NULL,
    completed_at  INTEGER NOT NULL
);
