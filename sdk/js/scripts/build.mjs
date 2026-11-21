// Builds dist/ (ESM library + CLI) and the browser bundle served at subetha.org/sdk.js.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const common = { bundle: true, target: "es2022", legalComments: "none" };
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.js", format: "esm", platform: "neutral" });
await build({ ...common, entryPoints: ["src/node-cli.ts"], outfile: "dist/cli.js", format: "esm", platform: "node" });
await build({ ...common, entryPoints: ["src/web.ts"], outfile: "dist/sdk.js", format: "iife", platform: "browser", minify: true });
mkdirSync("../../apps/site/public", { recursive: true });
copyFileSync("dist/sdk.js", "../../apps/site/public/sdk.js");
console.log("built dist/index.js, dist/cli.js, dist/sdk.js");
