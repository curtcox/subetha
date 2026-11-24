// Per-account BYO push credentials for APNs and FCM (PLAN §6).
// Private keys are validated with WebCrypto on upload, stored write-only in D1, and never
// returned by GET. Precedence during delivery: endpoint's credential_id → account default for
// that kind → operator's global environment credentials.
import type { Context, Hono } from "hono";
import { ulid } from "@subetha/sdk/protocol";
import { audit } from "./accounts.ts";
import { actorOf, requireAdmin } from "./auth.ts";
import { pemToDer } from "./delivery/push.ts";
import { PermanentError } from "./delivery/senders.ts";
import { ApiError } from "./errors.ts";
import type { Env, Principal } from "./types.ts";

type Vars = { Bindings: Env; Variables: { principal: Principal } };
type App = Hono<Vars>;
type PrincipalFn = (c: Context<Vars>) => Promise<Principal>;

export type PushCredentialKind = "apns" | "fcm";

export interface ApnsCredentialConfig {
  key_p8: string;
  key_id: string;
  team_id: string;
  topic: string;
  sandbox?: boolean;
}

export interface FcmCredentialConfig {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

interface PushCredentialRow {
  id: string;
  account_id: string;
  kind: PushCredentialKind;
  name: string;
  config: string;
  is_default: number;
  created_at: number;
}

function publicCredential(row: PushCredentialRow) {
  const cfg = JSON.parse(row.config) as Record<string, unknown>;
  const summary = row.kind === "apns"
    ? { key_id: cfg.key_id, team_id: cfg.team_id, topic: cfg.topic, sandbox: !!cfg.sandbox }
    : { project_id: cfg.project_id, client_email: cfg.client_email };
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    is_default: !!row.is_default,
    created_at: row.created_at,
    ...summary,
  };
}

async function validateApnsConfig(body: Record<string, unknown>): Promise<ApnsCredentialConfig> {
  const key_p8 = typeof body.key_p8 === "string" ? body.key_p8.trim() : "";
  const key_id = typeof body.key_id === "string" ? body.key_id.trim() : "";
  const team_id = typeof body.team_id === "string" ? body.team_id.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const sandbox = body.sandbox === undefined ? false : Boolean(body.sandbox);
  if (!/^[A-Z0-9]{10}$/i.test(key_id)) throw new ApiError("bad_request", "key_id must be a 10-character Apple Key ID");
  if (!/^[A-Z0-9]{10}$/i.test(team_id)) throw new ApiError("bad_request", "team_id must be a 10-character Apple Team ID");
  if (!topic || topic.length > 200 || /\s/.test(topic)) throw new ApiError("bad_request", "topic (bundle ID) is required");
  if (!key_p8) throw new ApiError("bad_request", "key_p8 (PEM private key) is required");
  try {
    await crypto.subtle.importKey("pkcs8", pemToDer(key_p8) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new ApiError("bad_request", "key_p8 must be a valid PKCS#8 P-256 PEM private key");
  }
  return { key_p8, key_id, team_id, topic, sandbox };
}

async function validateFcmConfig(body: Record<string, unknown>): Promise<FcmCredentialConfig> {
  let raw: Record<string, unknown> = body;
  if (body.service_account !== undefined) {
    if (typeof body.service_account === "string") {
      try {
        raw = JSON.parse(body.service_account) as Record<string, unknown>;
      } catch {
        throw new ApiError("bad_request", "service_account must be valid JSON");
      }
    } else if (typeof body.service_account === "object" && body.service_account !== null && !Array.isArray(body.service_account)) {
      raw = body.service_account as Record<string, unknown>;
    } else {
      throw new ApiError("bad_request", "service_account must be a JSON string or object");
    }
  }
  const project_id = typeof raw.project_id === "string" ? raw.project_id.trim() : "";
  const client_email = typeof raw.client_email === "string" ? raw.client_email.trim() : "";
  const private_key = typeof raw.private_key === "string" ? raw.private_key.trim() : "";
  const private_key_id = typeof raw.private_key_id === "string" && raw.private_key_id.trim() ? raw.private_key_id.trim().slice(0, 128) : undefined;
  if (!/^[a-z0-9][a-z0-9-]{3,63}$/i.test(project_id)) throw new ApiError("bad_request", "invalid Firebase project_id");
  if (!client_email || client_email.length > 200 || !client_email.includes("@")) throw new ApiError("bad_request", "invalid Firebase client_email");
  if (!private_key) throw new ApiError("bad_request", "private_key (PEM) is required");
  if (raw.token_uri !== undefined && raw.token_uri !== "https://oauth2.googleapis.com/token") {
    throw new ApiError("bad_request", "custom token_uri is not supported; use standard Google service accounts");
  }
  try {
    await crypto.subtle.importKey("pkcs8", pemToDer(private_key) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new ApiError("bad_request", "private_key must be a valid PKCS#8 RSA PEM private key");
  }
  return { project_id, client_email, private_key, ...(private_key_id ? { private_key_id } : {}) };
}

/**
 * Resolves the BYO push credential for an endpoint delivery.
 * - If `credentialId` is specified on the endpoint, it must still exist (otherwise PermanentError).
 * - Otherwise returns the account's default credential for `kind`, or null to fall back to operator env.
 */
export async function resolvePushCredential<T>(
  env: Env,
  accountId: string,
  kind: PushCredentialKind,
  credentialId?: string,
): Promise<{ id: string; config: T } | null> {
  if (credentialId) {
    const row = await env.DB.prepare("SELECT id, config FROM push_credentials WHERE id = ? AND account_id = ? AND kind = ?")
      .bind(credentialId, accountId, kind).first<{ id: string; config: string }>();
    if (!row) throw new PermanentError(`push credential ${credentialId} no longer exists`);
    return { id: row.id, config: JSON.parse(row.config) as T };
  }
  const def = await env.DB.prepare("SELECT id, config FROM push_credentials WHERE account_id = ? AND kind = ? AND is_default = 1 LIMIT 1")
    .bind(accountId, kind).first<{ id: string; config: string }>();
  return def ? { id: def.id, config: JSON.parse(def.config) as T } : null;
}

export function registerPushCredentialRoutes(app: App, principal: PrincipalFn) {
  app.get("/v1/push/credentials", async (c) => {
    const accountId = requireAdmin(await principal(c));
    const { results } = await c.env.DB.prepare(
      "SELECT id, account_id, kind, name, config, is_default, created_at FROM push_credentials WHERE account_id = ? ORDER BY created_at DESC",
    ).bind(accountId).all<PushCredentialRow>();
    return c.json({ credentials: results.map(publicCredential) });
  });

  app.post("/v1/push/credentials", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const body = (await c.req.json()) as Record<string, unknown>;
    const kind = body.kind;
    if (kind !== "apns" && kind !== "fcm") throw new ApiError("bad_request", "kind must be apns or fcm");
    const name = body.name === undefined ? "" : typeof body.name === "string" && body.name.length <= 100 ? body.name : (() => { throw new ApiError("bad_request", "name must be a string of up to 100 characters"); })();
    const config = kind === "apns" ? await validateApnsConfig(body) : await validateFcmConfig(body);
    const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_credentials WHERE account_id = ? AND kind = ?")
      .bind(accountId, kind).first<{ n: number }>();
    const isDefault = body.is_default === undefined ? (existing?.n ?? 0) === 0 : Boolean(body.is_default);
    const id = `pcred_${ulid()}`;
    const now = Date.now();
    const row: PushCredentialRow = { id, account_id: accountId, kind, name, config: JSON.stringify(config), is_default: isDefault ? 1 : 0, created_at: now };
    const stmts: D1PreparedStatement[] = [];
    if (isDefault) {
      stmts.push(c.env.DB.prepare("UPDATE push_credentials SET is_default = 0 WHERE account_id = ? AND kind = ?").bind(accountId, kind));
    }
    stmts.push(
      c.env.DB.prepare("INSERT INTO push_credentials (id, account_id, kind, name, config, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.account_id, row.kind, row.name, row.config, row.is_default, row.created_at),
    );
    await c.env.DB.batch(stmts);
    await audit(c.env, accountId, actorOf(p), "push_credential.create", { id, kind, name, is_default: isDefault });
    return c.json(publicCredential(row), 201);
  });

  app.patch("/v1/push/credentials/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const existing = await c.env.DB.prepare("SELECT id, account_id, kind, name, config, is_default, created_at FROM push_credentials WHERE id = ? AND account_id = ?")
      .bind(id, accountId).first<PushCredentialRow>();
    if (!existing) throw new ApiError("not_found");
    const body = (await c.req.json()) as { name?: unknown; is_default?: unknown };
    const stmts: D1PreparedStatement[] = [];
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length > 100) throw new ApiError("bad_request", "name must be a string of up to 100 characters");
      existing.name = body.name;
      stmts.push(c.env.DB.prepare("UPDATE push_credentials SET name = ? WHERE id = ?").bind(body.name, id));
    }
    if (body.is_default !== undefined) {
      if (typeof body.is_default !== "boolean") throw new ApiError("bad_request", "is_default must be a boolean");
      if (body.is_default) {
        stmts.push(c.env.DB.prepare("UPDATE push_credentials SET is_default = 0 WHERE account_id = ? AND kind = ?").bind(accountId, existing.kind));
      }
      existing.is_default = body.is_default ? 1 : 0;
      stmts.push(c.env.DB.prepare("UPDATE push_credentials SET is_default = ? WHERE id = ?").bind(existing.is_default, id));
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    await audit(c.env, accountId, actorOf(p), "push_credential.update", { id, name: body.name, is_default: body.is_default });
    return c.json(publicCredential(existing));
  });

  app.delete("/v1/push/credentials/:id", async (c) => {
    const p = await principal(c);
    const accountId = requireAdmin(p);
    const id = c.req.param("id");
    const r = await c.env.DB.prepare("DELETE FROM push_credentials WHERE id = ? AND account_id = ?").bind(id, accountId).run();
    if (!r.meta.changes) throw new ApiError("not_found");
    await audit(c.env, accountId, actorOf(p), "push_credential.delete", { id });
    return c.json({ deleted: true });
  });
}
