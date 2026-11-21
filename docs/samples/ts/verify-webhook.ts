// Verify X-SubEtha-Signature on an incoming webhook:
//   t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Works in Node 18+, Deno, Bun, Workers, and browsers (WebCrypto).

// #region snippet
export async function verifyWebhook(secret: string, header: string | null, rawBody: string, toleranceS = 300): Promise<boolean> {
  const parts = Object.fromEntries((header ?? "").split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  let diff = expected.length ^ parts.v1.length; // constant-time comparison
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (parts.v1.charCodeAt(i) || 0);
  return diff === 0;
}

/** A handler for any runtime with Request/Response (Workers, Deno, Bun, Node 18+ frameworks). */
export async function handleWebhook(req: Request, secret: string): Promise<Response> {
  const body = await req.text();
  if (!(await verifyWebhook(secret, req.headers.get("x-subetha-signature"), body))) return new Response("bad signature", { status: 401 });
  const message = JSON.parse(body) as { id: string; topic: string; message?: string };
  console.log(`${message.topic}: ${message.message}`);
  return new Response("ok");
}
// #endregion snippet
