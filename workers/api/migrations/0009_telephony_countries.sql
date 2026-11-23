-- International SMS/voice are opt-in per country (PLAN §8): a JSON array of ISO codes the
-- account allows outside the US, e.g. ["CA","GB"]. NULL = US only.
ALTER TABLE accounts ADD COLUMN telephony_countries TEXT;
