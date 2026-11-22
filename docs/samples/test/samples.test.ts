// Checks every docs sample that can't run against the Worker here: shell scripts parse
// (bash -n), Python compiles (py_compile), JS parses (node --check), JSON parses. Also checks
// that every sample is used by the docs, every include marker resolves, every TypeScript sample
// runs in workers/api/test/samples.test.ts, and the Rust sample is built by cargo.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const samplesDir = new URL("..", import.meta.url).pathname;
const docsDir = join(samplesDir, "..");
const repo = join(docsDir, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === "test" || n === "live" || n === "__pycache__") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(samplesDir).map((p) => relative(samplesDir, p)).filter((p) => !["package.json", "tsconfig.json", "README.md"].includes(p));
const byExt = (ext: string) => files.filter((f) => f.endsWith(ext));
const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

describe("shell samples", () => {
  for (const f of byExt(".sh")) {
    it(`bash -n ${f}`, () => {
      execFileSync("bash", ["-n", join(samplesDir, f)]);
    });
  }
});

describe("python samples", () => {
  const cache = mkdtempSync(join(tmpdir(), "subetha-pyc-"));
  for (const f of byExt(".py")) {
    it.skipIf(!python)(`py_compile ${f}`, () => {
      execFileSync(python!, ["-m", "py_compile", join(samplesDir, f)], { env: { ...process.env, PYTHONPYCACHEPREFIX: cache } });
    });
  }
});

describe("js and json samples", () => {
  for (const f of byExt(".js")) it(`node --check ${f}`, () => void execFileSync(process.execPath, ["--check", join(samplesDir, f)]));
  for (const f of byExt(".json")) it(`parses ${f}`, () => void JSON.parse(readFileSync(join(samplesDir, f), "utf8")));
  for (const f of byExt(".html")) {
    it(`${f} is a complete page`, () => {
      const html = readFileSync(join(samplesDir, f), "utf8");
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain("</html>");
    });
  }
});

describe("coverage", () => {
  const docs = walk(docsDir).filter((p) => p.endsWith(".md") && !p.startsWith(samplesDir));
  const includes = docs.flatMap((d) => [...readFileSync(d, "utf8").matchAll(/<!--\s*include:\s*([^\s#]+)(?:#[\w-]+)?\s*-->/g)].map((m) => ({ doc: relative(docsDir, d), path: m[1]! })));

  it("every include marker points at a file", () => {
    for (const i of includes) expect(statSync(join(docsDir, i.path), { throwIfNoEntry: false })?.isFile(), `${i.doc}: ${i.path}`).toBe(true);
  });

  it("every sample is used by the docs", () => {
    const used = new Set(includes.map((i) => i.path.replace(/^samples\//, "")));
    const unused = files.filter((f) => !f.split("/").pop()!.startsWith("_") && !used.has(f));
    expect(unused).toEqual([]);
  });

  it("every TypeScript sample runs against the Worker", () => {
    const runner = readFileSync(join(repo, "workers/api/test/samples.test.ts"), "utf8");
    for (const f of byExt(".ts")) {
      const name = f.replace(/^ts\//, "").replace(/\.ts$/, "");
      if (name.startsWith("_")) continue;
      expect(runner.includes(`run("${name}")`) || runner.includes(`sample("${name}")`), `${f} is not exercised by workers/api/test/samples.test.ts`).toBe(true);
    }
  });

  it("every Rust sample is a cargo example", () => {
    const cargo = readFileSync(join(repo, "sdk/core/Cargo.toml"), "utf8");
    for (const f of byExt(".rs")) expect(cargo, f).toContain(`../../docs/samples/${f}`);
  });
});
