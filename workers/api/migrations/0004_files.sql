-- Attachments stored in R2 (key att/<id>); served from /file/<id>/<name> until expires.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX files_expires ON files(expires);
