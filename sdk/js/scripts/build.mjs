// Builds dist/ (ESM library, subpaths, .d.ts declarations, CLI) and the browser bundles served at subetha.us/sdk.js & edge.js.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const common = { bundle: true, target: "es2022", legalComments: "none" };
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js", format: "esm", platform: "neutral" });
await build({ ...common, entryPoints: ["src/protocol/index.ts"], outfile: "dist/protocol.js", format: "esm", platform: "neutral" });
await build({ ...common, entryPoints: ["src/edge/index.ts"], outfile: "dist/edge-lib.js", format: "esm", platform: "neutral" });
await build({ ...common, entryPoints: ["src/edge/lan-node.ts"], outfile: "dist/edge-lan-node.js", format: "esm", platform: "node" });
await build({ ...common, entryPoints: ["src/node-cli.ts"], outfile: "dist/cli.js", format: "esm", platform: "node" });
await build({ ...common, entryPoints: ["src/web.ts"], outfile: "dist/sdk.js", format: "iife", platform: "browser", minify: true });
await build({ ...common, entryPoints: ["src/edge/browser.ts"], outfile: "dist/edge.js", format: "iife", platform: "browser", minify: true });
execFileSync("pnpm", ["exec", "tsc", "--project", "tsconfig.build.json"], { stdio: "inherit" });
mkdirSync("../../apps/site/public", { recursive: true });
copyFileSync("dist/sdk.js", "../../apps/site/public/sdk.js");
copyFileSync("dist/edge.js", "../../apps/site/public/edge.js");
console.log("built dist/{index,protocol,edge-lib,edge-lan-node,cli,sdk,edge}.js + dist/types/");
