import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deviceKeyFromSeed, wrapTopicKey, type DeviceKey } from "@subetha/sdk/protocol";
import { enrollmentProof, SubEtha } from "@subetha/sdk";
import { auth, balance, BASE, bootstrap } from "./helpers.ts";

const f = SELF.fetch.bind(SELF) as typeof fetch;

async function enroll(token: string, seedByte: number): Promise<DeviceKey> {
  const key = await deviceKeyFromSeed(new Uint8Array(32).fill(seedByte));
  const r = await SELF.fetch(`${BASE}/v1/devices`, { method: "POST", headers: auth(token), body: JSON.stringify(await enrollmentProof(key)) });
  expect(r.status).toBe(201);
  return key;
}

describe("wrapped topic keys", () => {
  it("an owner shares a topic key with devices, which load it and read encrypted messages", async () => {
    const a = await bootstrap("keyowner", 1);
    expect((await SELF.fetch(`${BASE}/v1/topics/@keyowner/vault`, { method: "PUT", headers: auth(a.token), body: "{}" })).status).toBe(201);
    const d1 = await enroll(a.token, 41);
    const d2 = await enroll(a.token, 42);
    const outsider = await enroll(a.token, 43);

    const owner = new SubEtha({ baseUrl: BASE, fetch: f, token: a.token });
    const topicKey = crypto.getRandomValues(new Uint8Array(32));
    expect(await owner.shareTopicKey("@keyowner/vault", "k1", topicKey, [d1.deviceId, d2.deviceId])).toEqual({ stored: 2 });

    // The owner publishes encrypted with the key it holds.
    const sender = new SubEtha({ baseUrl: BASE, fetch: f, token: a.token, topicKeys: { "@keyowner/vault": { kid: "k1", key: topicKey } } });
    await sender.publish("@keyowner/vault", "the code is 1234", { title: "Vault" });

    // Device 1 loads its key through a signed request and reads the plaintext.
    const dev1 = new SubEtha({ baseUrl: BASE, fetch: f, deviceKey: d1, signRequests: true });
    const loaded = await dev1.loadTopicKeys();
    expect(Object.keys(loaded)).toEqual(["@keyowner/vault"]);
    expect(loaded["@keyowner/vault"]!.kid).toBe("k1");
    const [m] = await dev1.poll("@keyowner/vault");
    expect(m).toMatchObject({ message: "the code is 1234", title: "Vault" });

    // A device sees only its own wrapped keys; one without any can't read the message.
    const listed = await dev1.listWrappedKeys();
    expect(listed.keys.map((k) => k.to)).toEqual([d1.deviceId]);
    const dev3 = new SubEtha({ baseUrl: BASE, fetch: f, deviceKey: outsider, signRequests: true });
    expect(await dev3.loadTopicKeys()).toEqual({});
    const [raw] = await dev3.poll("@keyowner/vault");
    expect(raw!.enc).toBeDefined();
    expect(raw!.title).toBeUndefined();

    // Rotation: a new kid replaces the old one for publishing once loaded (newest wins).
    const k2 = crypto.getRandomValues(new Uint8Array(32));
    await owner.shareTopicKey("@keyowner/vault", "k2", k2, [d1.deviceId]);
    expect((await dev1.loadTopicKeys())["@keyowner/vault"]!.kid).toBe("k2");

    // The owner lists and deletes.
    expect((await owner.listWrappedKeys("@keyowner/vault")).keys).toHaveLength(3);
    expect(await owner.deleteWrappedKeys("@keyowner/vault", { kid: "k1" })).toEqual({ deleted: 2 });
    expect((await owner.listWrappedKeys()).keys.map((k) => k.kid)).toEqual(["k2"]);
  });

  it("charges the caller and rejects keys for topics it doesn't own or malformed ones", async () => {
    const a = await bootstrap("keyguard", 1);
    const b = await bootstrap("keyother", 1);
    await SELF.fetch(`${BASE}/v1/topics/@keyother/t`, { method: "PUT", headers: auth(b.token), body: "{}" });
    await SELF.fetch(`${BASE}/v1/topics/@keyguard/t`, { method: "PUT", headers: auth(a.token), body: "{}" });
    const d = await enroll(a.token, 44);
    const key = new Uint8Array(32).fill(1);
    const put = (token: string, keys: unknown) => SELF.fetch(`${BASE}/v1/keys`, { method: "PUT", headers: auth(token), body: JSON.stringify({ keys }) });

    const theirs = await wrapTopicKey(key, { topic: "@keyother/t", kid: "k", to: d.deviceId });
    expect((await put(a.token, [theirs])).status).toBe(403);
    const unclaimed = await wrapTopicKey(key, { topic: "@keyguard/nope", kid: "k", to: d.deviceId });
    expect((await put(a.token, [unclaimed])).status).toBe(403);

    const mine = await wrapTopicKey(key, { topic: "@keyguard/t", kid: "k", to: d.deviceId });
    for (const bad of [[], [{ ...mine, extra: 1 }], [{ ...mine, ct: "short" }], [{ ...mine, to: "dev_nope" }], "x"]) {
      expect((await put(a.token, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    const before = await balance(a.token);
    expect((await put(a.token, [mine])).status).toBe(200);
    expect(await balance(a.token)).toBeLessThan(before);
    // Re-uploading the same (topic, kid, device) replaces it.
    expect((await put(a.token, [await wrapTopicKey(key, { topic: "@keyguard/t", kid: "k", to: d.deviceId })])).status).toBe(200);
    const listed = (await (await SELF.fetch(`${BASE}/v1/keys`, { headers: auth(a.token) })).json()) as { keys: unknown[] };
    expect(listed.keys).toHaveLength(1);

    // Another account sees none of them and can't delete them.
    expect(((await (await SELF.fetch(`${BASE}/v1/keys`, { headers: auth(b.token) })).json()) as { keys: unknown[] }).keys).toEqual([]);
    expect((await SELF.fetch(`${BASE}/v1/keys?topic=@keyguard/t`, { method: "DELETE", headers: auth(b.token) })).status).toBe(404);
  });
});
