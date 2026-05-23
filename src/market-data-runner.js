import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { assertMarketRequirements, buildMarketCoverageStatus } from "./market-data-store.js";
import { crawlMarketData } from "./odds-crawler.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");
const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();
const strict = args.includes("--strict");

try {
  const crawler = args.includes("--crawl") ? await crawlMarketData(date, { requireApiKey: strict }) : null;
  const status = buildMarketCoverageStatus(date);
  const requirements = strict ? assertMarketRequirements(status) : null;
  mkdirSync(exportDir, { recursive: true });
  const statusPath = join(exportDir, `market-status-${date}.json`);
  writeFileSync(statusPath, `${JSON.stringify({ crawler, status, requirements }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ crawler, status, requirements, statusPath }, null, 2));
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

function readArg(name) {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
