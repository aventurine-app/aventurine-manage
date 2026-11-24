-- Beta signup (beta.js): a free Pro license for the first BETA_LIMIT people.
--
-- Joining on aventurine-app.com/pricing.html reserves a spot. The spot is
-- claimed the first time that address signs in to Aventurine Manage, which
-- is also when we know the address is really theirs (the emailed code). A
-- spot not claimed within BETA_HOLD_MS is dropped by the daily job, so a
-- mistyped or made-up address does not keep a spot forever. Once claimed,
-- the license has no end date: the row stays until it is deleted by hand or
-- through the privacy page.
CREATE TABLE beta_members (
    email       TEXT PRIMARY KEY,
    joined_at   INTEGER NOT NULL,
    claimed_at  INTEGER
);
