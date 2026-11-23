// Checks the TypeScript SDK against the conformance vectors, and the vectors against the JSON Schema.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalEnvelope, canonicalize, decryptEnvelope, deviceKeyFromSeed, encryptEnvelope, hexDecode, hexEncode, isTopic,
  signEnvelope, signRequestV2, utf8, validateEnvelope, verifyEnvelope,
  ed25519ToX25519Public, isWrappedKey, unwrapTopicKey, wrapAad, wrapTopicKey, x25519SecretFromSeed,
} from "@subetha/sdk/protocol";

const load = (n: string) => JSON.parse(readFileSync(new URL(`../vectors/${n}`, import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schema/message.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false });
const validateSchema = ajv.compile(schema);

describe("canonical vectors", () => {
  const v = load("canonical.json");
  for (const c of v.valid) it(c.name, () => expect(canonicalize(c.input)).toBe(c.canonical));
  for (const c of v.invalid) it(`rejects ${c.name}`, () => expect(() => canonicalize(JSON.parse(c.input_json))).toThrow());
});

describe("topic vectors", () => {
  const v = load("topics.json");
  it("valid", () => v.valid.forEach((t: string) => expect(isTopic(t), t).toBe(true)));
  it("invalid", () => v.invalid.forEach((t: string) => expect(isTopic(t), t).toBe(false)));
  it("schema agrees", () => {
    v.valid.forEach((t: string) => expect(validateSchema({ topic: t }), t).toBe(true));
    v.invalid.forEach((t: string) => expect(validateSchema({ topic: t }), t).toBe(false));
  });
});

describe("signature vectors", () => {
  const v = load("signatures.json");
  it("device ids", async () => {
    for (const d of v.devices) {
      const k = await deviceKeyFromSeed(hexDecode(d.seed));
      expect(hexEncode(k.publicKey)).toBe(d.public_key);
      expect(k.deviceId).toBe(d.device_id);
    }
  });
  it("cases sign and verify", async () => {
    for (const c of v.cases) {
      const k = await deviceKeyFromSeed(hexDecode(c.seed));
      const signed = await signEnvelope(c.unsigned, k);
      expect(signed).toEqual(c.signed);
      expect(canonicalEnvelope(signed)).toBe(c.canonical);
      expect(await verifyEnvelope(c.signed)).toBe(true);
      expect(validateSchema(c.signed), JSON.stringify(validateSchema.errors)).toBe(true);
      expect(validateEnvelope(c.signed)).toEqual([]);
    }
  });
  it("hops change keeps validity", async () => expect(await verifyEnvelope(v.hops_change.envelope)).toBe(true));
  it("relay-added event keeps validity", async () => expect(await verifyEnvelope(v.event_added.envelope)).toBe(true));
  it("negative cases fail", async () => {
    for (const n of v.negative) expect(await verifyEnvelope(n.envelope), n.name).toBe(false);
  });
});

describe("request signing vectors", () => {
  const v = load("requests.json");
  it("signs each case exactly", async () => {
    const k = await deviceKeyFromSeed(hexDecode(v.seed));
    expect(k.deviceId).toBe(v.device_id);
    for (const c of v.cases) {
      const h = await signRequestV2(k, c.method, c.url, utf8.encode(c.body), c.headers, c.time, v.nonce);
      expect(h["x-device-signed-headers"], c.name).toBe(c.signed_headers);
      expect(h["x-device-signature"], c.name).toBe(c.signature);
      expect(c.signing_input.split("\n").slice(0, 4)).toEqual(["subetha-req-v2", c.method.toUpperCase(), c.host, c.path_and_query]);
    }
  });
});

describe("e2ee vectors", () => {
  const v = load("e2ee.json");
  it("encrypts deterministically and decrypts", async () => {
    const enc = await encryptEnvelope(v.plaintext, hexDecode(v.key), v.kid, hexDecode(v.nonce));
    expect(enc).toEqual(v.encrypted);
    expect(await decryptEnvelope(v.encrypted, hexDecode(v.key))).toEqual(v.plaintext);
    expect(await verifyEnvelope(v.encrypted_signed)).toBe(true);
    expect(await decryptEnvelope(v.encrypted_signed, hexDecode(v.key))).toEqual(v.decrypted_signed);
    expect(validateSchema(v.encrypted_signed)).toBe(true);
  });
});

describe("key wrap vectors", () => {
  const v = load("e2ee.json");
  const w = v.key_wrap;
  it("wraps deterministically and unwraps", async () => {
    const seed = hexDecode(w.recipient_seed);
    const dev = await deviceKeyFromSeed(seed);
    expect(hexEncode(ed25519ToX25519Public(dev.publicKey))).toBe(w.recipient_x25519_public);
    expect(hexEncode(await x25519SecretFromSeed(seed))).toBe(w.recipient_x25519_secret);
    const wrapped = await wrapTopicKey(hexDecode(v.key), { topic: w.wrapped.topic, kid: w.wrapped.kid, to: dev.deviceId }, { ephemeralSecret: hexDecode(w.ephemeral_secret), nonce: hexDecode(w.nonce) });
    expect(wrapped).toEqual(w.wrapped);
    const { ct: _ct, ...head } = wrapped;
    expect(utf8.decode(wrapAad(head))).toBe(w.aad);
    expect(isWrappedKey(w.wrapped)).toBe(true);
    expect(hexEncode((await unwrapTopicKey(w.wrapped, seed))!)).toBe(v.key);
    expect(hexEncode((await unwrapTopicKey(w.wrapped, dev))!)).toBe(v.key);
  });
  for (const c of w.invalid) it(`rejects ${c.name}`, async () => expect(await unwrapTopicKey(c.wrapped, hexDecode(w.recipient_seed))).toBeNull());
  it("converts ed25519 keys to x25519", () => {
    for (const c of w.ed25519_to_x25519) expect(hexEncode(ed25519ToX25519Public(hexDecode(c.ed25519)))).toBe(c.x25519);
  });
});

describe("edge vectors", async () => {
  const edge = await import("@subetha/sdk/edge");
  const { base64urlDecode, utf8 } = await import("@subetha/sdk/protocol");
  const v = load("edge.json");
  it("audio tones and PCM", () => {
    for (const c of v.audio.cases) {
      expect(edge.audioTones(utf8.encode(c.payload))).toEqual(c.tones);
      expect(edge.audioFrameSamples(utf8.encode(c.payload).length)).toBe(c.frame_samples);
    }
    const raw = base64urlDecode(v.audio.pcm_s16le);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const pcm = Float32Array.from({ length: raw.length / 2 }, (_, i) => dv.getInt16(i * 2, true) / 32767);
    expect(utf8.decode(edge.demodulate(pcm)!)).toBe(v.audio.pcm_payload);
  });
  it("fountain frames decode", () => {
    const dec = new edge.FountainDecoder();
    for (const f of v.fountain.frames.slice().reverse()) dec.push(hexDecode(f.hex));
    expect(utf8.decode(dec.result!)).toBe(v.fountain.payload);
  });
  it("ble chunks reassemble", () => {
    const r = new edge.Reassembler();
    const out = v.ble.chunks.map((c: string) => r.push(hexDecode(c), 0)).filter(Boolean);
    expect(utf8.decode(out[0])).toBe(v.ble.payload);
  });
  it("base45 and gossip parse", () => {
    for (const c of v.base45) {
      const bytes = c.hex !== undefined ? hexDecode(c.hex) : utf8.encode(c.plain);
      expect(edge.base45Encode(bytes)).toBe(c.encoded);
    }
    for (const m of v.gossip) expect(edge.parseGossip(JSON.stringify(m))).toEqual(m);
  });
});
