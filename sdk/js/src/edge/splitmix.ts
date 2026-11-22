// SplitMix64: small deterministic PRNG (not cryptographic), bit-identical to
// sdk/core/src/random.rs. Used for fountain-code block selection.

const MASK = (1n << 64n) - 1n;

export class SplitMix64 {
  private state: bigint;
  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  }

  /** Uniform in [0, 1). */
  nextF64(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /** Uniform in [0, n) by multiply-shift; n must be > 0. */
  below(n: number): number {
    return Number((this.nextU64() * BigInt(n)) >> 64n);
  }
}
