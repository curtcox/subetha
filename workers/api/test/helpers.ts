import { env, SELF } from "cloudflare:test";
import { base64urlEncode, utf8 } from "@subetha/sdk/protocol";

export const BASE = "https://subetha.test";

export async function bootstrap(handle: string, creditUsd = 1): Promise<{ account_id: string; token: string; handle: string }> {
  const r = await SELF.fetch(`${BASE}/v1/dev/bootstrap`, { method: "POST", body: JSON.stringify({ secret: "test-secret", handle, credit_usd: creditUsd }) });
  if (r.status !== 201) throw new Error(`bootstrap failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export function auth(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

export async function publish(topic: string, message: string, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/${topic}`, { method: "POST", body: message, headers });
}

export async function balance(token: string): Promise<number> {
  const r = await SELF.fetch(`${BASE}/v1/balance`, { headers: auth(token) });
  return ((await r.json()) as { available_usd_micros: number }).available_usd_micros;
}

export async function clerkJwt(sub: string, opts: { exp?: number; iss?: string; typ?: string; claims?: Record<string, unknown> } = {}): Promise<string> {
  const jwk = JSON.parse((env as unknown as { TEST_CLERK_PRIVATE_JWK: string }).TEST_CLERK_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = (o: unknown) => base64urlEncode(utf8.encode(JSON.stringify(o)));
  const head = enc({ alg: "RS256", kid: "test-kid", typ: opts.typ ?? "JWT" });
  const body = enc({ sub, iss: opts.iss ?? "https://clerk.test", exp: opts.exp ?? Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000), ...opts.claims });
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64urlEncode(sig)}`;
}

export async function readUntil(stream: ReadableStream<Uint8Array>, predicate: (text: string) => boolean, timeoutMs = 3000): Promise<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(text)) {
      if (Date.now() > deadline) throw new Error(`timeout; got: ${text}`);
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), deadline - Date.now()))]);
      if (r.done) break;
      text += r.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}
