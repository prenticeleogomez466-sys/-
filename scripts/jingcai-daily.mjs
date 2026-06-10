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
//    asian dict 同步装进 snapshot.asianHandicap,这样 line / handicapPick.direction 能算
const { captures, asian } = loadScrapeFile(date);
const staged = stageJingcaiIntoStore(date, captures, asian);

// 2b) 全赔种抓取 + 数据完整性审计(2026-06-06 用户永久铁律"必须全部抓取·抓完审计再走下一步"):
//     注入 比分/半全场/总进球 真实市场盘(500.com XML)→ findMarketSnapshot 合并入快照,
//     让模型用真盘而非 DC 估算(减小偏差)。失败不阻断(已有胜平负/让球仍可出),但审计行会标缺。
{
  const ing = spawnSync("node", [join(dirname(fileURLToPath(import.meta.url)), "ingest-500-jingcai-fallback.mjs"), `--date=${date}`], { encoding: "utf8", timeout: 180000 });
  if (ing.stderr) process.stderr.write(ing.stderr.split("\n").filter((l) => /审计|全赔种|缺口|全覆盖|赔率一致性/.test(l)).join("\n") + "\n");
  if (ing.status !== 0) console.error("⚠️ 全赔种抓取非0退出,比分/半全场可能退回DC估算(已标源)");
}

// 3) 出推荐包(skip 闸门:竞彩官方源不可达,数据来自 500.com 兜底)
const pkg = buildDailyRecommendationPackage(date, { skipRealtimeGate: true });

// 4) 交付收敛唯一出口(2026-06-10 缺陷#7根修):
//    旧步骤 = openpyxl polish-xlsx.py 美化 daily-report 10列旧表 + copy 桌面根 —— 这条旁路曾把
//    桌面 06-10 专业版20列交付顶替成10列旧表(定标准一天即失守),已整体删除(polish-xlsx.py 一并删)。
//    现统一:先补 coverage(近5/H2H/大小球),再走 today-full-coverage(xlsx20列+手机页+英文页三面同源)。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const cover = spawnSync(process.execPath, [join(__dirname, "fetch-match-coverage.mjs"), date], { stdio: "inherit", timeout: 600000 });
if (cover.status !== 0) console.error("⚠️ coverage 抓取非0退出——交付表近5/H2H/亚盘列将诚实标缺(不阻断)");
const delivery = spawnSync(process.execPath, [join(__dirname, "today-full-coverage.mjs"), date, "--jconly"], { stdio: "inherit", timeout: 600000 });
const deliveryStatus = delivery.status === 0 ? "ok" : `failed:${delivery.status}`;
if (delivery.status !== 0) process.exitCode = 1; // 交付出口失败必须响(真钱管线,不静默)

const jingcai = pkg.recommendations.predictions.filter((p) => p.fixture.marketType === "jingcai").length;
console.log(JSON.stringify({
  date,
  gate: { ok: crawler.gate.ok, shengfucai: crawler.gate.summary.shengfucaiMatches },
  restoredShengfucai,
  staged,
  recommendations: { jingcai, fourteen: pkg.recommendations.fourteen.selections.length },
  audit: pkg.audit.summary,
  dailyPath: pkg.dailyPath,
  delivery: {
    exit: "today-full-coverage(唯一输出出口:xlsx20列+手机页+英文页)",
    coverage: cover.status === 0 ? "ok" : `failed:${cover.status}`,
    status: deliveryStatus,
  },
}, null, 2));
