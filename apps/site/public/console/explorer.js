// API explorer (PLAN §10): every operation in the OpenAPI document (/openapi.json, generated
// from spec/openapi.yaml by build.mjs), sent live with the signed-in credential. Pure helpers
// here; the DOM lives in console.js. Tested in apps/site/test/explorer.test.ts.

const METHODS = ["get", "post", "put", "patch", "delete"];

/** Provider callbacks need provider signatures; WebSockets need a socket. Neither fits a form. */
export function unsupported(path) {
  if (path.startsWith("/v1/hooks/")) return "Provider webhook: needs the provider's signature.";
  if (path.endsWith("/ws")) return "WebSocket: use the live inbox or the SDK.";
  return null;
}

export const isStream = (path) => /\/(json|sse|raw)$/.test(path);

/** Follows local $refs (#/components/…), merging allOf objects. */
export function resolve(spec, node, seen = new Set()) {
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    if (seen.has(node.$ref)) return {};
    const target = node.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    return resolve(spec, { ...target, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== "$ref")) }, new Set([...seen, node.$ref]));
  }
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.map((p) => resolve(spec, p, seen));
    const merged = { type: "object", properties: {}, required: [] };
    for (const p of parts) {
      Object.assign(merged.properties, p.properties ?? {});
      merged.required.push(...(p.required ?? []));
    }
    const { allOf: _a, ...rest } = node;
    return { ...merged, ...rest, properties: { ...merged.properties, ...(rest.properties ?? {}) } };
  }
  return node;
}

/** Every operation, in document order: { id, method, path, summary, description, tag, params, body, unsupported, stream, auth }. */
export function operations(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = (item.parameters ?? []).map((p) => resolve(spec, p));
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...shared];
      for (const p of (op.parameters ?? []).map((x) => resolve(spec, x))) {
        const i = params.findIndex((q) => q.name === p.name && q.in === p.in);
        if (i >= 0) params[i] = p; else params.push(p);
      }
      const content = op.requestBody ? resolve(spec, op.requestBody).content ?? {} : null;
      const types = content
        ? Object.entries(content).map(([t, m]) => {
            const s = resolve(spec, m?.schema);
            return { type: t, example: bodyExample(spec, m), binary: s?.format === "binary" || t === "application/octet-stream" };
          })
        : [];
      const first = types[0] ?? null;
      ops.push({
        id: op.operationId ?? `${method} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        tag: op.tags?.[0] ?? "other",
        params: params.filter((p) => ["path", "query", "header"].includes(p.in)),
        body: first ? { type: first.type, example: first.example, binary: first.binary, types } : null,
        unsupported: unsupported(path),
        stream: isStream(path),
        auth: !(Array.isArray(op.security) && op.security.length === 0),
      });
    }
  }
  return ops;
}

function bodyExample(spec, media) {
  if (media.example !== undefined) return media.example;
  const ex = media.examples && Object.values(media.examples)[0];
  if (ex?.value !== undefined) return ex.value;
  return exampleFor(spec, media.schema, 0);
}

/** A small example value for a schema: required properties only, first example/default/enum. */
export function exampleFor(spec, schema, depth = 0) {
  const s = resolve(spec, schema);
  if (!s || depth > 4) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const alt = s.oneOf ?? s.anyOf;
  if (Array.isArray(alt) && alt.length) return exampleFor(spec, alt[0], depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "object" || s.properties) {
    const out = {};
    for (const k of s.required ?? []) out[k] = exampleFor(spec, s.properties?.[k] ?? {}, depth + 1);
    return out;
  }
  if (type === "array") return [exampleFor(spec, s.items ?? {}, depth + 1)].filter((v) => v !== null);
  if (type === "integer" || type === "number") return s.minimum ?? 0;
  if (type === "boolean") return false;
  if (type === "string") return s.format === "binary" ? "" : "";
  return null;
}

/** Topic-like values keep their literal "@" and "/" (the relay reads paths that way). */
const encodePathValue = (v) => String(v).split("/").map((seg) => encodeURIComponent(seg).replace(/^%40/, "@")).join("/").replace(/%2C/gi, ",");

/**
 * Builds a request from an operation and the form values.
 * values: { path: {name: v}, query: {name: v}, header: {name: v}, body: string }
 */
export function buildRequest(baseUrl, op, values = {}) {
  let path = op.path;
  for (const p of op.params.filter((x) => x.in === "path")) {
    const v = values.path?.[p.name];
    if (v === undefined || v === "") throw new Error(`${p.name} is required`);
    path = path.replace(`{${p.name}}`, encodePathValue(v));
  }
  const qs = new URLSearchParams();
  for (const p of op.params.filter((x) => x.in === "query")) {
    const v = values.query?.[p.name];
    if (v !== undefined && v !== "") qs.set(p.name, String(v));
  }
  const headers = {};
  for (const p of op.params.filter((x) => x.in === "header")) {
    const v = values.header?.[p.name];
    if (v !== undefined && v !== "") headers[p.name] = String(v);
  }
  let body;
  const bodyType = values.contentType || op.body?.type;
  if (op.body && values.file !== undefined && values.file !== null) {
    headers["Content-Type"] = values.file.type || bodyType || "application/octet-stream";
    body = values.file;
  } else if (op.body && values.body !== undefined && values.body !== "") {
    headers["Content-Type"] = bodyType;
    if (bodyType === "application/json") JSON.parse(values.body); // fail early on bad JSON
    body = values.body;
  }
  const query = qs.toString();
  const url = `${baseUrl.replace(/\/+$/, "")}${path}${query ? `?${query}` : ""}`;
  return { method: op.method, url, headers, body };
}

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export function toCurl(req, { auth = true } = {}) {
  const parts = ["curl"];
  if (req.method !== "GET" || req.body !== undefined) parts.push(`-X ${req.method}`);
  if (auth) parts.push(`-H "Authorization: Bearer $SUBETHA_TOKEN"`);
  for (const [k, v] of Object.entries(req.headers)) parts.push(`-H ${sq(`${k}: ${v}`)}`);
  if (req.body !== undefined) parts.push(`--data-binary ${sq(req.body)}`);
  parts.push(sq(req.url));
  return parts.join(" \\\n  ");
}
