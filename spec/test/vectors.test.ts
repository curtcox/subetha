// Checks the TypeScript SDK against the conformance vectors, and the vectors against the JSON Schema.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalEnvelope, canonicalize, decryptEnvelope, deviceKeyFromSeed, encryptEnvelope, hexDecode, hexEncode, isTopic,
  signEnvelope, validateEnvelope, verifyEnvelope,
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
  it("negative cases fail", async () => {
    for (const n of v.negative) expect(await verifyEnvelope(n.envelope), n.name).toBe(false);
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
