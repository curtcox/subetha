/**
 * Round-trip-time challenges for `net.client.latency` (todo/network_constraints.md §7.1).
 *
 * The verifier answers a request it cannot yet allow with a DPoP nonce (RFC 9449 §8) that encodes
 * its own clock reading; the device re-sends at once with a proof carrying that nonce, and the
 * verifier subtracts. No clock sync with the device and no storage: the nonce is HMAC-sealed,
 * bound to the key (`jkt`) and the peer address it was issued to, and carries the best round trip
 * and the number of samples taken so far, so `samples > 1` needs no state either. A device can
 * always answer later but never sooner, so the measurement is only ever an upper bound.
 */
import { b64u, unb64u } from './jose.js';

export const RTT_NONCE_PREFIX = 'rtt1.';
/** A nonce older than this is not a measurement (the device was not answering a challenge). */
export const RTT_NONCE_MAX_AGE_MS = 10_000;
const NO_SAMPLE = 0xffff;
const enc = new TextEncoder();

async function digest8(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))).slice(0, 8);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * createRttChallenger({ secret, now, maxAgeMs })
 *   secret   — at least 32 bytes (Uint8Array, or a string of at least 32 characters), private to
 *              the verifier; every instance that may see the retry needs the same one.
 *   now      — milliseconds clock (default Date.now). On Workers it advances between requests.
 * Returns { issue({ jkt, peer, samples, best_ms }) → nonce, check(nonce, { jkt, peer }) → result | null }.
 * check gives { rtt_ms (the best so far, this one included), samples (taken, this one included) },
 * or null when the nonce is not one of ours, not for this key and address, or too old.
 */
export function createRttChallenger({ secret, now = () => Date.now(), maxAgeMs = RTT_NONCE_MAX_AGE_MS } = {}) {
  const raw = typeof secret === 'string' ? enc.encode(secret) : secret;
  if (!(raw instanceof Uint8Array) || raw.length < 32) throw new Error('createRttChallenger needs a secret of at least 32 bytes');
  const key = crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = async body => new Uint8Array(await crypto.subtle.sign('HMAC', await key, body)).slice(0, 16);
  // Layout: issued at (6 bytes, ms) ‖ samples taken (1) ‖ best ms so far (2) ‖ jkt hash (8) ‖ peer hash (8) ‖ HMAC (16).
  async function body(t, samples, best, jkt, peer) {
    const out = new Uint8Array(25); const view = new DataView(out.buffer);
    view.setUint16(0, Math.floor(t / 2 ** 32)); view.setUint32(2, t >>> 0);
    out[6] = samples; view.setUint16(7, best);
    out.set(await digest8(`jkt:${jkt}`), 9); out.set(await digest8(`peer:${peer ?? ''}`), 17);
    return out;
  }
  return {
    async issue({ jkt, peer, samples = 0, best_ms } = {}) {
      const best = Number.isFinite(best_ms) ? Math.min(Math.max(0, Math.ceil(best_ms)), NO_SAMPLE - 1) : NO_SAMPLE;
      const b = await body(now(), Math.min(samples, 255), best, jkt, peer);
      const sealed = new Uint8Array(41); sealed.set(b); sealed.set(await mac(b), 25);
      return RTT_NONCE_PREFIX + b64u(sealed);
    },
    async check(nonce, { jkt, peer } = {}) {
      if (typeof nonce !== 'string' || !nonce.startsWith(RTT_NONCE_PREFIX)) return null;
      let sealed;
      try { sealed = unb64u(nonce.slice(RTT_NONCE_PREFIX.length)); } catch { return null; }
      if (sealed.length !== 41) return null;
      const b = sealed.slice(0, 25);
      if (!sameBytes(await mac(b), sealed.slice(25))) return null;
      if (!sameBytes(b.slice(9, 17), await digest8(`jkt:${jkt}`)) || !sameBytes(b.slice(17, 25), await digest8(`peer:${peer ?? ''}`))) return null;
      const view = new DataView(b.buffer);
      const issued = view.getUint16(0) * 2 ** 32 + view.getUint32(2);
      const rtt = now() - issued;
      if (rtt < 0 || rtt > maxAgeMs) return null;
      const best = view.getUint16(7);
      return { rtt_ms: best === NO_SAMPLE ? rtt : Math.min(best, rtt), samples: b[6] + 1 };
    }
  };
}

/**
 * The latency rule a challenge could satisfy: when no grant allows and some grant failed only for
 * `rtt_required` or `rtt_exceeded`, the samples that grant still allows (at least 1 for
 * rtt_required). Returns { samples_left } or null when a challenge cannot help.
 */
export function rttChallengeNeeded(grants, reasons, measured) {
  let left = 0;
  reasons.forEach((list, i) => {
    if (!list.length || !list.every(r => r === 'rtt_required' || r === 'rtt_exceeded')) return;
    const want = grants[i]?.net?.client?.latency?.samples ?? 1;
    left = Math.max(left, want - (measured?.samples ?? 0));
  });
  return left > 0 ? { samples_left: left } : null;
}
