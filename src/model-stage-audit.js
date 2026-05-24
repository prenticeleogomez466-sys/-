import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getExportDir } from "./paths.js";
import { loadAdvancedData } from "./advanced-data-store.js";
import { advancedDataLayerStatus } from "./advanced-football-features.js";
import { loadFixtures } from "./fixture-store.js";
import { buildMarketCoverageStatus } from "./market-data-store.js";
import { recommendFixtures, validatePredictionConsistency } from "./prediction-engine.js";
import { auditRecommendations } from "./recommendation-audit.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

export function auditModelStages(date = todayInShanghai(), env = process.env) {
  mkdirSync(exportDir, { recursive: true });
  const fixtureSet = safe(() => loadFixtures(date), { date, source: "error", fixtures: [] });
  const market = safe(() => buildMarketCoverageStatus(date), null);
  const advancedData = loadAdvancedData(date);
  const recommendations = safe(() => recommendFixtures(date), null);
  const recommendationAudit = recommendations ? auditRecommendations(recommendations) : null;

  const stages = [
    auditFixtureStage(fixtureSet),
    auditMarketStage(market),
    auditAdvancedStage(advancedData, fixtureSet, env),
    auditPredictionStage(recommendations, recommendationAudit),
    auditDerivativeStage(recommendations),
    auditBankrollStage(recommendations, env),
    auditOutputStage(date)
  ];
  const allFindings = stages.flatMap((stage) => stage.findings.map((finding) => ({ stage: stage.key, ...finding })));
  const result = {
    ok: !allFindings.some((finding) => finding.severity === "P0"),
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      stages: stages.length,
      p0: allFindings.filter((finding) => finding.severity === "P0").length,
      p1: allFindings.filter((finding) => finding.severity === "P1").length,
      p2: allFindings.filter((finding) => finding.severity === "P2").length,
      stageScores: Object.fromEntries(stages.map((stage) => [stage.key, stage.score]))
    },
    stages,
    findings: allFindings
  };
  writeStageAudit(result);
  return result;
}

function auditFixtureStage(fixtureSet) {
  const fixtures = fixtureSet.fixtures ?? [];
  const jingcai = fixtures.filter((fixture) => fixture.marketType === "jingcai");
  const shengfucai = fixtures.filter((fixture) => fixture.marketType === "shengfucai");
  const findings = [];
  if (!fixtures.length) add(findings, "P0", "今日赛程为空", "必须先同步官方或授权赛程。");
  if (!fixtureSet.source?.includes("china-official-web")) add(findings, "P1", `赛程来源非本次官方同步：${fixtureSet.source ?? "未知"}`, "运行 china:sources:sync 并确认 source。");
  if (!jingcai.length) add(findings, "P1", "竞彩场次为空", "检查中国竞彩网抓取。");
  if (shengfucai.length !== 14) add(findings, "P0", `14场数量异常：${shengfucai.length}/14`, "胜负彩必须完整 14 场。");
  return stage("fixtures", "赛程与官方源", scoreFrom(findings, fixtures.length ? 92 : 0), {
    fixtures: fixtures.length,
    jingcai: jingcai.length,
    shengfucai: shengfucai.length,
    source: fixtureSet.source
  }, findings);
}

function auditMarketStage(market) {
  const findings = [];
  if (!market) {
    add(findings, "P0", "赔率状态无法读取", "修复市场数据文件或重新抓取。");
    return stage("market", "赔率与盘口", 0, {}, findings);
  }
  const realtime = market.rows.filter((row) => row.realTime).length;
  if (market.usable !== market.fixtures) add(findings, "P0", `真实赔率覆盖不足：${market.usable}/${market.fixtures}`, "补齐每场真实赔率快照。");
  if (market.complete !== market.fixtures) add(findings, "P0", `完整玩法赔率不足：${market.complete}/${market.fixtures}`, "竞彩需欧赔/亚盘/让球胜平负，14场需欧赔/亚盘。");
  if (realtime !== market.fixtures) add(findings, "P0", `实时赔率不足：${realtime}/${market.fixtures}`, "刷新 realtime crawler，过期或缺失快照不得正式推荐。");
  return stage("market", "赔率与盘口", coverageScore(market.complete, market.fixtures), {
    fixtures: market.fixtures,
    usable: market.usable,
    complete: market.complete,
    realtime,
    missingExamples: market.rows.filter((row) => !row.usable || !row.complete || !row.realTime).slice(0, 8)
  }, findings);
}

function auditAdvancedStage(advancedData, fixtureSet, env) {
  const layers = advancedDataLayerStatus(env, advancedData);
  const findings = [];
  const required = layers.filter((layer) => layer.requiredForTopTier);
  for (const layer of required.filter((layer) => !layer.configured)) add(findings, "P1", `缺少高级层：${layer.label}`, `配置 ${layer.env} 或接入合法免费/授权数据。`);
  const optionalMissing = layers.filter((layer) => !layer.requiredForTopTier && !layer.configured);
  if (optionalMissing.length) add(findings, "P2", `可选层未覆盖：${optionalMissing.map((layer) => layer.label).join("、")}`, "继续补天气、新闻等上下文源。");
  const fixtureCoverage = required.map((layer) => ({
    key: layer.key,
    label: layer.label,
    count: advancedData.layers?.[layer.key]?.count ?? 0,
    coverage: fixtureSet.fixtures?.length ? round((advancedData.layers?.[layer.key]?.count ?? 0) / fixtureSet.fixtures.length) : 0
  }));
  return stage("advanced", "高级数据特征", Math.round((required.filter((layer) => layer.configured).length / Math.max(1, required.length)) * 100), {
    generatedAt: advancedData.generatedAt,
    layers,
    fixtureCoverage
  }, findings);
}

function auditPredictionStage(recommendations, recommendationAudit) {
  const findings = [];
  if (!recommendations) {
    add(findings, "P0", "预测引擎运行失败", "先修复 recommendFixtures。");
    return stage("prediction", "胜平负预测", 0, {}, findings);
  }
  if (recommendationAudit?.summary?.errors) add(findings, "P0", `推荐审核错误：${recommendationAudit.summary.errors}`, "修复缺失快照、概率归一或派生冲突。");
  const normalized = recommendations.predictions.filter((prediction) => Math.abs(Object.values(prediction.probabilities ?? {}).reduce((sum, value) => sum + Number(value || 0), 0) - 1) <= 0.02).length;
  const simulations = recommendations.predictions.filter((prediction) => prediction.simulation?.iterations > 0).length;
  if (normalized !== recommendations.predictions.length) add(findings, "P0", `概率未归一：${normalized}/${recommendations.predictions.length}`, "概率层必须先修正再派生比分/半全场。");
  if (simulations !== recommendations.predictions.length) add(findings, "P1", `蒙特卡洛未覆盖：${simulations}/${recommendations.predictions.length}`, "补齐模拟层。");
  const quality = gradeDistribution(recommendations.predictions);
  return stage("prediction", "胜平负预测", coverageScore(normalized + simulations, recommendations.predictions.length * 2), {
    predictions: recommendations.predictions.length,
    normalized,
    simulations,
    quality
  }, findings);
}

function auditDerivativeStage(recommendations) {
  const findings = [];
  if (!recommendations) return stage("derivatives", "比分/半全场/14场派生", 0, {}, [finding("P0", "无推荐结果可审计", "先修复预测层。")]);
  const conflicts = recommendations.predictions.flatMap((prediction) => validatePredictionConsistency(prediction).map((message) => ({ match: `${prediction.fixture.homeTeam} vs ${prediction.fixture.awayTeam}`, message })));
  if (conflicts.length) add(findings, "P0", `比分/半全场冲突：${conflicts.length}`, "必须先定胜平负，再派生比分和半全场。");
  const shengfucaiWithDerivativeRisk = recommendations.predictions.filter((prediction) => prediction.fixture.marketType === "shengfucai" && (prediction.scorePicks?.primary || prediction.halfFullPicks?.primary)).length;
  if (shengfucaiWithDerivativeRisk) add(findings, "P2", `14场内部仍有派生字段：${shengfucaiWithDerivativeRisk}`, "表格输出层必须继续只输出胜平负/胆双全，不输出比分半全场。");
  const rules = recommendations.fourteen?.selections ?? [];
  const bankers = rules.filter((selection) => selection.type === "胆");
  if (bankers.some((selection) => selection.risk === "高")) add(findings, "P0", "14场存在高风险定胆", "高风险胆必须降为双选或全选。");
  return stage("derivatives", "比分/半全场/14场派生", conflicts.length ? 0 : 90, {
    conflicts,
    fourteenSelections: rules.length,
    bankers: bankers.length
  }, findings);
}

function auditBankrollStage(recommendations, env) {
  const findings = [];
  if (env.BANKROLL_RISK_POLICY !== "1") add(findings, "P0", "资金风控未启用", "设置 BANKROLL_RISK_POLICY=1。");
  const rows = recommendations?.predictions ?? [];
  const enabled = rows.filter((prediction) => prediction.bankroll?.enabled).length;
  const riskyEntries = rows.filter((prediction) => prediction.bankroll?.decision === "可入池" && (prediction.risk === "高" || Number(prediction.bankroll?.ev) <= 0));
  if (rows.length && enabled !== rows.length) add(findings, "P1", `资金风控覆盖不足：${enabled}/${rows.length}`, "每场必须计算 EV/凯利/仓位。");
  if (riskyEntries.length) add(findings, "P0", `高风险或负 EV 入池：${riskyEntries.length}`, "高风险/负 EV 必须强制跳过。");
  return stage("bankroll", "资金与回撤", rows.length ? coverageScore(enabled, rows.length) : 0, {
    enabled,
    total: rows.length,
    candidateEntries: rows.filter((prediction) => prediction.bankroll?.decision === "可入池").length,
    riskyEntries: riskyEntries.map((prediction) => `${prediction.fixture.homeTeam} vs ${prediction.fixture.awayTeam}`)
  }, findings);
}

function auditOutputStage(date) {
  const findings = [];
  const gate = readJson(join(exportDir, `realtime-source-gate-${date}.json`));
  const standard = readJson(join(exportDir, `data-completeness-standard-${date}.json`));
  const dailyStatus = readJson(join(exportDir, `daily-evolution-status-${date}.json`));
  if (!gate?.gate && !gate?.ok) add(findings, "P0", "缺少实时闸门输出", "先运行 crawler:realtime。");
  const gatePayload = gate?.gate ?? gate;
  if (gatePayload && !gatePayload.ok) add(findings, "P0", "实时闸门未通过", gatePayload.failures?.join("；") || "修复闸门失败原因。");
  if (standard && !standard.ok) add(findings, "P0", "完整度标准未通过", "standard:check 必须通过后才能正式推荐。");
  if (dailyStatus && dailyStatus.ok === false) add(findings, "P1", "日报生成被阻断", "这是正确保护；过闸后再生成 XLSX/微信输出。");
  return stage("output", "输出与自动化", scoreFrom(findings, gatePayload?.ok ? 1 : 0), {
    gateOk: gatePayload?.ok ?? false,
    standardOk: standard?.ok ?? false,
    dailyOk: dailyStatus?.ok ?? false
  }, findings);
}

function stage(key, label, score, details, findings) {
  const adjustedScore = scoreFrom(findings, score);
  return { key, label, score: Math.max(0, Math.min(100, Math.round(adjustedScore))), status: stageStatus(findings), details, findings };
}

function stageStatus(findings) {
  if (findings.some((item) => item.severity === "P0")) return "blocked";
  if (findings.some((item) => item.severity === "P1")) return "needs-data";
  if (findings.some((item) => item.severity === "P2")) return "watch";
  return "ready";
}

function add(findings, severity, title, remediation) {
  findings.push(finding(severity, title, remediation));
}

function finding(severity, title, remediation) {
  return { severity, title, remediation };
}

function coverageScore(count, total) {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

function scoreFrom(findings, base = 100) {
  return findings.reduce((score, item) => score - (item.severity === "P0" ? 45 : item.severity === "P1" ? 20 : 8), base);
}

function gradeDistribution(predictions) {
  const grades = {};
  for (const prediction of predictions) {
    const grade = prediction.advancedFeatures?.quality?.grade ?? "-";
    grades[grade] = (grades[grade] ?? 0) + 1;
  }
  return grades;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    return { ...fallback, error: error.message };
  }
}

function writeStageAudit(result) {
  const jsonPath = join(exportDir, `model-stage-audit-${result.date}.json`);
  const markdownPath = join(exportDir, `model-stage-audit-${result.date}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(result), "utf8");
}

function renderMarkdown(result) {
  return [
    `# 足球大模型阶段能力审计 ${result.date}`,
    "",
    `状态：${result.ok ? "通过" : "阻断"}`,
    `P0：${result.summary.p0}，P1：${result.summary.p1}，P2：${result.summary.p2}`,
    "",
    "| 阶段 | 状态 | 分数 | 发现 |",
    "|---|---|---:|---|",
    ...result.stages.map((stage) => `| ${stage.label} | ${stage.status} | ${stage.score} | ${stage.findings.map((item) => `${item.severity}:${item.title}`).join("<br>") || "无"} |`),
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

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? todayInShanghai();
  const result = auditModelStages(date);
  console.log(JSON.stringify({ ok: result.ok, summary: result.summary, path: join(exportDir, `model-stage-audit-${date}.json`) }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
