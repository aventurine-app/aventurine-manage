-- Aventurine Planner: the email warning someone whose access has ended that
-- their encrypted plans will be deleted (vault.js, warnLapsedVaults).
--
-- When the last warning was sent, in milliseconds since the epoch (UTC), or
-- NULL. A warning counts for the lapse it was sent in: one sent before the
-- latest subscription change or use is an old lapse's, and a new one is due.
ALTER TABLE vaults ADD COLUMN warned_at INTEGER;
