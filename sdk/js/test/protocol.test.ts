import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, base64urlDecode, base64urlEncode, canonicalize, decryptEnvelope, Deduper,
  deviceKeyFromSeed, encryptEnvelope, hexDecode, hexEncode, isTopic, parsePriority, parseTopic, poly1305,
  publicKeyFromDeviceId, secretTopic, signEnvelope, ulid, ulidTime, utf8, validateEnvelope, verifyEnvelope, xchachaOpen, xchachaSeal,
} from "../src/protocol/index.ts";

describe("encodings", () => {
  it("base32 matches RFC 4648 test vectors", () => {
    const cases: [string, string][] = [["", ""], ["f", "my"], ["fo", "mzxq"], ["foo", "mzxw6"], ["foob", "mzxw6yq"], ["fooba", "mzxw6ytb"], ["foobar", "mzxw6ytboi"]];
    for (const [a, b] of cases) {
      expect(base32Encode(utf8.encode(a))).toBe(b);
      expect(utf8.decode(base32Decode(b))).toBe(a);
    }
  });
  it("base64url round trips", () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(base64urlDecode(base64urlEncode(b))).toEqual(b);
      expect(base64urlEncode(b)).toBe(Buffer.from(b).toString("base64url"));
    }
  });
});

describe("canonicalize", () => {
  it("sorts keys, drops nulls, escapes minimally", () => {
    expect(canonicalize({ b: 1, a: "x\n\u0001é\"\\", c: null, d: [true, false, null] })).toBe('{"a":"x\\n\\u0001é\\"\\\\","b":1,"d":[true,false,null]}');
  });
  it("rejects floats", () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow();
  });
  it("normalizes -0", () => {
    expect(canonicalize(-0)).toBe("0");
  });
});

describe("ulid", () => {
  it("is monotonic and decodes time", () => {
    const t = 1763750000123;
    const a = ulid(t), b = ulid(t);
    expect(a < b).toBe(true);
    expect(ulidTime(a)).toBe(t);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("topics", () => {
  it("accepts the grammar", () => {
    expect(isTopic("@alice/doorbell")).toBe(true);
    expect(isTopic("@a/x")).toBe(true);
    expect(isTopic(secretTopic())).toBe(true);
    expect(isTopic("@Alice/x")).toBe(false);
    expect(isTopic("@alice-/x")).toBe(false);
    expect(isTopic("doorbell")).toBe(false);
    expect(isTopic("t_short")).toBe(false);
    expect(parseTopic("@alice/doorbell")).toEqual({ kind: "namespaced", topic: "@alice/doorbell", handle: "alice", name: "doorbell" });
  });
});

describe("priority", () => {
  it("parses names and numbers", () => {
    expect(parsePriority("urgent")).toBe(5);
    expect(parsePriority("2")).toBe(2);
    expect(parsePriority(undefined)).toBeUndefined();
    expect(() => parsePriority("9")).toThrow();
  });
});

describe("validateEnvelope", () => {
  it("accepts a minimal message and rejects junk", () => {
    expect(validateEnvelope({ topic: "@a/b", message: "hi" })).toEqual([]);
    expect(validateEnvelope({ topic: "nope" }).length).toBeGreaterThan(0);
    expect(validateEnvelope({ topic: "@a/b", priority: 7 })).toContain("priority: integer 1..5");
    expect(validateEnvelope({ topic: "@a/b", extra: 1.5 }).some((e) => e.includes("non-integer"))).toBe(true);
    expect(validateEnvelope({ topic: "@a/b", message: "x".repeat(4097) }).length).toBe(1);
  });
});

describe("signatures", () => {
  const seed = hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  it("derives RFC 8032 public key from seed", async () => {
    const k = await deviceKeyFromSeed(seed);
    expect(hexEncode(k.publicKey)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    expect(publicKeyFromDeviceId(k.deviceId)).toEqual(k.publicKey);
  });
  it("signs and verifies; tamper and hop changes behave", async () => {
    const k = await deviceKeyFromSeed(seed);
    const env = await signEnvelope({ id: ulid(), time: 1763750000, topic: "@alice/doorbell", message: "Opened", hops: 2 }, k);
    expect(await verifyEnvelope(env)).toBe(true);
    expect(await verifyEnvelope({ ...env, hops: 1 })).toBe(true);
    expect(await verifyEnvelope({ ...env, message: "Closed" })).toBe(false);
    expect(await verifyEnvelope({ ...env, sig: "ed25519:xx" })).toBe(false);
  });
});

describe("xchacha20poly1305", () => {
  it("matches the RFC 8439 Poly1305 vector", () => {
    const tag = poly1305(hexDecode("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b"), utf8.encode("Cryptographic Forum Research Group"));
    expect(hexEncode(tag)).toBe("a8061dc1305136c6c22b8baf0c0127a9");
  });
  it("matches the draft-irtf-cfrg-xchacha A.3.1 vector", () => {
    const pt = utf8.encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const aad = hexDecode("50515253c0c1c2c3c4c5c6c7");
    const key = hexDecode("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    const iv = hexDecode("404142434445464748494a4b4c4d4e4f5051525354555657");
    const sealed = xchachaSeal(key, iv, pt, aad);
    expect(hexEncode(sealed)).toBe(
      "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52e" +
      "c0875924c1c7987947deafd8780acf49");
    expect(xchachaOpen(key, iv, sealed, aad)).toEqual(pt);
    sealed[0]! ^= 1;
    expect(xchachaOpen(key, iv, sealed, aad)).toBeNull();
  });
  it("encrypts and decrypts envelopes", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const env = { id: ulid(), time: 1, topic: "@a/b", title: "T", message: "secret", priority: 4 };
    const enc = await encryptEnvelope(env, key, "k1");
    expect(enc.title).toBeUndefined();
    expect(enc.priority).toBe(4);
    expect(await decryptEnvelope(enc, key)).toEqual(env);
    expect(await decryptEnvelope({ ...enc, priority: 5 }, key)).toBeNull();
    expect(await decryptEnvelope(enc, new Uint8Array(32))).toBeNull();
  });
});

describe("Deduper", () => {
  it("drops duplicates and expired messages", () => {
    const d = new Deduper(2);
    expect(d.accept({ id: "01JD0000000000000000000000" })).toBe(true);
    expect(d.accept({ id: "01jd0000000000000000000000" })).toBe(false);
    expect(d.accept({ id: "01JD0000000000000000000001", expires: 1 }, 2)).toBe(false);
    d.accept({ id: "01JD0000000000000000000002" });
    d.accept({ id: "01JD0000000000000000000003" });
    expect(d.size).toBe(2);
  });
});
