import { runRealtimeFootballCrawler } from "./realtime-source-gate.js";

const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();

try {
  const result = await runRealtimeFootballCrawler(date, {
    allowMissingOdds: args.includes("--allow-missing-odds") ? true : undefined,
    requireExternalOdds: args.includes("--require-external-odds") ? true : undefined,
    requireFullOdds: args.includes("--require-full-odds") ? true : undefined,
    crawlExternalOdds: !args.includes("--no-external-odds"),
    withHistories: !args.includes("--no-history"),
    strict: !args.includes("--soft")
  });
  console.log(JSON.stringify({
    ok: result.ok,
    date: result.date,
    summary: result.gate.summary,
    failures: result.gate.failures,
    warnings: result.gate.warnings
  }, null, 2));
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
