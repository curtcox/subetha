// IP allow-lists for API tokens (PLAN §9: "IP or origin restrictions"). Entries are IPv4 or
// IPv6 addresses or CIDR ranges; an IPv4-mapped IPv6 address (::ffff:1.2.3.4) matches IPv4 entries.

interface Addr { v: 4 | 6; n: bigint }

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return null;
    const x = Number(p);
    if (x > 255) return null;
    n = (n << 8n) | BigInt(x);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail: bigint | null = null;
  // A trailing dotted quad fills the last 32 bits.
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail = parseV4(s.slice(lastColon + 1));
    if (tail === null) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail !== null) n = (n & ~0xffffffffn) | tail;
  return n;
}

export function parseIp(s: string): Addr | null {
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s.replace(/^\[|\]$/g, ""));
  if (v6 === null) return null;
  // IPv4-mapped IPv6 → IPv4
  if (v6 >> 32n === 0xffffn) return { v: 4, n: v6 & 0xffffffffn };
  return { v: 6, n: v6 };
}

interface Range { v: 4 | 6; base: bigint; bits: number }

export function parseCidr(s: string): Range | null {
  const [ip, len, extra] = s.trim().split("/");
  if (extra !== undefined || !ip) return null;
  const a = parseIp(ip);
  if (!a) return null;
  const max = a.v === 4 ? 32 : 128;
  let bits = max;
  if (len !== undefined) {
    if (!/^\d{1,3}$/.test(len)) return null;
    bits = Number(len);
    if (bits > max) return null;
  }
  return { v: a.v, base: a.n, bits };
}

function contains(r: Range, a: Addr): boolean {
  if (r.v !== a.v) return false;
  const max = r.v === 4 ? 32 : 128;
  const shift = BigInt(max - r.bits);
  return r.base >> shift === a.n >> shift;
}

/** True if `ip` falls in any of `entries` (addresses or CIDRs). An unparseable ip never matches. */
export function ipAllowed(ip: string | null | undefined, entries: string[]): boolean {
  if (!ip) return false;
  const a = parseIp(ip);
  if (!a) return false;
  return entries.some((e) => {
    const r = parseCidr(e);
    return r !== null && contains(r, a);
  });
}
