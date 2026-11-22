import { describe, expect, it } from "vitest";
import {
  audioFrameSamples, AUDIO_AMPLITUDE, base45Decode, base45Encode, BLE_SERVICE_UUID, chunk, crc16, crc32, demodulate,
  FountainDecoder, FountainEncoder, FOUNTAIN_HEADER_LEN, GossipNode, gossipSession, modulate, parseGossip, Reassembler,
  resample, robustSolitonCdf, SplitMix64, SYMBOL_SAMPLES, type GossipMessage,
} from "../src/edge/index.ts";
import { deviceKeyFromSeed, signEnvelope, ulid, utf8, type Envelope } from "../src/protocol/index.ts";

const bytes = (s: string) => utf8.encode(s);

describe("crc and splitmix", () => {
  it("match check values", () => {
    expect(crc16(bytes("123456789"))).toBe(0x29b1);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc16(new Uint8Array())).toBe(0xffff);
    expect(crc32(new Uint8Array())).toBe(0);
    const r = new SplitMix64(0n);
    expect(r.nextU64()).toBe(0xe220a8397b1dcdafn);
    expect(r.nextU64()).toBe(0x6e789e6aa1b965f4n);
    const r2 = new SplitMix64(7n);
    for (let i = 0; i < 1000; i++) {
      expect(r2.below(10)).toBeLessThan(10);
      const f = r2.nextF64();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });
});

describe("base45", () => {
  it("matches RFC 9285 examples", () => {
    const cases: [string, string][] = [["AB", "BB8"], ["Hello!!", "%69 VD92EX0"], ["base-45", "UJCLQE7W581"], ["ietf!", "QED8WEX0"], ["", ""]];
    for (const [plain, enc] of cases) {
      expect(base45Encode(bytes(plain))).toBe(enc);
      expect(utf8.decode(base45Decode(enc))).toBe(plain);
    }
  });
  it("round trips and rejects garbage", () => {
    for (let n = 0; n < 50; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(base45Decode(base45Encode(b))).toEqual(b);
    }
    expect(() => base45Decode("GGW")).toThrow(); // 65535 < value
    expect(() => base45Decode("a")).toThrow();
    expect(() => base45Decode("abc")).toThrow(); // lower case
  });
});

function gaussianNoise(n: number, sigma: number, seed: bigint): Float32Array {
  const r = new SplitMix64(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(r.nextF64(), 1e-12);
    const u2 = r.nextF64();
    out[i] = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

function embed(sig: Float32Array, lead: number, tail: number, sigma: number, seed: bigint): Float32Array {
  const out = gaussianNoise(lead + sig.length + tail, sigma, seed);
  for (let i = 0; i < sig.length; i++) out[lead + i]! += sig[i]!;
  return out;
}

describe("audio modem", () => {
  it("round trips clean signals", () => {
    for (const p of [new Uint8Array(), bytes("x"), bytes("01JD5A2Z3K8Q9V6X7W4T1R0S2M"), new Uint8Array([0, 255, 16, 15, 0xa5, 0x5a])]) {
      const pcm = modulate(p);
      expect(pcm.length).toBe(audioFrameSamples(p.length));
      expect(pcm.every((x) => Math.abs(x) <= AUDIO_AMPLITUDE)).toBe(true);
      expect(demodulate(pcm)).toEqual(p);
    }
  });
  it("survives white noise and arbitrary offsets", () => {
    const p = bytes("subetha: front door opened @ 01JD5A2Z3K8Q9V6X7W4T1R0S2M");
    const pcm = modulate(p);
    for (const [seed, lead] of [[1n, 1234], [2n, 7], [3n, 4801]] as const) {
      expect(demodulate(embed(pcm, lead, 2000, 0.35, seed))).toEqual(p);
    }
  });
  it("rejects noise and truncated frames", () => {
    expect(demodulate(gaussianNoise(48_000, 0.3, 9n))).toBeNull();
    expect(demodulate(new Float32Array())).toBeNull();
    const pcm = modulate(bytes("hello"));
    expect(demodulate(pcm.subarray(0, pcm.length - SYMBOL_SAMPLES))).toBeNull();
  });
  it("decodes after resampling through 44.1 kHz", () => {
    const p = bytes("door");
    const at44 = resample(modulate(p), 48_000, 44_100);
    expect(demodulate(resample(at44, 44_100, 48_000))).toEqual(p);
  });
});

function payload(n: number, seed: bigint): Uint8Array {
  const r = new SplitMix64(seed);
  return Uint8Array.from({ length: n }, () => Number(r.nextU64() & 0xffn));
}

function transfer(data: Uint8Array, frameSize: number, drop: number, skip: number, seed: bigint, budget: number) {
  const enc = new FountainEncoder(data, frameSize);
  const rng = new SplitMix64(seed);
  const dec = new FountainDecoder();
  let delivered = 0;
  for (let s = skip; s < skip + budget; s++) {
    if (rng.nextF64() < drop) continue;
    delivered++;
    if (dec.push(enc.frame(s)).complete) return { out: dec.result!, delivered };
  }
  throw new Error(`no decode within ${budget} frames`);
}

describe("fountain codes", () => {
  it("soliton cdf is a distribution", () => {
    for (const k of [1, 2, 3, 10, 40, 100, 1000]) {
      const cdf = robustSolitonCdf(k);
      expect(cdf.length).toBe(k);
      for (let i = 1; i < k; i++) expect(cdf[i]!).toBeGreaterThanOrEqual(cdf[i - 1]!);
      expect(cdf[k - 1]).toBe(1);
    }
  });
  it("is systematic with fixed-size frames", () => {
    const data = payload(1000, 1n);
    const enc = new FountainEncoder(data, 115);
    expect(enc.sourceBlocks).toBe(10);
    for (let i = 0; i < 30; i++) {
      const f = enc.frame(i);
      expect(f.length).toBe(115);
      if (i < 10) expect(f.subarray(FOUNTAIN_HEADER_LEN)).toEqual(data.subarray(i * 100, i * 100 + 100));
    }
    expect(() => new FountainEncoder(data, FOUNTAIN_HEADER_LEN)).toThrow();
  });
  it("decodes with 30% loss, and from fountain frames only", () => {
    const data = payload(10_000, 2n);
    for (let seed = 0n; seed < 4n; seed++) {
      const { out, delivered } = transfer(data, 271, 0.3, 0, seed, 400);
      expect(out).toEqual(data);
      expect(delivered).toBeLessThan(80);
    }
    const small = payload(5_000, 3n);
    const { out, delivered } = transfer(small, 115, 0.3, 50, 0n, 2000);
    expect(out).toEqual(small);
    expect(delivered).toBeLessThan(150);
  });
  it("handles edge sizes and rejects bad frames", () => {
    for (const n of [0, 1, 99, 100, 101]) expect(transfer(payload(n, 4n), 115, 0, 0, 0n, 10).out).toEqual(payload(n, 4n));
    const dec = new FountainDecoder();
    expect(() => dec.push(new Uint8Array([1, 2, 3]))).toThrow(/malformed/);
    const a = new FountainEncoder(bytes("hello world"), 20).frame(0);
    const v2 = a.slice();
    v2[0] = 2;
    expect(() => dec.push(v2)).toThrow(/version/);
    dec.push(a);
    expect(() => dec.push(new FountainEncoder(bytes("other transfer"), 20).frame(0))).toThrow(/different transfer/);
    expect(dec.push(a)).toEqual({ complete: false, known: 1, total: 3 });
  });
});

describe("BLE chunking", () => {
  it("round trips at several MTUs, out of order", () => {
    expect(BLE_SERVICE_UUID.length).toBe(36);
    const p = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
    for (const mtu of [23, 185, 517]) {
      const chunks = chunk(9, p, mtu);
      expect(chunks.every((c) => c.length <= mtu - 3)).toBe(true);
      expect(chunks.length).toBe(Math.ceil((p.length + 2) / (mtu - 9)));
      const r = new Reassembler();
      let out: Uint8Array | null = null;
      for (const c of [...chunks].reverse()) out = r.push(c, 0) ?? out;
      expect(out).toEqual(p);
      expect(r.pending).toBe(0);
    }
    expect(chunk(0, new Uint8Array(), 23).length).toBe(1);
  });
  it("detects errors and prunes", () => {
    expect(() => chunk(0, bytes("x"), 9)).toThrow(/too small/);
    const r = new Reassembler();
    expect(() => r.push(new Uint8Array([0, 0, 0, 1, 0, 1]))).toThrow(/malformed/);
    const c = chunk(3, bytes("hello"), 23);
    c[0]![c[0]!.length - 3]! ^= 1;
    expect(() => r.push(c[0]!)).toThrow(/CRC/);
    const two = chunk(5, new Uint8Array(40).fill(1), 23);
    r.push(two[0]!, 1000);
    expect(r.prune(5000, 10_000)).toBe(0);
    expect(r.prune(20_000, 10_000)).toBe(1);
  });
});

describe("gossip", () => {
  const TOPIC = "@alice/doorbell";
  const now = 1_763_750_000;
  const env = (msg: string, hops: number, extra: Partial<Envelope> = {}): Envelope =>
    ({ id: ulid(now * 1000), time: now, topic: TOPIC, message: msg, hops, ...extra });

  async function exchange(a: GossipNode, b: GossipNode, inbox: Envelope[][], ia: number, ib: number) {
    const nodes = [a, b];
    const idx = [ia, ib];
    const queue: [number, GossipMessage][] = [[1, a.summary(now)]];
    while (queue.length) {
      const [dst, m] = queue.pop()!;
      const h = await nodes[dst]!.handle(m, now);
      inbox[idx[dst]!]!.push(...h.delivered);
      for (const r of h.replies) queue.push([1 - dst, r]);
    }
  }

  it("spreads along a line until hops run out", async () => {
    const n = 5;
    const nodes = Array.from({ length: n }, () => new GossipNode());
    nodes.forEach((x) => x.subscribe(TOPIC));
    const inbox: Envelope[][] = nodes.map(() => []);
    expect(nodes[0]!.publish(env("hi", 2), now)).toBe(true);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i + 1 < n; i++) {
        await exchange(nodes[i]!, nodes[i + 1]!, inbox, i, i + 1);
        await exchange(nodes[i + 1]!, nodes[i]!, inbox, i + 1, i);
      }
    }
    // hops 2: nodes 1 and 2 receive it; node 2 holds it with hops 0 and stops.
    expect(inbox.map((x) => x.length)).toEqual([0, 1, 1, 0, 0]);
    expect(inbox[2]![0]!.hops).toBe(0);
  });

  it("drops bad signatures, expired, uninteresting and unsigned messages", async () => {
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(1));
    const node = new GossipNode({ requireSignatures: true });
    node.subscribe(TOPIC);
    const signed = await signEnvelope(env("ok", 3), key);
    const forged = { ...(await signEnvelope(env("x", 3), key)), message: "forged" };
    const h = await node.handle({ type: "deliver", envelopes: [
      signed, forged, env("unsigned", 1), env("old", 1, { expires: now - 1 }),
      { ...env("other", 1), topic: "@bob/x" }, { ...signed }, env("bad", 99), { topic: TOPIC, message: "no id" },
    ] }, now);
    expect(h.delivered.map((e) => e.message)).toEqual(["ok"]);
    expect(h.dropped.map((d) => d.reason)).toEqual(["bad_signature", "unsigned", "expired", "not_interested", "duplicate", "bad_hops", "no_id"]);
    // A relay-only node stores but doesn't deliver.
    const relay = new GossipNode();
    relay.setRelayable(TOPIC, true);
    const r = await relay.handle({ type: "deliver", envelopes: [signed] }, now);
    expect(r.delivered).toEqual([]);
    expect(relay.stored).toBe(1);
  });

  it("checks signatures with a pluggable verifier", async () => {
    const key = await deviceKeyFromSeed(new Uint8Array(32).fill(2));
    const signed = await signEnvelope(env("ok", 1), key);
    const seen: string[] = [];
    const trusting = new GossipNode({ verify: (e) => (seen.push(e.message!), e.message === "ok") });
    trusting.subscribe(TOPIC);
    const h = await trusting.handle({ type: "deliver", envelopes: [signed, { ...signed, id: ulid(now * 1000), message: "no" }, env("unsigned", 1)] }, now);
    expect(h.delivered.map((e) => e.message)).toEqual(["ok", "unsigned"]);
    expect(h.dropped.map((d) => d.reason)).toEqual(["bad_signature"]);
    expect(seen).toEqual(["ok", "no"]); // unsigned messages never reach the verifier
    const throwing = new GossipNode({ verify: () => { throw new Error("no crypto"); } });
    throwing.subscribe(TOPIC);
    expect((await throwing.handle({ type: "deliver", envelopes: [signed] }, now)).dropped[0]!.reason).toBe("bad_signature");
  });

  it("runs a session over a byte link", async () => {
    const a = new GossipNode();
    const b = new GossipNode();
    a.subscribe(TOPIC);
    b.subscribe(TOPIC);
    const got: Envelope[] = [];
    let sa: ReturnType<typeof gossipSession>;
    const sb = gossipSession(b, (x) => sa.receive(x), (e) => got.push(e));
    sa = gossipSession(a, (x) => sb.receive(x), () => {});
    a.publish({ ...env("over the link", 1), expires: Math.floor(Date.now() / 1000) + 60 });
    await sa.resync();
    expect(got.map((e) => e.message)).toEqual(["over the link"]);
    expect(parseGossip("{\"type\":\"nope\"}")).toBeNull();
    expect(parseGossip("not json")).toBeNull();
  });
});
