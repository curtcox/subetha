// Endpoint inspector (PLAN §10): renders the result of POST /v1/endpoints/:id/test and checks
// webhook signatures in the browser (the secret never leaves the page).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (micros) => `$${(micros / 1e6).toFixed(6)}`;

function pretty(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

const headerBlock = (h) => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");

/** HTML for one test result. */
export function renderInspection(r) {
  const ok = r.result === "delivered";
  const parts = [
    `<p><b class="${ok ? "ok" : "bad"}">${esc(r.result)}</b> · ${esc(r.endpoint?.kind)} · ${esc(r.latency_ms)} ms · charged ${esc(usd(r.charged_usd_micros ?? 0))}${r.error ? ` · <code>${esc(r.error)}</code>` : ""}</p>`,
  ];
  if (r.request) {
    parts.push(`<h4>Request</h4><pre>${esc(`${r.request.method} ${r.request.url}\n${headerBlock(r.request.headers)}\n\n${pretty(r.request.body)}`)}</pre>`);
  } else {
    parts.push(`<h4>Message</h4><pre>${esc(JSON.stringify(r.message, null, 2))}</pre>`);
  }
  if (r.response) {
    parts.push(`<h4>Response</h4><pre>${esc(`HTTP ${r.response.status}\n${headerBlock(r.response.headers)}\n\n${pretty(r.response.body)}${r.response.truncated ? "\n… (truncated at 4 KB)" : ""}`)}</pre>`);
  } else if (r.detail !== undefined) {
    parts.push(`<h4>Provider</h4><pre>${esc(JSON.stringify(r.detail, null, 2))}</pre>`);
  }
  return parts.join("");
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks an `X-SubEtha-Signature` header (`t=<unix>,v1=<hex>`) against the raw body.
 * Returns { valid, reason, age_s }. `toleranceS` rejects old timestamps (replays); null skips it.
 */
export async function verifyWebhookSignature(secret, header, body, { now = Date.now(), toleranceS = 300 } = {}) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=", 2)).filter((kv) => kv.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return { valid: false, reason: "header must look like t=<unix>,v1=<64 hex>" };
  if (!secret) return { valid: false, reason: "enter the endpoint's signing secret (whsec_…)" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const age = Math.floor(now / 1000) - t;
  if (expected !== parts.v1) return { valid: false, reason: "signature does not match (check the secret, and that the body is byte-for-byte what was received)", age_s: age };
  if (toleranceS !== null && Math.abs(age) > toleranceS) return { valid: false, reason: `signature matches but the timestamp is ${age}s old; reject it as a possible replay`, age_s: age };
  return { valid: true, reason: "signature matches", age_s: age };
}
