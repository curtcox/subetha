#!/usr/bin/env node
// Static docs builder (PLAN §10, §13). Dependency-light: just `marked`.
//
//   node build.mjs                      → apps/site/public/{docs/*.html,docs/*.md,llms.txt,llms-full.txt,openapi.yaml}
//   node build.mjs --out ../../site-build --base /subetha/ --pages
//                                        → a self-contained GitHub Pages site (adds the landing page,
//                                          build info, and the pricing report; links the console on
//                                          the production app)
//
// Options (or env): --out (SITE_OUT), --base (SITE_BASE, default "/"), --site-url (SITE_URL, the
// public URL of this build, default https://subetha.org), --app-url (APP_URL, where the console
// and API live, default https://subetha.org), --pages, --test-results DIR.
//
// Markdown extensions:
//   <!-- include: samples/x.sh -->            fenced code from a file (paths relative to docs/)
//   <!-- include: samples/x.ts#snippet -->    only the lines between "#region snippet" and "#endregion"
//   <!-- embed: ../pricing/generated/report.md -->  inline another Markdown file (headings demoted)
//   <!-- errors-table -->                     the error codes from spec/errors.json
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { Marked } from "marked";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const docsDir = join(repo, "docs");
const publicDir = join(here, "public");

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (name, env, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : process.env[env] ?? dflt;
};
const out = join(process.cwd(), opt("out", "SITE_OUT", relative(process.cwd(), publicDir)));
const base = opt("base", "SITE_BASE", "/").replace(/\/?$/, "/");
const siteUrl = opt("site-url", "SITE_URL", "https://subetha.org").replace(/\/$/, "");
const appUrl = opt("app-url", "APP_URL", "https://subetha.org").replace(/\/$/, "");
const pages = argv.includes("--pages");
const testResults = opt("test-results", "TEST_RESULTS", "");
const REPO_URL = `https://github.com/${process.env.GITHUB_REPOSITORY ?? "curtcox/subetha"}`;

// ---------------------------------------------------------------- navigation
/** Order of the sidebar. Every docs/*.md must be listed (the build fails otherwise). */
const NAV = [
  ["index", "Overview"],
  ["getting-started", "Getting started"],
  ["concepts", "Concepts"],
  ["publishing", "Publishing"],
  ["subscribing", "Subscribing"],
  ["transports", "Transports"],
  ["pricing", "Pricing & billing"],
  ["tokens", "Tokens & policies"],
  ["devices", "Devices"],
  ["sdks", "SDKs & CLI"],
  ["agents", "Agents (MCP, llms.txt)"],
  ["self-hosting", "Self-hosting & gateways"],
  ["api", "API reference"],
];
const LEGAL = [
  ["legal/terms", "Terms of Service"],
  ["legal/privacy", "Privacy Policy"],
  ["legal/aup", "Acceptable Use Policy"],
];

const listed = new Set(NAV.map(([s]) => s));
const onDisk = readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
const missing = onDisk.filter((s) => !listed.has(s) && s !== "README");
if (missing.length) throw new Error(`docs not in NAV (apps/site/build.mjs): ${missing.join(", ")}`);
for (const [slug] of [...NAV, ...LEGAL]) if (!existsSync(join(docsDir, `${slug}.md`))) throw new Error(`docs/${slug}.md is in NAV but doesn't exist`);

// ---------------------------------------------------------------- markdown expansion
const LANG = { ".sh": "bash", ".ts": "ts", ".js": "js", ".mjs": "js", ".py": "python", ".json": "json", ".html": "html", ".rs": "rust", ".toml": "toml", ".yaml": "yaml", ".yml": "yaml", ".md": "markdown" };

function region(text, name, file) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`#region ${name}\\b`).test(l));
  const end = lines.findIndex((l, i) => i > start && /#endregion\b/.test(l));
  if (start < 0 || end < 0) throw new Error(`${file}: no #region ${name}`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return body.map((l) => l.slice(indent)).join("\n");
}

function errorsTable() {
  const errors = JSON.parse(readFileSync(join(repo, "spec/errors.json"), "utf8"));
  return ["| Code | HTTP | Meaning |", "|---|---:|---|", ...Object.entries(errors).map(([code, e]) => `| \`${code}\` | ${e.http} | ${e.description} |`)].join("\n");
}

/** Expands include/embed/errors-table markers. Returns Markdown. */
function expand(md, from) {
  return md
    .replace(/<!--\s*include:\s*([^\s#]+)(?:#([\w-]+))?\s*-->/g, (_m, path, name) => {
      const file = join(docsDir, path);
      if (!existsSync(file)) throw new Error(`${from}: include not found: ${path}`);
      let text = readFileSync(file, "utf8").replace(/\s+$/, "");
      if (name) text = region(text, name, path);
      const fence = text.includes("```") ? "````" : "```";
      return `${fence}${LANG[extname(path)] ?? ""} title="${path}"\n${text}\n${fence}`;
    })
    .replace(/<!--\s*embed:\s*(\S+)\s*-->/g, (_m, path) => {
      const file = join(docsDir, path);
      if (!existsSync(file)) throw new Error(`${from}: embed not found: ${path}`);
      return readFileSync(file, "utf8").replace(/^(#{1,5}) /gm, "#$1 ");
    })
    .replace(/<!--\s*errors-table\s*-->/g, errorsTable);
}

// ---------------------------------------------------------------- rendering
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&\w+;/g, "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function makeMarked() {
  const seen = new Map();
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        let id = slugify(html) || "section";
        const n = seen.get(id) ?? 0;
        seen.set(id, n + 1);
        if (n) id += `-${n}`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${html}</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        const [language, ...rest] = (lang ?? "").split(/\s+/);
        const title = /title="([^"]+)"/.exec(rest.join(" "))?.[1];
        const src = title ? `<div class="code-title"><a href="${REPO_URL}/blob/main/docs/${title}">${escapeHtml(title)}</a></div>` : "";
        return `<figure class="code">${src}<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre></figure>\n`;
      },
    },
  });
}

/** Rewrites relative .md links to .html and root-absolute links to the base path. */
function fixLinks(html) {
  return html
    .replace(/href="(?!https?:|mailto:|#|\/)([^"]+?)\.md(#[^"]*)?"/g, 'href="$1.html$2"')
    .replace(/(href|src)="\/(?!\/)/g, `$1="${base}`);
}

function header(rel) {
  return `<header><a class="brand" href="${rel}index.html">SubEtha</a><nav><a href="${rel}docs/">Docs</a><a href="${rel}docs/pricing.html">Pricing</a><a href="${rel}docs/api.html">API</a><a href="${rel}tools/">Tools</a><a href="${rel}llms.txt">llms.txt</a><a href="${REPO_URL}">GitHub</a></nav><span class="spacer"></span><a href="${appUrl}/console/">Console →</a></header>`;
}

function page({ title, body, slug, rel, sidebar = true, description = "" }) {
  const nav = (items) => items.map(([s, t]) => `<li><a href="${rel}docs/${s}.html"${s === slug ? ' aria-current="page"' : ""}>${escapeHtml(t)}</a></li>`).join("");
  const side = sidebar ? `<nav class="sidebar" aria-label="Docs"><ul>${nav(NAV)}</ul><p class="muted">Legal</p><ul>${nav(LEGAL)}</ul><p class="muted">Machine-readable</p><ul><li><a href="${rel}openapi.yaml">openapi.yaml</a></li><li><a href="${rel}llms.txt">llms.txt</a></li><li><a href="${rel}llms-full.txt">llms-full.txt</a></li></ul></nav>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · SubEtha</title>
${description ? `<meta name="description" content="${escapeHtml(description)}">\n` : ""}<link rel="stylesheet" href="${rel}style.css">
${slug ? `<link rel="alternate" type="text/markdown" href="${rel}docs/${slug}.md">\n` : ""}</head>
<body>
${header(rel)}
<div class="${sidebar ? "docs" : "docs single"}">${side}<main class="doc">
${body}
${slug ? `<p class="muted edit"><a href="${REPO_URL}/edit/main/docs/${slug}.md">Edit this page</a> · <a href="${rel}docs/${slug}.md">Markdown</a></p>` : ""}
</main></div>
</body>
</html>
`;
}

const firstParagraph = (md) => {
  const p = md.replace(/^#.*$/m, "").split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#") && !s.startsWith("<!--") && !s.startsWith("|") && !s.startsWith("```"));
  const text = (p ?? "").replace(/^>\s?/gm, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  return text.length <= 200 ? text : text.slice(0, 200).replace(/\s+\S*$/, "") + "…";
};

// ---------------------------------------------------------------- build
const write = (rel, content) => {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

rmSync(join(out, "docs"), { recursive: true, force: true }); // only generated files live here

const docs = [];
for (const [slug, navTitle] of [...NAV, ...LEGAL]) {
  const raw = readFileSync(join(docsDir, `${slug}.md`), "utf8");
  const md = expand(raw, `docs/${slug}.md`);
  const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? navTitle;
  const rel = "../".repeat(slug.split("/").length);
  const body = fixLinks(makeMarked().parse(md));
  const description = firstParagraph(md);
  write(`docs/${slug}.html`, page({ title, body, slug, rel, description }));
  write(`docs/${slug}.md`, md);
  docs.push({ slug, title, navTitle, md, description });
}
// /docs/ → index.html already; nothing else to do.

// llms.txt (https://llmstxt.org) and llms-full.txt
const link = (slug, t, d) => `- [${t}](${siteUrl}/docs/${slug}.md)${d ? `: ${d}` : ""}`;
const main = docs.filter((d) => !d.slug.startsWith("legal/"));
const legal = docs.filter((d) => d.slug.startsWith("legal/"));
write("llms.txt", `# SubEtha

> SubEtha is a hosted, ntfy-compatible pub/sub relay: publish to a topic and every subscribed device receives it over whatever transport works (WebSocket, SSE, Web Push, APNs, FCM, webhooks, email, Slack, SMS, voice, MCP, Reticulum/LXMF), with prepaid per-message pricing.

- Publish: \`curl -H "Authorization: Bearer $TOKEN" -d "hi" ${appUrl}/@handle/topic\`. Subscribe: \`GET /@handle/topic/json\` (NDJSON), \`/sse\`, \`/raw\`, \`/ws\`, or \`?poll=1\`.
- Every request is prepaid. \`X-Dry-Run: 1\` returns the route plan and cost without sending. Errors are JSON with a stable \`error\` code; 402 means the balance can't cover the worst-case cost.
- Agents: a remote MCP server at ${appUrl}/mcp (tools: publish, poll, wait_for_message, list_topics, create_topic, estimate_cost). Use a scoped, spend-capped token.

## Docs

${main.map((d) => link(d.slug, d.navTitle, d.description)).join("\n")}

## API

- [OpenAPI 3.1](${siteUrl}/openapi.yaml): every HTTP route, header, and error code
- [MCP server](${appUrl}/mcp): Streamable HTTP, bearer auth
- [Error codes](${REPO_URL}/blob/main/spec/errors.json): stable machine-readable codes
- [Protocol spec](${REPO_URL}/blob/main/spec/README.md): envelope, canonical JSON, signatures, E2EE

## Optional

- [llms-full.txt](${siteUrl}/llms-full.txt): all docs in one file
${legal.map((d) => link(d.slug, d.navTitle, "")).join("\n")}
`);
write("llms-full.txt", `# SubEtha documentation (all pages)\n\nSource: ${siteUrl}/docs/\n\n${docs.map((d) => `<!-- ${siteUrl}/docs/${d.slug}.md -->\n\n${d.md.trim()}\n`).join("\n---\n\n")}`);
copyFileSync(join(repo, "spec/openapi.yaml"), join(out, "openapi.yaml"));
// JSON copy for the console's API explorer (browsers have no YAML parser).
write("openapi.json", JSON.stringify(parseYaml(readFileSync(join(repo, "spec/openapi.yaml"), "utf8"), { merge: true })));

// Built-in tools (PLAN §10): pricing calculator and route simulator. src/ → tools/tools.js, which
// bundles the relay's own price table, planner, and telephony units.
await esbuild({ entryPoints: [join(here, "src/web.ts")], outfile: join(out, "tools/tools.js"), bundle: true, format: "iife", globalName: "SubEthaTools", platform: "browser", target: "es2022", minify: true, legalComments: "none", logLevel: "warning" });

// ---------------------------------------------------------------- GitHub Pages extras
if (pages) {
  // Static files from the production site, with root-absolute links moved under the base path.
  for (const f of ["index.html", "style.css", "sdk.js", "tools/index.html", "tools/pricing.html", "tools/simulator.html"]) {
    const src = join(publicDir, f);
    if (!existsSync(src)) continue;
    let text = readFileSync(src, "utf8");
    if (f.endsWith(".html")) text = text.replace(/href="\/console\/"/g, `href="${appUrl}/console/"`).replace(/"\/console\/(#[^"]*)?"/g, `"${appUrl}/console/$1"`).replace(/(href|src)="\/(?!\/)/g, `$1="${base}`);
    write(f, text);
  }
  write("pricing-report.html", page({ title: "Pricing invariant report", rel: "", sidebar: false, body: makeMarked().parse(readFileSync(join(repo, "pricing/generated/report.md"), "utf8")) }));
  write("build-info.html", page({ title: "Build info", rel: "", sidebar: false, body: buildInfo() }));
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function testCounts() {
  if (!testResults || !existsSync(testResults)) return [];
  const rows = [];
  for (const f of readdirSync(testResults).sort()) {
    const p = join(testResults, f);
    if (!statSync(p).isFile()) continue;
    const text = readFileSync(p, "utf8");
    const name = f.replace(/\.(json|xml|txt)$/, "");
    if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(text);
        if (typeof j.numTotalTests === "number") rows.push({ name, total: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests });
      } catch { /* not a vitest report */ }
    } else if (f.endsWith(".xml")) {
      const m = /<testsuites?[^>]*\btests="(\d+)"[^>]*/.exec(text);
      if (m) {
        const total = Number(m[1]);
        const failed = Number(/failures="(\d+)"/.exec(m[0])?.[1] ?? 0) + Number(/errors="(\d+)"/.exec(m[0])?.[1] ?? 0);
        const skipped = Number(/skipped="(\d+)"/.exec(m[0])?.[1] ?? 0);
        rows.push({ name, total, passed: total - failed - skipped, failed });
      }
    } else if (f.endsWith(".txt")) {
      let passed = 0, failed = 0;
      for (const m of text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { passed += Number(m[1]); failed += Number(m[2]); }
      if (passed + failed) rows.push({ name, total: passed + failed, passed, failed });
    }
  }
  return rows;
}

function buildInfo() {
  const sha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  const date = git("log", "-1", "--format=%cI") || new Date().toISOString();
  const subject = git("log", "-1", "--format=%s");
  const json = (p) => JSON.parse(readFileSync(join(repo, p), "utf8"));
  const tomlVersion = (p) => /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(repo, p), "utf8"))?.[1] ?? "?";
  const sdks = [
    ["TypeScript SDK + CLI + web components", "@subetha/sdk", json("sdk/js/package.json").version, "https://www.npmjs.com/package/@subetha/sdk", "sdk/js"],
    ["Rust core", "subetha-core", tomlVersion("sdk/core/Cargo.toml"), "https://crates.io/crates/subetha-core", "sdk/core"],
    ["Python SDK", "subetha", tomlVersion("sdk/python/pyproject.toml"), "https://pypi.org/project/subetha/", "sdk/python"],
    ["Reticulum/LXMF gateway", "subetha-reticulum-gateway", tomlVersion("gateways/reticulum/pyproject.toml"), null, "gateways/reticulum"],
  ];
  const workflows = readdirSync(join(repo, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).sort();
  const badges = workflows.map((w) => `<a href="${REPO_URL}/actions/workflows/${w}"><img alt="${w}" src="${REPO_URL}/actions/workflows/${w}/badge.svg"></a>`).join(" ");
  const tests = testCounts();
  const testTable = tests.length
    ? `<table><tr><th>Suite</th><th>Tests</th><th>Passed</th><th>Failed</th></tr>${tests.map((t) => `<tr><td>${escapeHtml(t.name)}</td><td>${t.total}</td><td class="ok">${t.passed}</td><td class="${t.failed ? "bad" : ""}">${t.failed}</td></tr>`).join("")}<tr><th>Total</th><th>${tests.reduce((n, t) => n + t.total, 0)}</th><th>${tests.reduce((n, t) => n + t.passed, 0)}</th><th>${tests.reduce((n, t) => n + t.failed, 0)}</th></tr></table>`
    : `<p class="muted">Test counts weren't collected for this build.</p>`;
  return `<h1>Build info</h1>
<table>
<tr><th>Commit</th><td><a href="${REPO_URL}/commit/${sha}"><code>${sha.slice(0, 12)}</code></a> ${escapeHtml(subject)}</td></tr>
<tr><th>Committed</th><td>${escapeHtml(date)}</td></tr>
<tr><th>Built</th><td>${new Date().toISOString()}${process.env.GITHUB_RUN_ID ? ` · <a href="${REPO_URL}/actions/runs/${process.env.GITHUB_RUN_ID}">run ${process.env.GITHUB_RUN_ID}</a>` : ""}</td></tr>
</table>
<h2>CI</h2>
<p>${badges}</p>
<h2>Tests</h2>
${testTable}
<h2>SDKs and packages</h2>
<table><tr><th>Package</th><th>Name</th><th>Version</th><th>Links</th></tr>
${sdks.map(([what, name, v, registry, dir]) => `<tr><td>${what}</td><td><code>${name}</code></td><td>${v}</td><td><a href="${REPO_URL}/tree/main/${dir}">source</a>${registry ? ` · <a href="${registry}">registry</a> <span class="muted">(publishing pending)</span>` : ""}</td></tr>`).join("\n")}
</table>
<h2>Links</h2>
<ul>
<li><a href="docs/">Docs</a> (this build) · <a href="openapi.yaml">openapi.yaml</a> · <a href="llms.txt">llms.txt</a></li>
<li><a href="pricing-report.html">Pricing invariant report</a>: every SKU's cost, price, and margin at every tier</li>
<li><a href="${appUrl}/console/">Live web console</a> (runs against production) · <a href="${appUrl}/sdk.js">sdk.js</a> drop-in web components</li>
<li><a href="${REPO_URL}/blob/main/PLAN.md">Project plan</a> · <a href="docs/legal/terms.html">Legal drafts</a></li>
</ul>`;
}

console.log(`built ${docs.length} docs pages, llms.txt, llms-full.txt, openapi.yaml, openapi.json, tools/tools.js${pages ? ", build-info.html, pricing-report.html" : ""} → ${relative(process.cwd(), out) || "."} (base ${base})`);
