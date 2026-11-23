-- BYO push credentials for APNs and FCM (PLAN §6).
CREATE TABLE push_credentials (
  id TEXT PRIMARY KEY,                  -- pcred_<ulid>
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,                   -- apns | fcm
  name TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL,                 -- JSON (secrets write-only; never returned by GET)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_credentials_account ON push_credentials(account_id, kind);
