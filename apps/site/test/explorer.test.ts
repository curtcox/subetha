import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
// @ts-expect-error plain JS module served as-is to the console
import { buildRequest, exampleFor, operations, resolve, toCurl } from "../public/console/explorer.js";

const spec = parse(readFileSync(new URL("../../../spec/openapi.yaml", import.meta.url), "utf8"), { merge: true });
const ops = operations(spec);
const op = (id: string) => ops.find((o: { id: string }) => o.id === id);

describe("API explorer", () => {
  it("lists every operation with resolved parameters", () => {
    const count = Object.values(spec.paths as Record<string, object>).reduce((n: number, item) => n + Object.keys(item).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)).length, 0);
    expect(ops.length).toBe(count);
    for (const o of ops) for (const p of o.params) expect(p.name, `${o.id} has an unresolved parameter`).toBeTruthy();
    const publish = op("publish");
    expect(publish.params.some((p: { in: string; name: string }) => p.in === "path" && p.name === "topic")).toBe(true);
    expect(publish.params.some((p: { name: string }) => p.name === "X-Dry-Run")).toBe(true);
    expect(publish.body.type).toBe("text/plain");
  });

  it("marks unsupported, streaming, and public operations", () => {
    expect(ops.filter((o: { unsupported: string | null }) => o.unsupported).every((o: { path: string }) => o.path.startsWith("/v1/hooks/") || o.path.endsWith("/ws"))).toBe(true);
    expect(ops.find((o: { path: string }) => o.path === "/{topics}/json").stream).toBe(true);
    expect(ops.find((o: { path: string }) => o.path === "/v1/health").auth).toBe(false);
  });

  it("produces example bodies that satisfy required fields", () => {
    expect(op("publishJson").body.example.topic).toBe("@alice/doorbell");
    const token = op("createToken").body.example;
    expect(token.scopes).toEqual(["publish:@alice/*"]);
    expect(exampleFor(spec, { $ref: "#/components/schemas/Envelope" })).toBeTypeOf("object");
    expect(resolve(spec, { $ref: "#/components/parameters/XDryRun" }).in).toBe("header");
  });

  it("builds requests with literal topics and curl", () => {
    const req = buildRequest("https://subetha.us/", op("publish"), { path: { topic: "@me/door bell" }, header: { "X-Dry-Run": "1", "X-Title": "" }, body: "hi" });
    expect(req.url).toBe("https://subetha.us/@me/door%20bell");
    expect(req.headers).toEqual({ "X-Dry-Run": "1", "Content-Type": "text/plain" });
    expect(toCurl(req)).toBe(`curl \\\n  -X POST \\\n  -H "Authorization: Bearer $SUBETHA_TOKEN" \\\n  -H 'X-Dry-Run: 1' \\\n  -H 'Content-Type: text/plain' \\\n  --data-binary 'hi' \\\n  'https://subetha.us/@me/door%20bell'`);
    const sub = buildRequest("http://x", ops.find((o: { path: string }) => o.path === "/{topics}/json"), { path: { topics: "@a/b,t_x" }, query: { poll: "1" } });
    expect(sub.url).toBe("http://x/@a/b,t_x/json?poll=1");
    expect(() => buildRequest("http://x", op("publish"), {})).toThrow(/topic is required/);
    expect(() => buildRequest("http://x", op("publishJson"), { body: "{nope" })).toThrow();
  });
});
