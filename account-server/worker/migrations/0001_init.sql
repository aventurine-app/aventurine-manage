-- Aventurine Planner: billing state mirrored from Paddle, plus sign-in state.
--
-- Times are integer milliseconds since the epoch (UTC). Paddle ids are stored
-- as given. Nothing here holds a plan: plans never leave the user's browser.

-- A Paddle customer and the email they signed up with (lower-cased). Written
-- by customer.created / customer.updated events, which are the only Paddle
-- events that carry an email.
CREATE TABLE customers (
    id          TEXT PRIMARY KEY,           -- ctm_...
    email       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL            -- occurred_at of the last event applied
);
CREATE INDEX customers_email ON customers (email);

-- A Paddle subscription. Written by subscription.* events.
CREATE TABLE subscriptions (
    id           TEXT PRIMARY KEY,          -- sub_...
    customer_id  TEXT NOT NULL,
    status       TEXT NOT NULL,             -- active, trialing, past_due, paused, canceled
    price_id     TEXT,
    period_end   INTEGER,                   -- end of the paid period
    cancel_at    INTEGER,                   -- when a scheduled cancellation takes effect
    updated_at   INTEGER NOT NULL           -- occurred_at of the last event applied
);
CREATE INDEX subscriptions_customer ON subscriptions (customer_id);

-- One-time sign-in links. Only a hash of the token is kept, so a copy of this
-- table cannot sign anyone in.
CREATE TABLE login_tokens (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);

-- Signed-in browsers. Again only a hash of the cookie value is kept.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_email ON sessions (email);
