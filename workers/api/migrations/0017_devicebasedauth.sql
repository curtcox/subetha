-- devicebasedauth.org (PLAN §9, open question 1): devices enroll there, not here.
-- A subetha account links one DBA account (OpenID Connect); DBA device credentials for the
-- audience subetha.us then act as that account's devices.

-- One DBA account links to at most one subetha account, and one subetha account to one DBA account.
CREATE TABLE dba_links (
  dba_account TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  linked_at INTEGER NOT NULL
);

-- Pending link sign-ins: OIDC state, nonce and PKCE verifier; single use, 10 minutes.
CREATE TABLE dba_link_states (
  state TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dba_link_states_account ON dba_link_states(account_id);

-- Devices seen through DBA credentials have ids "dba:<DBA device id>". An Ed25519 signing key
-- (dev_…, for E2EE keys and signed messages) attached by a DBA device remembers that credential,
-- so revoking it at devicebasedauth.org also stops the key.
ALTER TABLE devices ADD COLUMN dba_device TEXT;
ALTER TABLE devices ADD COLUMN dba_credential TEXT;
ALTER TABLE devices ADD COLUMN dba_status_uri TEXT;
ALTER TABLE devices ADD COLUMN dba_status_idx INTEGER;
