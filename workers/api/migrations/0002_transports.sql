-- Slack installs and channel ↔ topic bindings.
CREATE TABLE slack_teams (
  team_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  team_name TEXT NOT NULL DEFAULT '',
  bot_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, account_id)
);

CREATE TABLE slack_bindings (
  team_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  topic TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  endpoint_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel)
);

CREATE INDEX subscriptions_endpoint ON subscriptions(endpoint_id);
CREATE INDEX endpoints_address ON endpoints(kind, address);
