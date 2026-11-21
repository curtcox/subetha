-- SubEtha D1 schema v1. Balances live in AccountDO; D1 holds the directory and the ledger journal.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                -- acct_<ulid>
  handle TEXT UNIQUE,                 -- @handle namespace, lower case
  clerk_id TEXT UNIQUE,               -- Clerk user or org id
  email TEXT,
  topups_12mo_micros INTEGER NOT NULL DEFAULT 0,
  daily_cap_micros INTEGER,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,                -- tok id (embedded in the token string)
  account_id TEXT NOT NULL REFERENCES accounts(id),
  secret_hash TEXT NOT NULL,          -- hex sha256 of the secret part
  name TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL,               -- JSON array, e.g. ["publish:@alice/*"]
  transports TEXT,                    -- JSON array allow-list or NULL = all
  daily_cap_micros INTEGER,
  total_cap_micros INTEGER,
  origins TEXT,                       -- JSON array of allowed Origin values (publishable tokens)
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX tokens_account ON tokens(account_id);

CREATE TABLE topics (
  name TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id),
  policy TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX topics_owner ON topics(owner_account_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,                -- dev_<base32 pubkey>
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,                -- ep_<ulid>
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,                 -- email | sms | voice | webhook | slack | webpush | apns | fcm | lxmf | mcp
  address TEXT NOT NULL,              -- email, E.164 number, URL, channel id, subscription JSON…
  config TEXT NOT NULL DEFAULT '{}',
  verify_code_hash TEXT,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX endpoints_account ON endpoints(account_id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                -- sub_<ulid>
  topic TEXT NOT NULL REFERENCES topics(name),
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
  filter TEXT NOT NULL DEFAULT '{}',
  after_s INTEGER NOT NULL DEFAULT 0,
  min_priority INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_topic ON subscriptions(topic);

CREATE TABLE ledger_journal (
  account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  ref TEXT NOT NULL,
  available_after INTEGER NOT NULL,
  reserved_after INTEGER NOT NULL,
  time INTEGER NOT NULL,
  meta TEXT,
  PRIMARY KEY (account_id, seq)
);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  account_id TEXT,
  amount_micros INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  time INTEGER NOT NULL
);
CREATE INDEX audit_account ON audit_log(account_id, time);
