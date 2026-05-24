import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";
import { buildMarketCoverageStatus } from "./market-data-store.js";
import { advancedDataLayerStatus, topTierReadiness } from "./advanced-football-features.js";
import { advancedDataPath, layerAvailable, loadAdvancedData } from "./advanced-data-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

export function auditTopTierModelReadiness(date, env = process.env) {
  mkdirSync(exportDir, { recursive: true });
  const market = safeMarketStatus(date);
  const advancedData = loadAdvancedData(date);
  const advancedLayers = advancedDataLayerStatus(env, advancedData);
  const readiness = topTierReadiness(advancedLayers);
  const hasLayer = (key) => advancedLayers.find((row) => row.key === key)?.configured ?? false;
  const checks = [
    check("数据完整度", "官方赛程+实时赔率闸门", market.ok && market.complete === market.fixtures && market.realtime === market.fixtures, market.ok ? `${market.complete}/${market.fixtures} 完整，${market.realtime}/${market.fixtures} 实时` : market.error, "error"),
    check("市场微结构", "欧赔+亚盘+让球胜平负", market.ok && market.complete === market.fixtures, market.ok ? `${market.complete}/${market.fixtures}` : market.error, "error"),
    check("球队强度", "Elo/实力评级", hasLayer("elo"), layerDetail("elo", env.TEAM_ELO_SOURCE_URL, advancedData, "TEAM_ELO_SOURCE_URL"), "warning"),
    check("球队状态", "近期状态/赛程强度", hasLayer("form"), layerDetail("form", env.TEAM_FORM_SOURCE_URL, advancedData, "TEAM_FORM_SOURCE_URL"), "warning"),
    check("伤停信息", "伤停名单", hasLayer("injuries"), layerDetail("injuries", env.INJURY_SOURCE_URL, advancedData, "INJURY_SOURCE_URL"), "warning"),
    check("预计首发", "首发阵容", hasLayer("lineups"), layerDetail("lineups", env.LINEUP_SOURCE_URL, advancedData, "LINEUP_SOURCE_URL"), "warning"),
    check("技战术质量", "xG/射门质量", hasLayer("xg"), layerDetail("xg", env.XG_SOURCE_URL, advancedData, "XG_SOURCE_URL"), "warning"),
    check("概率校准", "回测校准与 Brier/LogLoss", existsSync(join(exportDir, "backtest-summary.json")), existsSync(join(exportDir, "backtest-summary.json")) ? "存在回测摘要" : "缺可复现校准报告", "warning"),
    check("资金风险", "EV/凯利/回撤约束", Boolean(env.BANKROLL_RISK_POLICY === "1"), env.BANKROLL_RISK_POLICY === "1" ? "已启用" : "缺 BANKROLL_RISK_POLICY=1", "warning")
  ];
  const errors = checks.filter((item) => item.level === "error" && !item.ok);
  const warnings = checks.filter((item) => item.level === "warning" && !item.ok);
  const result = {
    ok: errors.length === 0,
    topTierReady: errors.length === 0 && readiness.ready && warnings.length === 0,
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      checks: checks.length,
      errors: errors.length,
      warnings: warnings.length,
      advancedReadiness: readiness.readiness,
      missingRequired: readiness.missingRequired
    },
    market,
    advancedDataPath: advancedDataPath(date),
    advancedLayers,
    checks
  };
  writeTopTierAudit(result);
  return result;
}

function safeMarketStatus(date) {
  try {
    const status = buildMarketCoverageStatus(date);
    return {
      ok: true,
      fixtures: status.fixtures,
      snapshots: status.snapshots,
      usable: status.usable,
      complete: status.complete,
      realtime: status.rows.filter((row) => row.realTime).length
    };
  } catch (error) {
    return { ok: false, error: error.message, fixtures: 0, snapshots: 0, usable: 0, complete: 0, realtime: 0 };
  }
}

function check(layer, name, ok, detail, level = "warning") {
  return { layer, name, ok: Boolean(ok), level: ok ? "ok" : level, detail: String(detail ?? "") };
}

function layerDetail(key, configuredUrl, advancedData, envKey) {
  if (configuredUrl) return `已配置 ${envKey}`;
  if (layerAvailable(advancedData, key)) return `已同步 ${advancedData.layers[key].source}，覆盖 ${advancedData.layers[key].count} 场`;
  return `缺 ${envKey}，且本地同步层无可用数据`;
}

function writeTopTierAudit(result) {
  const jsonPath = join(exportDir, `top-tier-model-audit-${result.date}.json`);
  const markdownPath = join(exportDir, `top-tier-model-audit-${result.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
}

function renderMarkdown(result) {
  return [
    `# 顶级足球模型就绪度审计 ${result.date}`,
    "",
    `硬闸门：${result.ok ? "通过" : "失败"}`,
    `顶级就绪：${result.topTierReady ? "是" : "否"}`,
    `高级数据就绪度：${Math.round(result.summary.advancedReadiness * 100)}%`,
    "",
    "## 缺口",
    ...result.summary.missingRequired.map((item) => `- ${item}`),
    "",
    "## 检查项",
    "| 层级 | 检查 | 状态 | 说明 |",
    "|---|---|---:|---|",
    ...result.checks.map((item) => `| ${item.layer} | ${item.name} | ${item.ok ? "通过" : item.level === "error" ? "失败" : "警告"} | ${item.detail} |`),
    ""
  ].join("\n");
}

function readArg(name) {
  const args = process.argv.slice(2);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? todayInShanghai();
  const result = auditTopTierModelReadiness(date);
  console.log(JSON.stringify({ ok: result.ok, topTierReady: result.topTierReady, summary: result.summary, path: join(exportDir, `top-tier-model-audit-${date}.json`) }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
