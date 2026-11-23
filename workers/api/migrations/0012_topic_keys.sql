-- Wrapped E2EE topic keys (spec §5.1): sealed to one device each; the relay can't open them.
CREATE TABLE topic_keys (
  topic TEXT NOT NULL,
  kid TEXT NOT NULL,
  device_id TEXT NOT NULL,            -- recipient ("to")
  account_id TEXT NOT NULL,           -- the topic owner who uploaded it
  wrapped TEXT NOT NULL,              -- the wrapped-key JSON object as uploaded
  created_at INTEGER NOT NULL,
  PRIMARY KEY (topic, kid, device_id)
);
CREATE INDEX topic_keys_device ON topic_keys(device_id);
