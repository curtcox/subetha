// Keeps spec/openapi.yaml in sync with the routes the Worker registers, spec/errors.json, and the
// envelope JSON Schema. If this fails after adding a route, document it in openapi.yaml.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");

type Op = { [k: string]: unknown };
type PathItem = { [method: string]: Op | unknown } & { "x-pending"?: boolean };
const spec = parse(read("spec/openapi.yaml")) as { openapi: string; paths: Record<string, PathItem>; components: { schemas: Record<string, any> } };
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((n) => {
    const p = join(dir, n);
    return statSync(join(root, p)).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Every `app.<method>("<path>"` in the Worker source, with Hono params turned into OpenAPI form. */
function workerRoutes(): { method: string; path: string; file: string }[] {
  const out: { method: string; path: string; file: string }[] = [];
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (const file of sourceFiles("workers/api/src")) {
    for (const m of read(file).matchAll(re)) {
      const path = m[2]!.replace(/:(\w+)(\{[^}]*\})?\??/g, "{$1}"); // ":name?" (optional) is documented as required
      out.push({ method: m[1]!, path, file });
    }
  }
  return out;
}

describe("openapi.yaml", () => {
  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
  });

  const routes = workerRoutes();
  it("finds the Worker's routes", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some((r) => r.file.endsWith("control.ts"))).toBe(true);
  });

  for (const r of routes) {
    it(`documents ${r.method.toUpperCase()} ${r.path}`, () => {
      const item = spec.paths[r.path];
      expect(item, `${r.path} (${r.file}) is missing from spec/openapi.yaml`).toBeDefined();
      expect(item![r.method], `${r.method.toUpperCase()} ${r.path} (${r.file}) is missing from spec/openapi.yaml`).toBeDefined();
    });
  }

  it("documents the ntfy publish and subscribe paths", () => {
    // These are served by the catch-all route, not by app.<method>("…").
    expect(spec.paths["/"]?.post).toBeDefined();
    expect(spec.paths["/{topic}"]?.put).toBeDefined();
    expect(spec.paths["/{topic}"]?.post).toBeDefined();
    const formats = /const FORMATS = new Set\(\[([^\]]+)\]\)/.exec(read("workers/api/src/ntfy.ts"))![1]!.match(/"(\w+)"/g)!.map((s) => s.slice(1, -1));
    expect(formats).toContain("json");
    for (const f of formats) expect(spec.paths[`/{topics}/${f}`]?.get, `/{topics}/${f}`).toBeDefined();
  });

  it("documents the publish headers the relay reads", () => {
    const src = read("workers/api/src/ntfy.ts");
    const headers = new Set([...src.matchAll(/header\(req, url, "([^"]+)"/g)].map((m) => m[1]!.toLowerCase()));
    const params = (spec as any).components.parameters as Record<string, { name: string; in: string }>;
    const documented = new Set(Object.values(params).filter((p) => p.in === "header").map((p) => p.name.toLowerCase()));
    for (const h of headers) expect(documented.has(h), `header ${h}`).toBe(true);
    expect(documented.has("idempotency-key")).toBe(true);
  });

  it("only documents routes that exist (or are marked x-pending)", () => {
    const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const [path, item] of Object.entries(spec.paths)) {
      if (path === "/" || path.startsWith("/{topic")) continue;
      if (item["x-pending"]) continue;
      for (const m of METHODS) if (item[m]) expect(known.has(`${m} ${path}`), `${m.toUpperCase()} ${path} is documented but not implemented`).toBe(true);
    }
  });

  it("error codes match spec/errors.json", () => {
    const errors = JSON.parse(read("spec/errors.json")) as Record<string, { http: number }>;
    expect([...spec.components.schemas.Error.properties.error.enum].sort()).toEqual(Object.keys(errors).sort());
  });

  it("Envelope mirrors spec/schema/message.schema.json", () => {
    const schema = JSON.parse(read("spec/schema/message.schema.json"));
    const env = spec.components.schemas.Envelope;
    expect(Object.keys(env.properties).sort()).toEqual(Object.keys(schema.properties).sort());
    expect(env.required).toEqual(schema.required);
    for (const k of ["id", "topic", "sender", "sig"]) expect(env.properties[k].pattern, k).toBe(schema.properties[k].pattern);
    for (const k of ["title", "message"]) expect(env.properties[k].maxLength, k).toBe(schema.properties[k].maxLength);
    expect(spec.components.schemas.Transport.enum).toEqual(schema.$defs.transport.enum);
  });

  it("every $ref resolves", () => {
    const text = read("spec/openapi.yaml");
    for (const m of text.matchAll(/\$ref: "#\/components\/(\w+)\/(\w+)"/g)) {
      expect((spec as any).components[m[1]!]?.[m[2]!], m[0]).toBeDefined();
    }
  });
});
