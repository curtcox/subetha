// A stand-in for devicebasedauth.org in the e2e tests (like mock-twilio.mjs): an issuer key and its
// JWKS, OpenID Connect sign-in that approves at once (a fresh DBA account per sign-in), signed
// revocation status lists, and a browser module with the DBA SDK's enroll/headers/revoke/ready
// that the console loads from the issuer. Test-only routes:
//   POST /test/enroll  { account, jwk, aud, grants, device }  -> { credential, revoke_id }
//   POST /test/revoke/<id>
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const json = (o) => b64u(JSON.stringify(o));
const rand = (n = 10) => Array.from(randomBytes(n), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");

export function startMockDba(port) {
  const origin = `http://localhost:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e-1", alg: "ES256", use: "sig" };
  const jws = (header, payload) => {
    const input = `${json({ alg: "ES256", kid: "e2e-1", ...header })}.${json(payload)}`;
    return `${input}.${b64u(sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  const thumbprint = (k) => b64u(createHash("sha256").update(JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y })).digest());
  const codes = new Map(); // code -> { nonce, account, client_id }
  const revoked = new Set(); // status list ids

  const statusList = (id) => {
    const uri = `${origin}/status/${id}`;
    const bytes = Buffer.alloc(16);
    if (revoked.has(id)) bytes[0] = 1; // index 0
    const now = Math.floor(Date.now() / 1000);
    return jws({ typ: "statuslist+jwt" }, { iss: origin, sub: uri, iat: now, exp: now + 3600, ttl: 0, status_list: { bits: 1, lst: b64u(deflateSync(bytes)) } });
  };

  const body = (req) => new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s)); });
  const send = (res, status, data, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
    res.end(typeof data === "string" ? data : JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (url.pathname === "/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(res, 200, { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, jwks_uri: `${origin}/.well-known/jwks.json` });
    }
    if (url.pathname === "/oauth/authorize") {
      const code = rand(16);
      codes.set(code, { nonce: url.searchParams.get("nonce"), account: `acct_e2e${rand(8)}`, client_id: url.searchParams.get("client_id") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(await body(req));
      const c = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!c) return send(res, 400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, { token_type: "Bearer", id_token: jws({ typ: "JWT" }, { iss: origin, sub: c.account, acct: c.account, aud: c.client_id, nonce: c.nonce, iat: now, exp: now + 600 }) });
    }
    if (url.pathname.startsWith("/status/")) return send(res, 200, statusList(url.pathname.slice(8)), "application/statuslist+jwt");
    if (url.pathname === "/test/enroll" && req.method === "POST") {
      const r = JSON.parse(await body(req));
      const now = Math.floor(Date.now() / 1000);
      const cid = `crd_${rand()}`;
      const id = rand();
      const credential = jws({ typ: "dba-device+jwt" }, {
        iss: origin, sub: `dev_${rand()}`, acct: r.account, aud: r.aud, cid, jti: `${cid}.1`, iat: now, nbf: now, exp: now + 3600,
        cnf: { jkt: thumbprint(r.jwk) }, device: r.device ?? {}, grants: r.grants, status: { status_list: { idx: 0, uri: `${origin}/status/${id}` } }, ver: 1,
      });
      return send(res, 200, { credential, revoke_id: id });
    }
    if (url.pathname.startsWith("/test/revoke/") && req.method === "POST") { revoked.add(url.pathname.slice(13)); return send(res, 200, { revoked: true }); }
    if (/^\/sdk\/v[\d.]+\/dba\.js$/.test(url.pathname)) return send(res, 200, sdkModule(origin), "text/javascript");
    send(res, 404, { error: "not_found" });
  });
  server.listen(port);
  return server;
}

// The parts of the DBA browser SDK the console uses. The account a test's enrollment belongs to is
// window.__dbaTestAccount (set by the test after linking); "approval" is immediate.
function sdkModule(origin) {
  return `
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
const slots = new Map();
export class DBA {
  constructor({ origin = ${JSON.stringify(origin)}, name = "default" } = {}) { this.origin = origin; this.name = name; this.state = null; }
  async ready() { this.state = slots.get(this.name) ?? null; return !!this.state?.credential; }
  get credential() { return this.state?.credential ?? null; }
  expiresIn() { return this.state?.credential ? 3600 : 0; }
  async enroll({ aud, grants, device } = {}) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jwk = { kty, crv, x, y };
    const r = await fetch(this.origin + "/test/enroll", { method: "POST", body: JSON.stringify({ account: window.__dbaTestAccount, jwk, aud, grants, device }) }).then((x) => x.json());
    this.state = { privateKey: pair.privateKey, jwk, credential: r.credential, revokeId: r.revoke_id };
    slots.set(this.name, this.state);
    return r.credential;
  }
  async headers(method, url) {
    const header = enc({ typ: "dpop+jwt", alg: "ES256", jwk: this.state.jwk });
    const ath = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.state.credential)));
    const u = new URL(url, location.href);
    const payload = enc({ jti: crypto.randomUUID(), htm: method.toUpperCase(), htu: u.origin + u.pathname, iat: Math.floor(Date.now() / 1000), ath });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.state.privateKey, new TextEncoder().encode(header + "." + payload));
    return { Authorization: "DBA " + this.state.credential, DPoP: header + "." + payload + "." + b64u(sig) };
  }
  async revoke() { if (this.state) await fetch(this.origin + "/test/revoke/" + this.state.revokeId, { method: "POST" }); this.forget(); }
  forget() { slots.delete(this.name); this.state = null; }
}
`;
}
