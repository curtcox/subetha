-- Daily spend cap per OAuth client (MCP agents signed in through Clerk). NULL = the default ($1);
-- 0 turns OAuth access off for the account.
ALTER TABLE accounts ADD COLUMN oauth_daily_cap_micros INTEGER;
