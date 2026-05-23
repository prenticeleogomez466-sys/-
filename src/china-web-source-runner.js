import { fileURLToPath } from "node:url";
import { readChinaWebSources } from "./china-web-sources.js";

const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();

try {
  const result = await readChinaWebSources(date, {
    syncFixtures: args.includes("--sync-fixtures"),
    withHistories: !args.includes("--no-history"),
    save: !args.includes("--no-save")
  });
  console.log(JSON.stringify({
    ok: result.ok,
    date: result.date,
    summary: result.summary,
    warnings: result.warnings,
    sourceStatus: result.sourceStatus.map((source) => ({
      id: source.id,
      ok: source.ok,
      rows: source.rows,
      dateMatches: source.dateMatches,
      fixtures: source.fixtures,
      selectedIssue: source.selectedIssue,
      error: source.error
    }))
  }, null, 2));
  if (!result.ok && args.includes("--strict")) process.exitCode = 1;
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

export const runnerPath = fileURLToPath(import.meta.url);
