/**
 * 一键竞彩+14场日报(官方竞彩源不可达时的固定套路)
 * ──────────────────────────────────────────────────
 *   1. partial-mode 刷新实时数据源闸门:14 场官方源(若当天有期次)通过,
 *      竞彩官方源软警告(白天 WAF 567 / SSL reset)。
 *   2. 读 Playwright 抓的 500.com 竞彩 JSON(jingcai-scrape-<date>.json),
 *      装配进 store(保留官方 14 场)。
 *   3. 直接出推荐包(跳过会重爬覆盖竞彩的 daily 全流程)。
 *
 * 用法:node scripts/jingcai-daily.mjs --date 2026-05-29
 * 数据准备:用 Playwright 抓 trade.500.com/jczq/,把行写进
 *   D:\football-model-data\crawler\jingcai-scrape-<date>.json
 *   形如 { "date": "...", "collectedAt": "ISO", "rows": [[seq,league,kickoff,teamCell,handicapCell,oddsCell], ...] }
 */
import "../src/env.js";
import { runRealtimeFootballCrawler } from "../src/realtime-source-gate.js";
import { loadScrapeFile, stageJingcaiIntoStore } from "../src/jingcai-fivehundred-stage.js";
import { buildDailyRecommendationPackage } from "../src/daily-report.js";
import { loadFixtures, saveFixtures } from "../src/fixture-store.js";

const args = process.argv.slice(2);
function readArg(name) {
  const pre = args.find((a) => a.startsWith(`${name}=`));
  if (pre) return pre.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

const date = readArg("--date") ?? todayInShanghai();

// 0) 快照已有的官方 14 场(防 crawler 重爬时官方源偶发 567 把好数据冲成 0)
const priorShengfucai = loadFixtures(date).fixtures.filter((f) => f.marketType === "shengfucai");

// 1) partial-mode 刷闸门(强制开启 partial,允许缺赔率,不 strict 抛错)
process.env.SOURCE_GATE_PARTIAL_MODE = "1";
const crawler = await runRealtimeFootballCrawler(date, {
  allowMissingOdds: true,
  requireExternalOdds: false,
  requireFullOdds: false,
  strict: false,
});

// 1b) 若本次重爬把 14 场冲成 0,但之前有官方 14 场 → 恢复,避免误删好数据
let restoredShengfucai = false;
const afterCrawl = loadFixtures(date);
if (afterCrawl.fixtures.filter((f) => f.marketType === "shengfucai").length === 0 && priorShengfucai.length > 0) {
  const others = afterCrawl.fixtures.filter((f) => f.marketType !== "shengfucai");
  saveFixtures(date, [...priorShengfucai, ...others], { source: `${afterCrawl.source} + restored-shengfucai` });
  restoredShengfucai = true;
}

// 2) 装配 500.com 竞彩(注意:必须在 crawler 重爬之后,否则被覆盖)
const { rows, collectedAt } = loadScrapeFile(date);
const staged = stageJingcaiIntoStore(date, rows, collectedAt);

// 3) 出推荐包(skip 闸门:竞彩官方源不可达,数据来自 500.com 兜底)
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });

const jingcai = pkg.recommendations.predictions.filter((p) => p.fixture.marketType === "jingcai").length;
console.log(JSON.stringify({
  date,
  gate: { ok: crawler.gate.ok, shengfucai: crawler.gate.summary.shengfucaiMatches },
  restoredShengfucai,
  staged,
  recommendations: { jingcai, fourteen: pkg.recommendations.fourteen.selections.length },
  audit: pkg.audit.summary,
  dailyPath: pkg.dailyPath,
}, null, 2));
