-- Per-token transport deny-lists (PLAN §9).
ALTER TABLE tokens ADD COLUMN deny_transports TEXT;
