-- Aventurine is a desktop app with nothing hosted (2026-11-23). The web
-- Planner's sign-in and its encrypted plan sync are gone from the Worker, so
-- their tables go too. Before this ran they held no plans and no customers,
-- only one test session.
--
-- Apply only after deploying the Worker that no longer uses them: the old one
-- reads these tables on every request.

DROP TABLE IF EXISTS vault_items;
DROP TABLE IF EXISTS vaults;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS login_tokens;
