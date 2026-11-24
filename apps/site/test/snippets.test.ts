import { execFileSync } from "node:child_process";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module served as-is to the console
import { LANGUAGES, snippet } from "../public/console/snippets.js";

const has = (cmd: string) => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const tricky = { baseUrl: "http://localhost:8787/", topic: "@me/door", message: `It's "open" $HOME \\ ok\nline2`, title: "Front's $door", priority: 5, tags: ["door", "warn"], click: "https://example.com/cam", icon: "https://example.com/bell.png", markdown: true, idempotencyKey: "k-123", mode: "all", maxCostUsd: 0.05, deadlineS: 60, deny: ["sms"], allow: ["ws", "webpush"] };
const plain = { baseUrl: "https://subetha.us", topic: "@me/door", message: "hi", priority: 3, mode: "any" };

describe("copy as …", () => {
  it("covers every language and omits defaults", () => {
    for (const lang of LANGUAGES) {
      const s: string = snippet(lang, plain);
      expect(s).toContain("@me/door");
      expect(s).not.toMatch(/priority|Priority|route|Route-Mode|localhost/);
    }
    expect(() => snippet("cobol", plain)).toThrow();
  });

  it("carries every field", () => {
    expect(snippet("curl", tricky)).toContain(`-H "X-Max-Cost: 0.05"`);
    expect(snippet("curl", tricky)).toContain(`-H "X-Deadline: 60"`);
    expect(snippet("curl", tricky)).toContain(`-H 'X-Click: https://example.com/cam'`);
    expect(snippet("python", tricky)).toContain(`"max_cost_usd_micros": 50000`);
    expect(snippet("python", tricky)).toContain(`"deadline_s": 60`);
    expect(snippet("python", tricky)).toContain(`click="https://example.com/cam"`);
    expect(snippet("swift", tricky)).toContain("Route(mode: .all, maxCostUSD: 0.05, deadlineSeconds: 60");
    expect(snippet("swift", tricky)).toContain(`icon: "https://example.com/bell.png"`);
    expect(snippet("swift", tricky)).toContain(`contentType: "text/markdown"`);
    expect(snippet("kotlin", tricky)).toContain("deadlineS = 60");
    expect(snippet("kotlin", tricky)).toContain(`icon = "https://example.com/bell.png"`);
    expect(snippet("kotlin", tricky)).toContain(`contentType = "text/markdown"`);
    expect(snippet("dart", tricky)).toContain("deadlineS: 60");
    expect(snippet("dart", tricky)).toContain(`icon: 'https://example.com/bell.png'`);
    expect(snippet("dart", tricky)).toContain(`contentType: 'text/markdown'`);
    expect(snippet("js", tricky)).toContain("deadlineS: 60");
    expect(snippet("kotlin", tricky)).toContain("RouteMode.ALL");
    expect(snippet("kotlin", tricky)).toContain(`"Front's \\$door"`);
    expect(snippet("dart", tricky)).toContain(`'Front\\'s \\$door'`);
    expect(snippet("curl", tricky)).toContain(`-H "X-Allow: ws,webpush"`);
    expect(snippet("curl", tricky)).toContain(`-H "X-Markdown: 1"`);
    expect(snippet("curl", tricky)).toContain(`-H 'Idempotency-Key: k-123'`);
    expect(snippet("js", tricky)).toContain(`allow: ["ws","webpush"]`);
    expect(snippet("js", tricky)).toContain(`contentType: "text/markdown"`);
    expect(snippet("python", tricky)).toContain(`"allow": ["ws","webpush"]`);
    expect(snippet("python", tricky)).toContain(`content_type="text/markdown"`);
    expect(snippet("python", tricky)).toContain(`from subetha import Client`);
    expect(snippet("js", tricky)).toContain(`baseUrl: "http://localhost:8787"`);
    const withFile = { ...plain, file: { name: "snap.jpg", type: "image/jpeg" }, actions: [{ action: "view", label: "Open", url: "https://example.com" }], sign: true };
    expect(snippet("curl", withFile)).toContain(`-T 'snap.jpg'`);
    expect(snippet("curl", withFile)).toContain(`X-Actions:`);
    expect(snippet("js", withFile)).toContain(`publishFile`);
    expect(snippet("js", withFile)).toContain(`sign: true`);
    expect(snippet("python", withFile)).toContain(`publish_file`);
  });

  it("produces valid JavaScript", () => {
    for (const p of [plain, tricky]) expect(() => transformSync(snippet("js", p), { loader: "ts", format: "esm" })).not.toThrow();
  });

  it.skipIf(!has("bash"))("produces a shell command that sends the exact message", () => {
    const cmd = snippet("curl", tricky).replace(/^curl/, "printf '%s\\n'");
    const out = execFileSync("bash", ["-c", cmd], { encoding: "utf8", env: { SUBETHA_TOKEN: "se_x", PATH: process.env.PATH } });
    expect(out).toContain(tricky.message);
    expect(out).toContain("X-Title: Front's $door");
    expect(out).toContain("Authorization: Bearer se_x");
  });

  it.skipIf(!has("python3"))("produces valid Python with the exact message", () => {
    const src = snippet("python", tricky);
    const check = `import ast,sys\nt=ast.parse(sys.stdin.read())\ncall=t.body[-1].value\nprint(ast.literal_eval(call.args[1]))`;
    expect(execFileSync("python3", ["-I", "-c", check], { input: src, encoding: "utf8" }).trimEnd()).toBe(tricky.message);
  });
});
