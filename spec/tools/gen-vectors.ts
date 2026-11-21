// Generates spec/vectors/*.json from the TypeScript reference implementation.
// Run: pnpm vectors. Other SDKs must reproduce these outputs exactly.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  base64urlEncode, canonicalEnvelope, canonicalize, decryptEnvelope, deviceKeyFromSeed, encryptEnvelope, hexDecode, hexEncode, signEnvelope, type Json,
} from "@subetha/sdk/protocol";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const write = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + "\n");

// ---- canonical ----
const canonicalValid: { name: string; input: Json; canonical: string }[] = [
  { name: "empty object", input: {}, canonical: "" },
  { name: "key order", input: { b: 2, a: 1, A: 0, _: 3, "1": 4 }, canonical: "" },
  { name: "nested", input: { z: { y: [3, { b: null, a: "x" }], x: true }, a: false }, canonical: "" },
  { name: "nulls dropped in objects, kept in arrays", input: { a: null, b: [null, 1] }, canonical: "" },
  { name: "escapes", input: { s: "quote\" backslash\\ nl\n cr\r tab\t bs\b ff\f nul\u0000 us\u001f del\u007f" }, canonical: "" },
  { name: "non-ascii raw", input: { s: "héllo 🚪 日本  " }, canonical: "" },
  { name: "integers", input: { a: 0, b: -1, c: 9007199254740991, d: -9007199254740991 }, canonical: "" },
  { name: "slash not escaped", input: { u: "https://subetha.org/@a/b" }, canonical: "" },
];
for (const v of canonicalValid) v.canonical = canonicalize(v.input);
const canonicalInvalid = [
  { name: "float", input_json: '{"a":1.5}' },
  { name: "unsafe integer", input_json: '{"a":9007199254740993}' },
  { name: "exponent float", input_json: '{"a":1e-7}' },
  { name: "non-ascii key", input_json: '{"é":1}' },
];
write("canonical.json", { description: "Canonical JSON (spec §3). Valid inputs must serialize to `canonical`; invalid ones must be rejected.", valid: canonicalValid, invalid: canonicalInvalid });

// ---- topics ----
write("topics.json", {
  description: "Topic grammar (spec §1.2).",
  valid: ["@alice/doorbell", "@a/b", "@a1-b2/Name_with-dash", "@" + "a".repeat(39) + "/x", "@alice/" + "n".repeat(64), "t_mfrggzdfmztwq2lknnwg23tpoa", "t_aaaaaaaaaaaaaaaaaaaaaaaaaa"],
  invalid: ["doorbell", "@Alice/x", "@alice-/x", "@-alice/x", "@alice", "@alice/", "@alice/a/b", "@" + "a".repeat(40) + "/x", "@alice/" + "n".repeat(65), "t_MFRGGZDFMZTWQ2LKNNWG23TPOA", "t_mfrggzdfmztwq2lknnwg23tpo", "t_mfrggzdfmztwq2lknnwg23tpoa1", "t_mfrggzdfmztwq2lknnwg23tp01", "@alice/door bell", ""],
});

// ---- signatures ----
const seeds = [
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
  "0000000000000000000000000000000000000000000000000000000000000001",
];
const devices = [];
for (const s of seeds) {
  const k = await deviceKeyFromSeed(hexDecode(s));
  devices.push({ seed: s, public_key: hexEncode(k.publicKey), device_id: k.deviceId });
}
const envs = [
  { id: "01JD5A2Z3K8Q9V6X7W4T1R0S2M", time: 1763750000, topic: "@alice/doorbell", message: "Opened" },
  { id: "01JD5A2Z3K8Q9V6X7W4T1R0S2N", time: 1763750001, expires: 1763836400, topic: "@alice/doorbell", title: "Front door", message: "Opened", priority: 4, tags: ["door", "warning"], hops: 2, route: { mode: "any", max_cost_usd_micros: 20000, deny: ["sms"], deadline_s: 60 } },
  { id: "01JD5A2Z3K8Q9V6X7W4T1R0S2P", time: 1763750002, topic: "t_mfrggzdfmztwq2lknnwg23tpoa", message: "héllo 🚪\nline2", content_type: "text/plain", actions: [{ action: "view", label: "Open", url: "https://example.com" }], x_future_field: { nested: [1, 2, 3] } },
];
const sigCases = [];
for (let i = 0; i < envs.length; i++) {
  const k = await deviceKeyFromSeed(hexDecode(seeds[i % seeds.length]!));
  const signed = await signEnvelope(envs[i]!, k);
  sigCases.push({ seed: seeds[i % seeds.length], unsigned: envs[i], canonical: canonicalEnvelope(signed), signing_input: "subetha-sig-v1\n" + canonicalEnvelope(signed), signed });
}
const good = sigCases[1]!.signed as Record<string, unknown>;
const negative = [
  { name: "tampered message", envelope: { ...good, message: "Closed" } },
  { name: "tampered priority", envelope: { ...good, priority: 5 } },
  { name: "wrong sender", envelope: { ...good, sender: devices[0]!.device_id } },
  { name: "sig removed", envelope: { ...good, sig: undefined } },
  { name: "truncated sig", envelope: { ...good, sig: (good.sig as string).slice(0, 50) } },
];
write("signatures.json", {
  description: "Device ids (spec §1.3) and Ed25519 envelope signatures (spec §4). `signed` must verify; signing `unsigned` with `seed` must yield `signed.sig` exactly. Changing `hops` must not affect verification. Every `negative` envelope must fail verification.",
  devices,
  cases: sigCases,
  hops_change: { envelope: { ...good, hops: 0 }, valid: true },
  negative: negative.map((n) => ({ name: n.name, envelope: JSON.parse(JSON.stringify(n.envelope)) })),
});

// ---- e2ee ----
const key = hexDecode("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const nonce = hexDecode("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7");
const plain = { id: "01JD5A2Z3K8Q9V6X7W4T1R0S2Q", time: 1763750003, topic: "@alice/secret", title: "Vault", message: "The code is 1234", priority: 5, tags: ["lock"], click: "https://example.com/x" };
const encrypted = await encryptEnvelope(plain, key, "topic-key-3", nonce);
const signer = await deviceKeyFromSeed(hexDecode(seeds[0]!));
const encSigned = await signEnvelope(encrypted, signer);
write("e2ee.json", {
  description: "E2EE (spec §5). Encrypting `plaintext` with `key`, `kid`, and `nonce` must yield `encrypted` exactly; decrypting must restore `plaintext`. `encrypted_signed` is `encrypted` signed with signatures.devices[0]; decrypting it must yield `decrypted_signed` (sender and sig kept, enc removed). The AAD excludes message, sender, sig, and hops.",
  key: hexEncode(key),
  kid: "topic-key-3",
  nonce: hexEncode(nonce),
  nonce_b64: base64urlEncode(nonce),
  plaintext: plain,
  aad: canonicalEnvelope({ ...encrypted, message: undefined }),
  encrypted,
  encrypted_signed: encSigned,
  decrypted_signed: await decryptEnvelope(encSigned, key),
});
console.log("vectors written to", out);
