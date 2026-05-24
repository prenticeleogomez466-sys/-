import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getExportDir } from "./paths.js";
import { buildDailyRecommendationPackage } from "./daily-report.js";
import { runEvolutionBacktest } from "./evolution-backtest.js";
import { assertMarketRequirements, buildMarketCoverageStatus } from "./market-data-store.js";
import { runRealtimeFootballCrawler } from "./realtime-source-gate.js";
import { deliverDailyReportToWechat } from "./wechat-delivery.js";
import { syncFootballArtifacts } from "./artifact-sync.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const args = process.argv.slice(2);
const date = readArg("--date") ?? todayInShanghai();
const withWeb = !args.includes("--no-web");
const offlineDemo = args.includes("--offline-demo");
const allowMissingOdds = args.includes("--allow-missing-odds") || process.env.ODDS_ALLOW_MISSING === "1";
const syncArtifacts = !args.includes("--no-sync") && process.env.FOOTBALL_ARTIFACT_SYNC !== "0";

const result = { date, startedAt: new Date().toISOString(), realtimeCrawler: null, market: null, package: null, evolutionBacktest: null, wechat: null, sync: null, ok: false, error: null };
try {
  if (!withWeb && !offlineDemo) {
    throw new Error("正式生成禁止 --no-web：每次生成前必须实时抓取并通过数据源闸门。如需离线演示，请显式使用 --offline-demo。");
  }
  if (withWeb) {
    result.realtimeCrawler = await runRealtimeFootballCrawler(date, {
      allowMissingOdds,
      requireExternalOdds: !allowMissingOdds,
      requireFullOdds: !allowMissingOdds,
      strict: true
    });
  }
  result.market = buildMarketCoverageStatus(date);
  if (!allowMissingOdds) assertMarketRequirements(result.market);
  const packageResult = buildDailyRecommendationPackage(date);
  result.package = { date: packageResult.date, dailyPath: packageResult.dailyPath, masterPath: packageResult.masterPath, auditPath: packageResult.auditPath, audit: packageResult.audit.summary, fixtures: packageResult.recommendations.fixtures, ledgerRows: packageResult.ledgerRows };
  result.evolutionBacktest = runEvolutionBacktest();
  result.wechat = await deliverDailyReportToWechat(packageResult);
  result.ok = true;
} catch (error) {
  result.error = error.stack || error.message;
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  mkdirSync(exportDir, { recursive: true });
  const statusPath = join(exportDir, `daily-evolution-status-${date}.json`);
  writeFileSync(statusPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(exportDir, "daily-evolution-status.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.ok && syncArtifacts) {
    result.sync = syncFootballArtifacts(date, {
      git: !args.includes("--no-git-sync"),
      obsidian: !args.includes("--no-obsidian-sync")
    });
    writeFileSync(statusPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    writeFileSync(join(exportDir, "daily-evolution-status.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ...result, statusPath }, null, 2));
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
