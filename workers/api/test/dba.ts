// Stands in for devicebasedauth.org in tests: its issuer key (vitest.config.ts), credentials,
// revocation status lists (served from CACHE "dba-fixture:<uri>", see dba.ts dbaFetch), DPoP
// proofs, and the OpenID Connect documents for account linking.
import { env, SELF } from "cloudflare:test";
import { enrollmentProof, type DeviceKey } from "@subetha/sdk";
import { issuerSigner, signCredential, signStatusList, type IssuerSigner } from "../src/vendor/devicebasedauth/issuer.js";
import { exportPublicJwk, generateKeyPair, jwkThumbprint } from "../src/vendor/devicebasedauth/jose.js";
import { createProof } from "../src/vendor/devicebasedauth/credential.js";
import { BASE } from "./helpers.ts";

const e = env as unknown as { DB: D1Database; CACHE: KVNamespace; TEST_DBA_PRIVATE_JWK: string; DBA_JWKS: string };
export const DBA_ISSUER = "https://dba.test";
export const ALL_TOPICS = [{ actions: ["subetha:publish", "subetha:subscribe"] }];

let signer: IssuerSigner | null = null;
export async function dbaSigner(): Promise<IssuerSigner> {
  return (signer ??= await issuerSigner({ kid: "dba-test", jwk: JSON.parse(e.TEST_DBA_PRIVATE_JWK) }));
}

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");

/** Records that a DBA account is linked to a subetha account (what /v1/dba/link/finish does). */
export async function linkDba(accountId: string, dbaAccount = `acct_${rand()}`): Promise<string> {
  await e.DB.prepare("INSERT OR REPLACE INTO dba_links (dba_account, account_id, linked_at) VALUES (?, ?, ?)").bind(dbaAccount, accountId, Date.now()).run();
  await e.CACHE.delete(`dba-link:${dbaAccount}`);
  return dbaAccount;
}

async function publishStatus(uri: string, revoked: boolean) {
  const bytes = new Uint8Array(16);
  if (revoked) bytes[0] = 0x01; // index 0 (least significant bit first, like the issuer's setBit)
  await e.CACHE.put(`dba-fixture:${uri}`, await signStatusList({ uri, bytes, issuer: DBA_ISSUER }, await dbaSigner()));
}

export interface DbaDevice {
  deviceId: string;
  credentialId: string;
  credential: string;
  /** Authorization and DPoP headers for one request. */
  headers(method: string, url: string): Promise<Record<string, string>>;
  revoke(): Promise<void>;
}

/** A device enrolled at "devicebasedauth.org" with a credential for subetha.us. */
export async function dbaDevice(dbaAccount: string, opts: { grants?: unknown[]; aud?: string[]; iat?: number; name?: string; deviceId?: string } = {}): Promise<DbaDevice> {
  const keys = await generateKeyPair();
  const publicJwk = await exportPublicJwk(keys.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now;
  const deviceId = opts.deviceId ?? `dev_${rand()}`;
  const credentialId = `crd_${rand()}`;
  const uri = `https://status.dba.test/${rand()}`;
  await publishStatus(uri, false);
  const credential = await signCredential({
    iss: DBA_ISSUER, sub: deviceId, acct: dbaAccount, aud: opts.aud ?? ["subetha.us"], cid: credentialId, jti: `${credentialId}.1`,
    iat, nbf: iat, exp: now + 3600, cnf: { jkt: await jwkThumbprint(publicJwk) }, device: { name: opts.name ?? "test device" },
    grants: opts.grants ?? ALL_TOPICS, status: { status_list: { idx: 0, uri } }, ver: 1,
  }, await dbaSigner());
  return {
    deviceId, credentialId, credential,
    headers: async (method, url) => ({ authorization: `DBA ${credential}`, dpop: await createProof({ privateKey: keys.privateKey, publicJwk, method, url, credential }) }),
    revoke: () => publishStatus(uri, true),
  };
}

/** A request from a DBA device. */
export async function dbaFetch(device: DbaDevice, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${BASE}${path}`;
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(await device.headers(init.method ?? "GET", url)) };
  return SELF.fetch(url, { ...init, headers });
}

/**
 * Enrolls an Ed25519 signing key in an account the way devices now do: a DBA device of the
 * account's linked DBA account attaches it (POST /v1/devices/dba).
 */
export async function enrollDevice(accountId: string, key: DeviceKey, extra: { name?: string; capabilities?: string[] } = {}): Promise<Response> {
  const row = await e.DB.prepare("SELECT dba_account FROM dba_links WHERE account_id = ?").bind(accountId).first<{ dba_account: string }>();
  const dbaAccount = row?.dba_account ?? (await linkDba(accountId));
  const device = await dbaDevice(dbaAccount);
  return dbaFetch(device, "/v1/devices/dba", { method: "POST", body: JSON.stringify({ ...(await enrollmentProof(key)), ...extra }) });
}
