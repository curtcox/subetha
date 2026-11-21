// ULID generation (spec §1.1). Monotonic within a millisecond.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: number[] = [];

function randomDigits(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b & 31);
}

export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRandom.slice();
    for (let i = 15; i >= 0; i--) {
      if (rand[i]! < 31) {
        rand[i]!++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = randomDigits();
  }
  lastTime = now;
  lastRandom = rand;
  let t = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[n % 32] + t;
    n = Math.floor(n / 32);
  }
  return t + rand.map((d) => CROCKFORD[d]).join("");
}

export function ulidTime(id: string): number {
  let n = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error("invalid ulid");
    n = n * 32 + v;
  }
  return n;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isUlid(s: unknown): s is string {
  return typeof s === "string" && ULID_RE.test(s);
}
