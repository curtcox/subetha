-- Sign in with devicebasedauth.org (PLAN D5): the console signs people in through DBA's OpenID
-- Connect directly, with no Clerk. Pending sign-ins hold the OIDC state, nonce and PKCE verifier;
-- single use, 10 minutes. The DBA account then names the subetha account through dba_links.
CREATE TABLE dba_signin_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
