-- One verification code per destination per hour, across accounts (security review: the KV
-- throttle was eventually consistent). A conditional upsert claims the slot atomically.
CREATE TABLE verify_sends (
  dest TEXT PRIMARY KEY,      -- "<kind>:<lowercased address>"
  sent_at INTEGER NOT NULL    -- ms
);
