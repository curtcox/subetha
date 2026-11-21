// Stable machine-readable errors (spec §9, spec/errors.json).
import errors from "../../../spec/errors.json";

export type ErrorCode = keyof typeof errors;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(code: ErrorCode, message?: string, extra: Record<string, unknown> = {}) {
    super(message ?? errors[code].description);
    this.code = code;
    this.status = errors[code].http;
    this.extra = extra;
  }
  toJSON() {
    return { error: this.code, http: this.status, message: this.message, ...this.extra };
  }
  toResponse(headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(this.toJSON()), {
      status: this.status,
      headers: { "content-type": "application/json", ...headers },
    });
  }
}

/** Re-throws an error serialized across a Durable Object RPC boundary. */
export function reviveError(e: unknown): never {
  const msg = (e as Error)?.message ?? "";
  const m = /^ApiError:(\w+):(.*)$/s.exec(msg);
  if (m) {
    const [code, rest] = [m[1] as ErrorCode, m[2]!];
    let extra: Record<string, unknown> = {};
    let message = rest;
    const sep = rest.indexOf("\u0000");
    if (sep >= 0) {
      message = rest.slice(0, sep);
      extra = JSON.parse(rest.slice(sep + 1));
    }
    throw new ApiError(code, message, extra);
  }
  throw e;
}

/** An error that survives Durable Object RPC (only the message crosses the boundary). */
export function rpcError(code: ErrorCode, message?: string, extra: Record<string, unknown> = {}): Error {
  return new Error(`ApiError:${code}:${message ?? errors[code].description}\u0000${JSON.stringify(extra)}`);
}

/** Errors cross Durable Object RPC as values, not exceptions (thrown RPC errors lose their type). */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string; extra: Record<string, unknown> } };

export async function asResult<T>(fn: () => Promise<T>): Promise<RpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const m = /^ApiError:(\w+):(.*)$/s.exec((e as Error)?.message ?? "");
    if (!m) throw e;
    const rest = m[2]!;
    const sep = rest.indexOf("\u0000");
    return { ok: false, error: { code: m[1] as ErrorCode, message: sep >= 0 ? rest.slice(0, sep) : rest, extra: sep >= 0 ? JSON.parse(rest.slice(sep + 1)) : {} } };
  }
}

export function unwrap<T>(r: RpcResult<T>): T {
  if (r.ok) return r.value;
  throw new ApiError(r.error.code, r.error.message, r.error.extra);
}
