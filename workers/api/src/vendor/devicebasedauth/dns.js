/**
 * The DNS source of `net.client.addresses` (todo/network_constraints.md §3.2, §10): host names
 * resolved over DNS-over-HTTPS (the JSON API of RFC 8484 resolvers such as 1.1.1.1), cached for
 * the answer's TTL bounded to 30–300 s. An answer counts as DNSSEC-validated only when the
 * resolver set the AD bit on both the A and the AAAA answer. A name that cannot be resolved is
 * "unresolved" and matches nothing (spec/evaluation.md §3.10): DNS never allows by failing.
 */
export const DNS_DEFAULTS = Object.freeze({ endpoint: 'https://cloudflare-dns.com/dns-query', minTtl: 30, maxTtl: 300, failureTtl: 5, maxNames: 16, timeoutMs: 2000, maxEntries: 10_000 });
const TYPES = { A: 1, AAAA: 28 };

/**
 * createDohResolver({ endpoint, fetch, now, minTtl, maxTtl, failureTtl, timeoutMs })
 * Returns { resolve(name) → { addrs, dnssec } | 'unresolved', resolveAll(names) → { name: answer } }.
 * `now` is a seconds clock; `fetch` defaults to the global one.
 */
export function createDohResolver(options = {}) {
  const o = { ...DNS_DEFAULTS, ...options };
  const fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  const cache = new Map();

  async function query(name, type) {
    const url = `${o.endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(o.timeoutMs) : undefined;
    const response = await fetcher(url, { headers: { Accept: 'application/dns-json' }, signal });
    if (!response.ok) throw new Error(`DoH ${response.status}`);
    const body = await response.json();
    // NOERROR (0) or NXDOMAIN (3, the name has no addresses); anything else is a failure.
    if (body?.Status !== 0 && body?.Status !== 3) throw new Error(`DoH status ${body?.Status}`);
    const records = (Array.isArray(body.Answer) ? body.Answer : []).filter(r => r?.type === TYPES[type] && typeof r.data === 'string');
    const ttl = records.length ? Math.min(...records.map(r => Number.isFinite(r.TTL) ? r.TTL : o.minTtl)) : o.minTtl;
    return { addrs: records.map(r => r.data), dnssec: body.AD === true, ttl };
  }

  async function resolve(name) {
    const t = now(); const cached = cache.get(name);
    if (cached && cached.until > t) return cached.answer;
    let answer; let ttl;
    try {
      const [a, aaaa] = await Promise.all([query(name, 'A'), query(name, 'AAAA')]);
      answer = { addrs: [...a.addrs, ...aaaa.addrs], dnssec: a.dnssec && aaaa.dnssec };
      ttl = Math.min(o.maxTtl, Math.max(o.minTtl, Math.min(a.ttl, aaaa.ttl)));
    } catch {
      answer = 'unresolved'; ttl = o.failureTtl;
    }
    if (cache.size >= o.maxEntries) cache.delete(cache.keys().next().value);
    cache.set(name, { answer, until: t + ttl });
    return answer;
  }

  /** Resolve up to maxNames distinct names at once; any beyond that are left out (unresolved). */
  async function resolveAll(names) {
    const unique = [...new Set(names)].slice(0, o.maxNames);
    return Object.fromEntries(await Promise.all(unique.map(async name => [name, await resolve(name)])));
  }

  return { resolve, resolveAll };
}

/** Every host name the credential's grants name in net.client.addresses.dns. */
export function grantDnsNames(grants) {
  const names = [];
  for (const grant of Array.isArray(grants) ? grants : []) {
    const listed = grant?.net?.client?.addresses?.dns?.names;
    if (Array.isArray(listed)) names.push(...listed.filter(n => typeof n === 'string'));
  }
  return names;
}
