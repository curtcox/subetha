// Types for the parts of the vendored @devicebasedauth/verify that subetha uses (site.js is the
// unmodified JavaScript; these declarations are ours).
export interface DbaPayload {
  iss: string; sub: string; acct: string; aud: string | string[]; cid: string; jti: string;
  iat: number; nbf?: number; exp: number;
  cnf?: { jkt: string };
  device?: { name?: string; [k: string]: unknown };
  grants: Array<{ actions?: string[]; resources?: string[]; [k: string]: unknown }>;
  status: { status_list: { idx: number; uri: string } };
  [k: string]: unknown;
}
export interface DbaProof { jti: string; jkt: string; iat: number; [k: string]: unknown }
export type SiteAuthResult =
  | { ok: false; status: number; code: string; message?: string; dba_account?: string }
  | {
      ok: true; userId: string; dbaAccount: string; deviceId: string; credentialId: string; kind: "device" | "access";
      session: boolean; scopes: string[]; caveats: { spend_usd_per_month?: number };
      payload: DbaPayload; proof: DbaProof | null;
    };
export interface Verifier {
  isRevoked(payload: { status: { status_list: { idx: number; uri: string } } }): Promise<boolean>;
}
export interface SiteAuth {
  authenticate(request: Request): Promise<SiteAuthResult | null>;
  allows(result: SiteAuthResult, action: string, resource?: string): boolean;
  verifier: Verifier;
}
export function createSiteAuth(options: {
  audience: string; namespace: string; scopes: string[];
  linkedUser: (dbaAccount: string, ctx: { request: Request; payload: DbaPayload; kind: string }) => Promise<string | null>;
  issuer?: string; fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number; replay?: false; statusTtl?: number; jwksTtl?: number; failureBackoff?: number;
}): SiteAuth;
export interface OidcState { state: string; nonce: string; verifier: string }
export function createOidcClient(options: {
  clientId: string; redirectUri: string; issuer?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number;
}): {
  begin(options?: { scope?: string }): Promise<{ url: string; state: OidcState }>;
  finish(params: URLSearchParams | string, saved: OidcState): Promise<{ sub: string; acct?: string; [k: string]: unknown }>;
};
