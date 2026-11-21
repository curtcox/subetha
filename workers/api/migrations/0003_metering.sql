-- Rent metering: accounts that can't pay for their resources are frozen, then cleaned up.
ALTER TABLE accounts ADD COLUMN frozen_since INTEGER;

-- Device enrollment (code flow).
CREATE TABLE device_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  account_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
