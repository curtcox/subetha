/**
 * The named-list source of `net.client.addresses` (todo/network_constraints.md §4): lists are
 * published by the issuer as signed `dba-addresses+jwt` documents at the URI the grant names.
 *
 * - A copy is used for at most `maxAge` seconds (the publisher's Cache-Control is 60 s).
 * - When a fetch fails, the last good copy is served for up to `staleFor` seconds more (10 min);
 *   after that the list is "unavailable" and matches nothing (spec/evaluation.md §3.10).
 * - A copy with a lower `ver` than one already seen is ignored (no rollback to a wider list).
 * - A deleted list (a signed tombstone) and an expired copy match nothing.
 */
import { decodeJws, verifyJws } from './jose.js';

export const ADDRESS_LIST_TYP = 'dba-addresses+jwt';
export const ADDRESS_LIST_DEFAULTS = Object.freeze({ maxAge: 60, staleFor: 600, failureBackoff: 5, maxLists: 8, maxEntries: 10_000, maxBytes: 2 * 1024 * 1024, clockSkew: 60 });

/** Every list the grants name in net.client.addresses.lists, once each: [{ id, uri }]. */
export function grantAddressLists(grants) {
  const seen = new Map();
  for (const grant of Array.isArray(grants) ? grants : []) {
    const lists = grant?.net?.client?.addresses?.lists;
    if (Array.isArray(lists)) for (const l of lists) if (l && typeof l.id === 'string' && typeof l.uri === 'string' && !seen.has(l.id)) seen.set(l.id, { id: l.id, uri: l.uri });
  }
  return [...seen.values()];
}

/**
 * Check one fetched list document. `keys` is the issuer's JWKS ({ keys: [...] }).
 * Returns the payload, or null when it is not a valid list for this id and URI.
 */
export async function verifyAddressList(jwt, { id, uri, issuer, keys, now, clockSkew = ADDRESS_LIST_DEFAULTS.clockSkew }) {
  let header;
  try { ({ header } = decodeJws(jwt, ADDRESS_LIST_DEFAULTS.maxBytes)); } catch { return null; }
  const key = keys?.keys?.find(k => k.kid === header.kid);
  if (!key || header.typ !== ADDRESS_LIST_TYP) return null;
  let payload;
  try { ({ payload } = await verifyJws(jwt, key, ADDRESS_LIST_DEFAULTS.maxBytes)); } catch { return null; }
  if (payload.iss !== issuer || payload.sub !== uri || payload.id !== id) return null;
  if (!Number.isSafeInteger(payload.ver) || !Number.isSafeInteger(payload.exp) || payload.exp < now - clockSkew) return null;
  if (!Array.isArray(payload.cidrs) || payload.cidrs.some(c => typeof c !== 'string')) return null;
  return payload;
}

/**
 * createAddressListResolver({ issuer, fetch, now, jwks, maxAge, staleFor })
 * `jwks(force)` returns the issuer's key set (the verifier's cached one); `now` is a seconds clock.
 * Returns { resolveAll(refs) → { id: { cidrs, ver } | 'unavailable' } }.
 */
export function createAddressListResolver(options) {
  const o = { ...ADDRESS_LIST_DEFAULTS, ...options };
  const fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
  const now = options.now || (() => Math.floor(Date.now() / 1000));
  // id -> { list: { cidrs, ver } | null (deleted), ver, fresh_until, good_until, failed_until }
  const cache = new Map();

  async function fetchList({ id, uri }, t) {
    let response;
    try { response = await fetcher(uri, { headers: { Accept: 'application/jwt' } }); } catch { return undefined; }
    if (!response.ok) return undefined;
    const text = (await response.text()).trim();
    if (text.length > o.maxBytes) return undefined;
    let payload = await verifyAddressList(text, { id, uri, issuer: o.issuer, keys: await options.jwks(false), now: t, clockSkew: o.clockSkew });
    // A key the cached JWKS does not hold yet: ask once more with a refreshed set.
    if (!payload) payload = await verifyAddressList(text, { id, uri, issuer: o.issuer, keys: await options.jwks(true), now: t, clockSkew: o.clockSkew });
    return payload || undefined;
  }

  async function resolve(ref) {
    const t = now(); const cached = cache.get(ref.id);
    if (cached && cached.uri === ref.uri && cached.fresh_until > t) return cached;
    if (cached && cached.uri === ref.uri && cached.failed_until > t) return cached;
    const payload = await fetchList(ref, t);
    if (payload && (!cached || cached.uri !== ref.uri || payload.ver >= cached.ver)) {
      const entry = { uri: ref.uri, ver: payload.ver, list: payload.deleted ? null : { cidrs: payload.cidrs, ver: payload.ver }, exp: payload.exp, fresh_until: t + o.maxAge, good_until: t + o.maxAge + o.staleFor, failed_until: 0 };
      if (!cache.has(ref.id) && cache.size >= o.maxEntries) cache.delete(cache.keys().next().value);
      cache.set(ref.id, entry);
      return entry;
    }
    // A failed fetch or a rolled-back copy: keep serving what we had (until it goes stale).
    if (cached && cached.uri === ref.uri) {
      cached.failed_until = t + o.failureBackoff;
      if (payload) cached.fresh_until = t + o.maxAge; // a lower ver answered: the newer copy stays fresh
      return cached;
    }
    return null;
  }

  async function resolveAll(refs) {
    const t = now(); const out = {};
    const unique = [...new Map((refs || []).map(r => [r.id, r])).values()].slice(0, o.maxLists);
    await Promise.all(unique.map(async ref => {
      const entry = await resolve(ref);
      const usable = entry && entry.list && entry.good_until > t && entry.exp >= t - o.clockSkew;
      out[ref.id] = usable ? entry.list : 'unavailable';
    }));
    return out;
  }

  return { resolveAll };
}
