// pnpm pricing: costs.yaml → generated/prices.json + generated/report.md
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { generatePrices, PricingInvariantError, renderReport, type CostsFile, type FixedCostsFile } from "./generate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const costs = parse(readFileSync(join(root, "costs.yaml"), "utf8")) as CostsFile;
const fixed = parse(readFileSync(join(root, "fixed-costs.yaml"), "utf8")) as FixedCostsFile;
try {
  const table = generatePrices(costs);
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(join(root, "generated", "prices.json"), JSON.stringify(table, null, 2) + "\n");
  writeFileSync(join(root, "generated", "report.md"), renderReport(table, fixed));
  console.log(`generated ${Object.keys(table.skus).length} SKUs × ${table.tiers.length} tiers`);
} catch (e) {
  if (e instanceof PricingInvariantError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
