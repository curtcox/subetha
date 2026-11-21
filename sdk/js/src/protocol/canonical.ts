// Canonical JSON (spec §3): a strict subset of RFC 8785.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

export class CanonicalError extends Error {}

function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) {
      if (c === 0x08) out += "\\b";
      else if (c === 0x0c) out += "\\f";
      else if (c === 0x0a) out += "\\n";
      else if (c === 0x0d) out += "\\r";
      else if (c === 0x09) out += "\\t";
      else out += "\\u" + c.toString(16).padStart(4, "0");
    } else if (c >= 0xd800 && c <= 0xdfff) {
      // Must be a well-formed surrogate pair.
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      } else throw new CanonicalError("lone surrogate in string");
    } else out += s[i];
  }
  return out + '"';
}

/** Serialize a JSON value canonically. Nulls/undefined inside objects are dropped. */
export function canonicalize(value: Json | undefined): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CanonicalError(`non-integer or unsafe number: ${value}`);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  const keys = Object.keys(value)
    .filter((k) => value[k] !== null && value[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    "{" +
    keys
      .map((k) => {
        if (!/^[\x20-\x7e]*$/.test(k)) throw new CanonicalError(`non-ASCII object key: ${k}`);
        return escapeString(k) + ":" + canonicalize(value[k]);
      })
      .join(",") +
    "}"
  );
}

/** Canonical form of an envelope for signing: drops `sig` and `hops`. */
export function canonicalEnvelope(env: Record<string, unknown>): string {
  const { sig: _sig, hops: _hops, ...rest } = env;
  return canonicalize(rest as Json);
}
