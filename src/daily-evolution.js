import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getExportDir } from "./paths.js";
import { buildDailyRecommendationPackage } from "./daily-report.js";
import { runEvolutionBacktest } from "./evolution-backtest.js";
import { checkMarketRequirements, buildMarketCoverageStatus } from "./market-data-store.js";
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

const result = { date, startedAt: new Date().toISOString(), realtimeCrawler: null, market: null, package: null, recommendation: null, evolutionBacktest: null, wechat: null, sync: null, ok: false, error: null };
try {
  if (!withWeb && !offlineDemo) {
    throw new Error("正式生成禁止 --no-web：每次生成前必须实时抓取并通过数据源闸门。如需离线演示，请显式使用 --offline-demo。");
  }
  // ---- 当日实时推荐链路：需真实实时赔率 + 通过数据源闸门。----
  // 失败（如夜间无官方期号/未挂盘/14场未开）= 当日无真实可推之盘，如实跳过，绝不编造；
  // 但这一链路的失败【不得】中断下面纯真实历史驱动的进化回测（不空跑、必全真）。
  try {
    if (withWeb) {
      result.realtimeCrawler = await runRealtimeFootballCrawler(date, {
        allowMissingOdds,
        requireExternalOdds: !allowMissingOdds,
        requireFullOdds: !allowMissingOdds,
        strict: true
      });
    }
    result.market = buildMarketCoverageStatus(date);
    const marketCheck = allowMissingOdds ? { ok: true, failures: [], missingRows: [] } : checkMarketRequirements(result.market);
    if (marketCheck.ok) {
      const packageResult = buildDailyRecommendationPackage(date);
      result.package = { date: packageResult.date, dailyPath: packageResult.dailyPath, masterPath: packageResult.masterPath, auditPath: packageResult.auditPath, audit: packageResult.audit.summary, fixtures: packageResult.recommendations.fixtures, ledgerRows: packageResult.ledgerRows };
      result.wechat = await deliverDailyReportToWechat(packageResult);
      result.recommendation = { generated: true };
    } else {
      result.recommendation = {
        generated: false,
        skipped: true,
        reason: marketCheck.failures.join("；"),
        missing: marketCheck.missingRows.slice(0, 10).map((row) => `${row.match}（${(row.missing && row.missing.join("、")) || row.freshness}）`)
      };
    }
  } catch (liveError) {
    // 实时数据源闸门未通过（当日无真实可用盘口）：如实记录、跳过当日推荐生成，不编造。
    result.recommendation = { generated: false, skipped: true, reason: liveError.message || String(liveError) };
  }
  // ---- 历史进化回测：纯用真实已结算 ledger（recommendation-ledger.json），与今日实时赔率无关。----
  // 必须每晚真跑、用真实赛果学习，绝不因当日缺盘而空跑。
  result.evolutionBacktest = runEvolutionBacktest();
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
