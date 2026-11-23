-- Account-level monthly spend cap and transport allow/deny policies (PLAN §5, §9),
-- plus device pause kill switch and per-device transport policies (PLAN §9).
ALTER TABLE accounts ADD COLUMN monthly_cap_micros INTEGER;
ALTER TABLE accounts ADD COLUMN allow_transports TEXT;
ALTER TABLE accounts ADD COLUMN deny_transports TEXT;
ALTER TABLE devices ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN allow_transports TEXT;
ALTER TABLE devices ADD COLUMN deny_transports TEXT;
