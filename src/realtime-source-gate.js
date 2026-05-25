import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { readChinaWebSources } from "./china-web-sources.js";
import { loadFixtures } from "./fixture-store.js";
import { buildMarketCoverageStatus, checkMarketRequirements } from "./market-data-store.js";
import { crawlMarketData } from "./odds-crawler.js";
import { getDataSubdir, getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const crawlerDir = getDataSubdir("crawler");
const exportDir = getExportDir();

export async function runRealtimeFootballCrawler(date, options = {}) {
  const normalizedDate = safeDate(date);
  const startedAt = new Date().toISOString();
  const allowMissingOdds = options.allowMissingOdds ?? process.env.ODDS_ALLOW_MISSING === "1";
  const requireExternalOdds = options.requireExternalOdds ?? !allowMissingOdds;
  const crawlExternalOdds = options.crawlExternalOdds ?? true;
  const strict = options.strict ?? true;

  const result = {
    date: normalizedDate,
    startedAt,
    chinaOfficial: null,
    externalOdds: null,
    market: null,
    gate: null,
    ok: false
  };

  result.chinaOfficial = await readChinaWebSources(normalizedDate, {
    syncFixtures: true,
    withHistories: options.withHistories !== false
  });

  if (crawlExternalOdds) {
    try {
      result.externalOdds = await crawlMarketData(normalizedDate, { requireApiKey: requireExternalOdds });
    } catch (error) {
      result.externalOdds = {
        ok: false,
        error: error.message,
        sources: [],
        fetched: 0,
        matched: 0,
        saved: false
      };
      if (requireExternalOdds) throw error;
    }
  }

  result.market = buildMarketCoverageStatus(normalizedDate);
  result.gate = buildRealtimeSourceGate(normalizedDate, {
    chinaOfficial: result.chinaOfficial,
    externalOdds: result.externalOdds,
    market: result.market,
    allowMissingOdds,
    requireFullOdds: options.requireFullOdds ?? process.env.SOURCE_GATE_REQUIRE_FULL_ODDS === "1",
    requireExternalOdds
  });
  result.ok = result.gate.ok;
  writeRealtimeSourceGate(result);

  if (strict && !result.gate.ok) {
    throw new Error(`实时足球数据源闸门未通过：${result.gate.failures.join("；")}`);
  }
  return result;
}

export function buildRealtimeSourceGate(date, context = {}) {
  const generatedAt = new Date().toISOString();
  const fixtures = loadFixtures(date);
  const china = context.chinaOfficial ?? {};
  const sourceStatus = Array.isArray(china.sourceStatus) ? china.sourceStatus : [];
  const market = context.market ?? buildMarketCoverageStatus(date);
  const marketCheck = checkMarketRequirements(market, {
    requireAllFixtures: Boolean(context.requireFullOdds),
    requireCompleteOdds: Boolean(context.requireFullOdds),
    requireRealTime: true
  });

  // SOURCE_GATE_PARTIAL_MODE=1 时,把"竞彩源相关"三项(竞彩官方源/公告/赔率快照)从硬阻断
  // 改为"软警告":只要至少 14 场源通过,就允许 daily 生成 14 场推荐(不出竞彩 9 场)。
  // 这种部分降级模式用于:webapi.sporttery.cn 反爬 567 时让 14 场 + 大乐透流程继续。
  // 默认关闭,需要时主动 `SOURCE_GATE_PARTIAL_MODE=1` 跑一次。
  const partialMode = process.env.SOURCE_GATE_PARTIAL_MODE === "1";
  const jingcaiSourceOk = sourceOk(sourceStatus, "lottery-gov-cn-jc-calculator") && (china.summary?.jingcaiMatches ?? 0) > 0;
  const jingcaiBulletinOk = sourceOk(sourceStatus, "sporttery-cn-jc-bulletin");
  const jingcaiSnapshotOk = (china.summary?.jingcaiMarketSnapshots ?? 0) >= (china.summary?.jingcaiMatches ?? 1);

  const checks = [
    check("中国官方源实时抓取", Boolean(china.generatedAt), `抓取时间：${china.generatedAt ?? "缺失"}`),
    check("竞彩足球官方源", jingcaiSourceOk, `场次：${china.summary?.jingcaiMatches ?? 0}${partialMode && !jingcaiSourceOk ? "（partial-mode 软警告）" : ""}`),
    check("竞彩公告官方源", jingcaiBulletinOk, `公告：${china.summary?.bulletins ?? 0}${partialMode && !jingcaiBulletinOk ? "（partial-mode 软警告）" : ""}`),
    check("14场官方源", sourceOk(sourceStatus, "sporttery-cn-ctzc-announcement") && (china.summary?.shengfucaiMatches ?? 0) === 14, `期号：${china.summary?.shengfucaiIssue ?? "缺失"}，场次：${china.summary?.shengfucaiMatches ?? 0}`),
    check("竞彩赔率实时快照", jingcaiSnapshotOk, `快照：${china.summary?.jingcaiMarketSnapshots ?? 0}/${china.summary?.jingcaiMatches ?? 0}${partialMode && !jingcaiSnapshotOk ? "（partial-mode 软警告）" : ""}`),
    check("Fixture 文件来自本次官方同步", fixtures.source?.includes("china-official-web"), `source=${fixtures.source ?? "缺失"}，fixtures=${fixtures.fixtures.length}`),
    check("市场快照实时性", market.rows.filter((row) => row.hasSnapshot).every((row) => row.realTime), `实时快照：${market.rows.filter((row) => row.realTime).length}/${market.rows.filter((row) => row.hasSnapshot).length}`),
    check("全量赔率硬门槛", !context.requireFullOdds || marketCheck.ok, context.requireFullOdds ? marketCheck.failures.join("；") : "未启用全量赔率硬门槛")
  ];

  // partial-mode:竞彩 jingcai 相关三项 + 市场快照实时性 + 全量赔率硬门槛
  // 当竞彩源 567 时,既没有竞彩 9 场也没有竞彩实时赔率快照,
  // "市场快照实时性"和"全量赔率硬门槛"自然全失败,
  // 但 14 场只要识别就可以单独生成胜负彩推荐。
  const jingcaiSoftNames = new Set(partialMode
    ? ["竞彩足球官方源", "竞彩公告官方源", "竞彩赔率实时快照", "市场快照实时性", "全量赔率硬门槛"]
    : []);
  const failures = checks.filter((item) => !item.ok && !jingcaiSoftNames.has(item.name)).map((item) => `${item.name}失败：${item.detail}`);
  const softWarnings = checks.filter((item) => !item.ok && jingcaiSoftNames.has(item.name)).map((item) => `partial-mode 软警告:${item.name}失败,本次不生成竞彩 9 场推荐 — ${item.detail}`);
  const warnings = [];
  if (!context.requireFullOdds && market.usable < market.fixtures) warnings.push(`未启用全量赔率硬门槛，当前赔率覆盖 ${market.usable}/${market.fixtures}；14场仍以官方赛程为准。`);
  if (context.externalOdds && context.externalOdds.ok === false) warnings.push(`外部赔率源抓取失败：${context.externalOdds.error}`);
  warnings.push(...softWarnings);
  warnings.push("正式推荐只允许在本闸门生成后短时间内调用；过期闸门会阻断生成。");

  return {
    ok: failures.length === 0,
    date,
    generatedAt,
    policy: {
      requireOfficialChinaSources: true,
      requireJingcaiRealtimeOdds: true,
      requireShengfucaiFourteen: true,
      requireFullOdds: Boolean(context.requireFullOdds),
      maxGateAgeMinutes: maxGateAgeMinutes()
    },
    summary: {
      fixtures: fixtures.fixtures.length,
      jingcaiMatches: china.summary?.jingcaiMatches ?? 0,
      shengfucaiMatches: china.summary?.shengfucaiMatches ?? 0,
      marketSnapshots: market.snapshots,
      marketUsable: market.usable,
      marketRealtime: market.rows.filter((row) => row.realTime).length
    },
    checks,
    failures,
    warnings
  };
}

export function assertLatestRealtimeSourceGate(date, options = {}) {
  if (options.skip === true || process.env.REALTIME_SOURCE_GATE === "0") return { ok: true, skipped: true };
  const gatePath = realtimeGatePath(date);
  if (!existsSync(gatePath)) throw new Error(`缺少实时足球数据源闸门：${gatePath}。请先运行 npm run crawler:realtime -- --date=${date}`);
  const payload = JSON.parse(readFileSync(gatePath, "utf8"));
  const gate = payload.gate ?? payload;
  if (!gate.ok) throw new Error(`实时足球数据源闸门未通过：${gate.failures?.join("；") || "未知错误"}`);
  const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(gate.generatedAt).getTime()) / 60000));
  const maxAge = options.maxAgeMinutes ?? maxGateAgeMinutes();
  if (!Number.isFinite(ageMinutes) || ageMinutes > maxAge) {
    throw new Error(`实时足球数据源闸门已过期：${ageMinutes} 分钟前生成，最大允许 ${maxAge} 分钟。请重新运行实时爬虫。`);
  }
  return { ok: true, ageMinutes, path: gatePath, gate };
}

export function writeRealtimeSourceGate(result) {
  mkdirSync(crawlerDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync(join(crawlerDir, `realtime-source-${result.date}.json`), json, "utf8");
  writeFileSync(realtimeGatePath(result.date), json, "utf8");
  writeFileSync(join(exportDir, `realtime-source-gate-${result.date}.md`), renderGateMarkdown(result), "utf8");
}

function renderGateMarkdown(result) {
  const gate = result.gate;
  return [
    `# 实时足球数据源闸门 ${result.date}`,
    "",
    `状态：${gate.ok ? "通过" : "失败"}`,
    `生成时间：${gate.generatedAt}`,
    "",
    "## 检查项",
    "| 检查 | 状态 | 说明 |",
    "|---|---:|---|",
    ...gate.checks.map((item) => `| ${item.name} | ${item.ok ? "通过" : "失败"} | ${item.detail} |`),
    "",
    "## 摘要",
    `- 竞彩官方场次：${gate.summary.jingcaiMatches}`,
    `- 14场官方场次：${gate.summary.shengfucaiMatches}`,
    `- 市场快照：${gate.summary.marketSnapshots}`,
    `- 实时快照：${gate.summary.marketRealtime}`,
    "",
    "## 警告",
    ...gate.warnings.map((warning) => `- ${warning}`),
    ""
  ].join("\n");
}

function realtimeGatePath(date) {
  return join(exportDir, `realtime-source-gate-${date}.json`);
}

function sourceOk(rows, id) {
  return rows.some((row) => row.id === id && row.ok);
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: String(detail ?? "") };
}

function maxGateAgeMinutes() {
  return Number(process.env.SOURCE_GATE_MAX_AGE_MINUTES ?? 30);
}

function safeDate(value) {
  const match = String(value ?? "").match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`无效日期：${value}`);
  return match[0];
}
