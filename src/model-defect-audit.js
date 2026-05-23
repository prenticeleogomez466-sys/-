import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdvancedData } from "./advanced-data-store.js";
import { advancedDataLayerStatus } from "./advanced-football-features.js";
import { loadFixtures } from "./fixture-store.js";
import { buildMarketCoverageStatus, loadMarketSnapshots } from "./market-data-store.js";
import { fourteenSelectionRules, recommendFixtures, validatePredictionConsistency } from "./prediction-engine.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");

export function auditModelDefects(date = todayInShanghai(), env = process.env) {
  mkdirSync(exportDir, { recursive: true });
  const defects = [];
  const fixtureSet = safeLoad(() => loadFixtures(date), { date, fixtures: [] });
  const marketSet = safeLoad(() => loadMarketSnapshots(date), { date, snapshots: [] });
  const marketStatus = safeLoad(() => buildMarketCoverageStatus(date), null);
  const advancedData = loadAdvancedData(date);
  const advancedLayers = advancedDataLayerStatus(env, advancedData);
  const recommendations = safeLoad(() => recommendFixtures(date), null);

  inspectFixtureCoverage(fixtureSet, defects);
  inspectMarketCoverage(marketStatus, defects);
  inspectMarketDuplicates(marketSet, defects);
  inspectRealtimeGate(date, defects, env);
  inspectAdvancedLayers(advancedLayers, defects);
  inspectRecommendations(recommendations, defects, env);

  const result = {
    ok: !defects.some((item) => item.severity === "P0"),
    date,
    generatedAt: new Date().toISOString(),
    summary: summarize(defects, fixtureSet, marketStatus, recommendations, advancedLayers),
    defects,
    marketStatus,
    advancedLayers
  };
  writeDefectAudit(result);
  return result;
}

function inspectFixtureCoverage(fixtureSet, defects) {
  const fixtures = fixtureSet.fixtures ?? [];
  const jingcai = fixtures.filter((fixture) => fixture.marketType === "jingcai");
  const shengfucai = fixtures.filter((fixture) => fixture.marketType === "shengfucai");
  if (!fixtures.length) add(defects, "P0", "赛程层", "今日赛程为空", "先运行官方/授权赛程同步，不能用空赛程生成推荐。");
  if (!jingcai.length) add(defects, "P1", "赛程层", "竞彩场次为空", "检查中国竞彩网抓取或授权赛程兜底。");
  if (shengfucai.length !== 14) add(defects, "P0", "赛程层", `14场数量异常：${shengfucai.length}/14`, "必须补齐完整 14 场后才能生成胜负彩正式版。");
}

function inspectMarketCoverage(status, defects) {
  if (!status) {
    add(defects, "P0", "赔率层", "赔率覆盖状态无法读取", "先修复 market-data-store 或重新抓取赔率快照。");
    return;
  }
  const unusableRows = status.rows?.filter((row) => !row.usable) ?? [];
  const incompleteRows = status.rows?.filter((row) => !row.complete) ?? [];
  if (status.fixtures > 0 && status.usable < status.fixtures) add(defects, "P0", "赔率层", `可用赔率不完整：${status.usable}/${status.fixtures}；缺口=${examples(unusableRows)}`, "正式推荐前必须补齐每场至少一个真实盘口/赔率快照。");
  if (status.fixtures > 0 && status.complete < status.fixtures) add(defects, "P1", "赔率层", `完整赔率不完整：${status.complete}/${status.fixtures}；缺口=${examples(incompleteRows)}`, "继续补欧洲赔率、亚洲盘口、竞彩让球/14场核心盘口。");
  const realtime = status.rows?.filter((row) => row.realTime).length ?? 0;
  const staleRows = status.rows?.filter((row) => !row.realTime) ?? [];
  if (status.fixtures > 0 && realtime < status.fixtures) add(defects, "P0", "实时闸门", `实时赔率不足：${realtime}/${status.fixtures}；缺口=${examples(staleRows)}`, "重新跑 realtime crawler，过期快照不得进入正式版。");
  const missingScore = status.rows?.filter((row) => row.hasSnapshot && row.missing?.includes("比分赔率")).length ?? 0;
  if (missingScore) add(defects, "P2", "细分玩法", `比分赔率缺口：${missingScore} 场`, "比分可由模型派生，但表格必须标注为模型派生，不可冒充市场赔率。");
}

function inspectMarketDuplicates(marketSet, defects) {
  const seen = new Map();
  for (const snapshot of marketSet.snapshots ?? []) {
    const key = snapshot.fixtureId || `${snapshot.homeTeam}-${snapshot.awayTeam}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
  if (duplicates.length) add(defects, "P1", "赔率层", `重复赔率快照：${duplicates.length} 组`, "按 fixtureId 合并去重，避免重复快照污染盘口变化判断。");
}

function inspectRealtimeGate(date, defects, env) {
  const gatePath = join(exportDir, `realtime-source-gate-${date}.json`);
  if (!existsSync(gatePath)) {
    add(defects, "P0", "实时闸门", "缺少实时闸门文件", "正式推荐前必须先刷新实时闸门。");
    return;
  }
  try {
    const payload = JSON.parse(readFileSync(gatePath, "utf8"));
    const gate = payload.gate ?? payload;
    const generatedAt = new Date(gate.generatedAt ?? payload.generatedAt);
    const ageMinutes = Number.isFinite(generatedAt.getTime()) ? Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 60000)) : Infinity;
    const maxAge = Number(env.SOURCE_GATE_MAX_AGE_MINUTES ?? 30);
    if (!gate.ok) add(defects, "P0", "实时闸门", `闸门失败：${gate.failures?.join("；") ?? "未知失败"}`, "必须先修复闸门失败原因。");
    if (ageMinutes > maxAge) add(defects, "P0", "实时闸门", `闸门过期：${ageMinutes} 分钟`, `重新刷新，要求不超过 ${maxAge} 分钟。`);
  } catch (error) {
    add(defects, "P0", "实时闸门", `闸门文件解析失败：${error.message}`, "删除坏文件后重新运行 realtime crawler。");
  }
}

function inspectAdvancedLayers(layers, defects) {
  const missingRequired = layers.filter((layer) => layer.requiredForTopTier && !layer.configured);
  for (const layer of missingRequired) add(defects, "P1", "高级数据层", `缺少${layer.label}`, `配置 ${layer.env} 或补入合法公开/授权数据源。`);
  const derivedRequired = layers.filter((layer) => layer.requiredForTopTier && layer.configured && layer.derived);
  if (derivedRequired.length) {
    add(
      defects,
      "P2",
      "高级数据层",
      `高级层使用模型派生代理：${derivedRequired.map((layer) => `${layer.label}(${layer.derivedCount ?? 0})`).join("、")}`,
      "代理特征可用于增强分析，但不等同于真实外部伤停/首发/xG；有授权免费源后应优先替换。"
    );
  }
  const missingOptional = layers.filter((layer) => !layer.requiredForTopTier && !layer.configured);
  if (missingOptional.length) add(defects, "P2", "高级数据层", `可选层未完全覆盖：${missingOptional.map((layer) => layer.label).join("、")}`, "可继续补天气/新闻等免费公开源，提高冷门解释能力。");
}

function inspectRecommendations(recommendations, defects, env) {
  if (!recommendations) {
    add(defects, "P0", "推荐层", "推荐引擎运行失败", "修复预测引擎异常后再生成表格。");
    return;
  }
  for (const prediction of recommendations.predictions ?? []) {
    const errors = validatePredictionConsistency(prediction);
    for (const error of errors) add(defects, "P0", "推荐一致性", `${prediction.fixture.homeTeam} vs ${prediction.fixture.awayTeam}：${error}`, "胜平负必须先定，比分和半全场必须从该结果派生。");
    if (!prediction.bankroll?.enabled && env.BANKROLL_RISK_POLICY !== "1") add(defects, "P1", "资金风控", "资金风控未启用", "配置 BANKROLL_RISK_POLICY=1。");
  }
  const rules = fourteenSelectionRules(env);
  const bankers = (recommendations.fourteen?.selections ?? []).filter((selection) => String(selection.type).includes("胆"));
  if (bankers.length > rules.maxBankers) add(defects, "P0", "14场规则", `胆数量过多：${bankers.length}/${rules.maxBankers}`, "降低胆数量，只保留高置信/低风险场次。");
  const weakBankers = bankers.filter((selection) => Number(selection.confidence) < rules.bankerMinConfidence || String(selection.risk).includes("高"));
  if (weakBankers.length) add(defects, "P1", "14场规则", `存在弱胆：${weakBankers.length} 场`, "弱胆降级为双选或全包。");
}

function summarize(defects, fixtureSet, marketStatus, recommendations, advancedLayers) {
  const bySeverity = Object.fromEntries(["P0", "P1", "P2"].map((level) => [level, defects.filter((item) => item.severity === level).length]));
  return {
    ok: bySeverity.P0 === 0,
    defects: defects.length,
    bySeverity,
    fixtures: fixtureSet.fixtures?.length ?? 0,
    marketUsable: marketStatus?.usable ?? 0,
    marketComplete: marketStatus?.complete ?? 0,
    predictions: recommendations?.predictions?.length ?? 0,
    advancedRequiredReady: advancedLayers.filter((layer) => layer.requiredForTopTier && layer.configured).length,
    advancedRequiredTotal: advancedLayers.filter((layer) => layer.requiredForTopTier).length
  };
}

function add(defects, severity, layer, title, remediation) {
  defects.push({ severity, layer, title, remediation });
}

function examples(rows, count = 6) {
  const names = rows.slice(0, count).map((row) => row.match ?? row.fixtureId).filter(Boolean);
  const suffix = rows.length > count ? ` 等${rows.length}场` : "";
  return `${names.join("、")}${suffix}`;
}

function safeLoad(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function writeDefectAudit(result) {
  const jsonPath = join(exportDir, `model-defect-audit-${result.date}.json`);
  const markdownPath = join(exportDir, `model-defect-audit-${result.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
}

function renderMarkdown(result) {
  return [
    `# 足球大模型缺陷审计 ${result.date}`,
    "",
    `状态：${result.ok ? "通过" : "存在阻断缺陷"}`,
    `P0：${result.summary.bySeverity.P0}，P1：${result.summary.bySeverity.P1}，P2：${result.summary.bySeverity.P2}`,
    "",
    "| 严重级别 | 层级 | 缺陷 | 修复建议 |",
    "|---|---|---|---|",
    ...(result.defects.length ? result.defects.map((item) => `| ${item.severity} | ${item.layer} | ${item.title} | ${item.remediation} |`) : ["| - | - | 未发现阻断缺陷 | 继续保持赛前刷新闸门 |"]),
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
  const result = auditModelDefects(date);
  console.log(JSON.stringify({ ok: result.ok, summary: result.summary, path: join(exportDir, `model-defect-audit-${date}.json`) }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
