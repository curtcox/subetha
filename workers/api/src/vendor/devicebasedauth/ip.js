/**
 * IPv4 and IPv6 addresses and CIDR ranges, shared by `where.networks` and the `net` constraint
 * (spec/evaluation.md §3.4, §3.10). Address families never match each other.
 */

/** Parse an IPv4 or IPv6 address to a BigInt and its bit width, or null. */
export function parseIp(ip) {
  if (typeof ip !== 'string') return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return null;
    return { bits: 32, value: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n) };
  }
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(':')) return null;
  let address = ip;
  const v4 = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const parsed = parseIp(v4[1]); if (!parsed) return null;
    address = address.slice(0, -v4[1].length) + ((parsed.value >> 16n).toString(16)) + ':' + ((parsed.value & 0xffffn).toString(16));
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return { bits: 128, value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

/** Parse a CIDR range, or null when invalid. */
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const [ip, prefixText, extra] = cidr.split('/');
  if (extra !== undefined || prefixText === undefined || !/^\d{1,3}$/.test(prefixText)) return null;
  const parsed = parseIp(ip); const prefix = Number(prefixText);
  if (!parsed || prefix > parsed.bits) return null;
  return { ...parsed, prefix };
}

/** True when ip is inside the CIDR range. Address families never match each other. */
export function ipInCidr(ip, cidr) {
  const address = parseIp(ip); const range = parseCidr(cidr);
  if (!address || !range || address.bits !== range.bits) return false;
  const shift = BigInt(range.bits - range.prefix);
  return (address.value >> shift) === (range.value >> shift);
}

/** True when two strings are the same address, however each is written ("2001:db8::1", "2001:DB8:0::1"). */
export function sameIp(a, b) {
  const x = parseIp(a); const y = parseIp(b);
  return Boolean(x && y) && x.bits === y.bits && x.value === y.value;
}
