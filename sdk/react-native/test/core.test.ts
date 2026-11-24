import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as sdk from "@subetha/sdk";
import * as rn from "../src/index.ts";
import type { SubEthaCore } from "../src/core.ts";

// A synchronous stand-in for @subetha/react-native-core, built on node:crypto and the JS SDK's
// protocol helpers. It takes host and path?query the way the real core does, so the test checks
// that coreSigner hands it what WHATWG URL would.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const key = (seed: ArrayBuffer) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
const pub = (seed: ArrayBuffer) => new Uint8Array((createPublicKey(key(seed)).export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
const deviceId = (seed: ArrayBuffer) => sdk.deviceIdFromPublicKey(pub(seed));
const b64u = (b: Uint8Array) => sdk.base64urlEncode(b);

const fakeCore = {
  deviceKeyFromSeed: (seed: ArrayBuffer) => ({ seed, publicKey: pub(seed).buffer as ArrayBuffer, deviceId: deviceId(seed) }),
  signEnvelopeJson(json: string, seed: ArrayBuffer) {
    const { sig: _sig, ...env } = JSON.parse(json);
    const unsigned = { ...env, sender: deviceId(seed) };
    const sig = edSign(null, Buffer.from(sdk.SIG_DOMAIN + sdk.canonicalEnvelope(unsigned)), key(seed));
    return JSON.stringify({ ...unsigned, sig: "ed25519:" + b64u(sig) });
  },
  verifyEnvelopeJson(json: string) {
    const env = JSON.parse(json);
    if (typeof env.sig !== "string") return false;
    const pk = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), sdk.publicKeyFromDeviceId(env.sender)]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(sdk.SIG_DOMAIN + sdk.canonicalEnvelope(env)), pk, sdk.base64urlDecode(env.sig.slice(8)));
  },
  signRequest(seed: ArrayBuffer, method: string, host: string, pathAndQuery: string, time: bigint, nonce: string | undefined, body: ArrayBuffer, headers: { name: string; value: string }[]) {
    const id = deviceId(seed);
    const n = nonce ?? "AAAAAAAAAAAAAAAAAAAAAA";
    const signed = sdk.headersToSign(id, Number(time), n, headers.map((h) => [h.name, h.value] as [string, string]));
    let input = `subetha-req-v2\n${method}\n${host}\n${pathAndQuery}\n${createHash("sha256").update(Buffer.from(body)).digest("hex")}`;
    for (const [k, v] of signed) input += `\n${k}:${sdk.canonicalHeaderValue(v)}`;
    return { deviceId: id, time, nonce: n, signedHeaders: signed.map(([k]) => k).join(","), signature: b64u(edSign(null, Buffer.from(input), key(seed))) };
  },
} as unknown as SubEthaCore;

const SEED = sdk.hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

describe("Rust core signer and verifier", () => {
  it("urlParts matches WHATWG URL host and path?query", () => {
    for (const u of [
      "https://subetha.us/@me/door?since=all",
      "https://Subetha.US:443/",
      "http://localhost:8787/v1/device/code",
      "http://user:pw@Example.com:80",
      "https://x.test:8443/a/b%20c?q=1&r=%2F",
      "wss://subetha.us:443/@me/door/ws",
    ]) {
      const w = new URL(u);
      expect(rn.urlParts(u), u).toEqual({ host: w.host, pathAndQuery: w.pathname + w.search });
    }
    expect(() => rn.urlParts("/relative")).toThrow();
  });

  it("signs publishes and requests with the core; the signatures check out with WebCrypto", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(init.body as string);
    }) as typeof globalThis.fetch;
    const client = rn.createClient({ baseUrl: "https://Subetha.us:443", fetch, token: "se_t", core: fakeCore, deviceSeed: SEED, signRequests: true });
    const sent = await client.publish("@me/door", "ding", { title: "Front" });
    const webKey = await sdk.deviceKeyFromSeed(SEED);
    expect(sent.sender).toBe(webKey.deviceId);
    expect(await sdk.verifyEnvelope(sent)).toBe(true);

    // Recompute the request signature from the real URL with the JS SDK and check it.
    const h = calls[0]!.init.headers as Headers;
    const names = h.get("x-device-signed-headers")!.split(",");
    expect(names).toEqual(["x-device-id", "x-device-time", "x-device-nonce", "content-type"]);
    const input = await sdk.requestSigningInputV2("POST", calls[0]!.url, sdk.utf8.encode(calls[0]!.init.body as string), names.map((n) => [n, h.get(n)!] as [string, string]));
    const pk = await crypto.subtle.importKey("raw", webKey.publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, pk, sdk.base64urlDecode(h.get("x-device-signature")!) as BufferSource, sdk.utf8.encode(input) as BufferSource)).toBe(true);
  });

  it("verifies subscriptions with the core, and needs it (or a signer) for deviceSeed", async () => {
    const webKey = await sdk.deviceKeyFromSeed(SEED);
    const good = await sdk.signEnvelope({ id: "01B", time: 1, topic: "@me/door", message: "ok" }, webKey);
    const bad = { ...good, id: "01A", message: "tampered" };
    const lines = [bad, good].map((e) => JSON.stringify(e)).join("\n") + "\n";
    const fetch = (async () => new Response(lines)) as unknown as typeof globalThis.fetch;
    const client = rn.createClient({ baseUrl: "https://x.test", fetch, core: fakeCore });
    const got = await new Promise<string>((resolve) => {
      const sub = rn.subscribe(client, ["@me/door", "@me/other"], (m) => { sub.close(); resolve(m.id!); }, { verify: true, autoAck: false });
    });
    expect(got).toBe("01B");
    expect(() => rn.createClient({ deviceSeed: SEED })).toThrow(/core/);
  });
});

describe("coreKeyUnwrapper", () => {
  it("opens wrapped keys through the core for client.loadTopicKeys", async () => {
    const dev = await sdk.deviceKeyFromSeed(SEED);
    const topicKey = new Uint8Array(32).fill(5);
    const wrapped = await sdk.wrapTopicKey(topicKey, { topic: "@a/vault", kid: "k1", to: dev.deviceId });
    const seen: string[] = [];
    // Stands in for the core's unwrap_topic_key_json: open with the JS reference, synchronously
    // from a precomputed answer, recording what it was handed.
    const opened = await sdk.unwrapTopicKey(wrapped, SEED);
    const core = {
      ...fakeCore,
      unwrapTopicKeyJson(json: string, seed: ArrayBuffer) {
        seen.push(json);
        const w = JSON.parse(json);
        return w.ct === wrapped.ct && Buffer.from(seed).equals(Buffer.from(SEED)) ? (opened!.slice().buffer as ArrayBuffer) : undefined;
      },
    } as unknown as SubEthaCore;
    const u = rn.coreKeyUnwrapper(core, SEED);
    expect(u.deviceId).toBe(dev.deviceId);

    const fetch = (async () => Response.json({ keys: [{ ...wrapped, created_at: 1 }, { ...wrapped, ct: "x".repeat(64), kid: "bad", created_at: 2 }] })) as typeof globalThis.fetch;
    const client = new sdk.SubEtha({ baseUrl: "https://relay.test", token: "t", fetch });
    const loaded = await client.loadTopicKeys({ unwrapper: u });
    expect(loaded).toEqual({ "@a/vault": { kid: "k1", key: topicKey } });
    expect(JSON.parse(seen[0]!)).toEqual(wrapped); // created_at stripped
    expect(seen).toHaveLength(2);
  });

  it("wraps topic keys through coreKeyWrapper for client.shareTopicKey", async () => {
    const dev = await sdk.deviceKeyFromSeed(SEED);
    const topicKey = new Uint8Array(32).fill(9);
    const preWrapped = await sdk.wrapTopicKey(topicKey, { topic: "@a/vault", kid: "k2", to: dev.deviceId });
    const core = {
      ...fakeCore,
      wrapTopicKeyJson: () => JSON.stringify(preWrapped),
    } as unknown as SubEthaCore;
    let uploaded: unknown = null;
    const fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      uploaded = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({ stored: 1 });
    }) as typeof globalThis.fetch;
    const client = new sdk.SubEtha({ baseUrl: "https://relay.test", token: "t", fetch });
    const res = await client.shareTopicKey("@a/vault", "k2", topicKey, [dev.deviceId], { wrapper: rn.coreKeyWrapper(core) });
    expect(res).toEqual({ stored: 1 });
    expect(uploaded).toEqual({ keys: [preWrapped] });
  });
});
