import { mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgmentFactors, judgmentFactorColumns, judgmentFactorRow } from "../src/factor-analysis.js";
import { recommendFixtures, outcomeCodeToChinese } from "../src/prediction-engine.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const date = readArg("--date") ?? new Date().toISOString().slice(0, 10);
const exportDir = join(rootDir, "data", "exports");
const dExportDir = "D:\\football-model-exports";
mkdirSync(exportDir, { recursive: true });
mkdirSync(dExportDir, { recursive: true });

const recommendations = recommendFixtures(date);
const gatePayload = readJson(join(exportDir, `realtime-source-gate-${date}.json`));
const gate = gatePayload?.gate ?? gatePayload;
const standard = readJson(join(exportDir, `data-completeness-standard-${date}.json`));
const audit = readJson(join(exportDir, `recommendation-audit-${date}.json`));
const defectAudit = readJson(join(exportDir, `model-defect-audit-${date}.json`));

const predictions = recommendations.predictions;
const jingcai = predictions
  .filter((prediction) => prediction.fixture.marketType === "jingcai")
  .sort((left, right) => fixtureOrder(left.fixture).localeCompare(fixtureOrder(right.fixture), "zh-CN"));
const fourteen = recommendations.fourteen.selections;
const outputName = `football-recommendations-latest-${date}.xlsx`;
const localPath = join(exportDir, outputName);
const dPath = join(dExportDir, outputName);

writeXlsxWorkbook(localPath, [
  { name: "总览审计", rows: summaryRows() },
  { name: "竞彩正式版", rows: [jingcaiHeaders(), ...jingcai.map(toJingcaiRow)] },
  { name: "14场精选", rows: [fourteenHeaders(), ...fourteen.map(toFourteenRow)] },
  { name: "融合判断要点", rows: [factorHeaders(), ...predictions.map(toFactorRow)] },
  { name: "赔率变化快照", rows: [oddsHeaders(), ...predictions.map(toOddsRow)] },
  { name: "爆冷观察", rows: [upsetHeaders(), ...predictions.map(toUpsetRow)] }
]);
copyFileSync(localPath, dPath);

console.log(JSON.stringify({
  ok: true,
  date,
  localPath,
  dPath,
  generatedAt: recommendations.generatedAt,
  gate: gate?.summary ?? null,
  standard: standard?.summary ?? null,
  audit: audit?.summary ?? null,
  defectAudit: defectAudit?.summary ?? null,
  fourteenLine: fourteen.map((selection) => `${selection.index}.${selection.compound}`).join(" ")
}, null, 2));

function summaryRows() {
  return [
    ["项目", "结果"],
    ["生成日期", date],
    ["模型生成时间", recommendations.generatedAt],
    ["闸门状态", gate?.ok ? "通过" : "未通过"],
    ["闸门生成时间", gate?.generatedAt ?? ""],
    ["竞彩场次", gate?.summary?.jingcaiMatches ?? jingcai.length],
    ["14场场次", gate?.summary?.shengfucaiMatches ?? fourteen.length],
    ["实时赔率可用", `${gate?.summary?.marketUsable ?? ""}/${gate?.summary?.fixtures ?? ""}`],
    ["完整性检查", standard?.ok ? "通过" : "未通过"],
    ["推荐一致性错误", audit?.summary?.errors ?? ""],
    ["推荐一致性警告", audit?.summary?.warnings ?? ""],
    ["14场胆数量", audit?.summary?.fourteenBankers ?? ""],
    ["高级源缺陷", `P0=${defectAudit?.summary?.bySeverity?.P0 ?? 0}; P1=${defectAudit?.summary?.bySeverity?.P1 ?? 0}; P2=${defectAudit?.summary?.bySeverity?.P2 ?? 0}`],
    ["说明", "胜平负先定，比分与半全场由胜平负派生并做一致性审计；赔率为本次闸门快照。"]
  ];
}

function jingcaiHeaders() {
  return [
    "日期", "场次", "赛事", "开赛", "主队", "客队", "首选", "备选", "主胜概率", "平局概率", "客胜概率",
    "比分首选", "比分备选", "半全场首选", "半全场备选", "信心", "风险", "爆冷等级", "爆冷方向",
    "欧赔初始", "欧赔即时", "欧赔变化", "让球初始", "让球即时", "让球变化", "大小球倾向",
    ...judgmentFactorColumns(), "模型理由"
  ];
}

function fourteenHeaders() {
  return ["序号", "比赛", "单式", "覆盖", "类型", "风险", "信心", "欧赔即时", "盘口即时", "精选理由"];
}

function oddsHeaders() {
  return [
    "市场", "场次", "赛事", "主队", "客队", "采集时间", "来源", "欧赔初主", "欧赔初平", "欧赔初客",
    "欧赔即主", "欧赔即平", "欧赔即客", "欧赔主变化", "欧赔平变化", "欧赔客变化",
    "亚盘初盘", "亚盘初主水", "亚盘初客水", "亚盘即盘", "亚盘即主水", "亚盘即客水",
    "让球初主", "让球初平", "让球初客", "让球即主", "让球即平", "让球即客"
  ];
}

function factorHeaders() {
  return ["市场", "场次", "赛事", "主队", "客队", "首选", "备选", "比分", "半全场", "信心", "风险", ...judgmentFactorColumns()];
}

function upsetHeaders() {
  return ["市场", "场次", "比赛", "首选", "备选", "风险", "信心", "爆冷可能", "主要原因", "防守选项"];
}

function toJingcaiRow(prediction) {
  const snapshot = prediction.marketSnapshot;
  const fixture = prediction.fixture;
  return [
    fixture.date,
    fixture.sequence,
    fixture.competition,
    fixture.kickoff,
    fixture.homeTeam,
    fixture.awayTeam,
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    pct(prediction.probabilities.home),
    pct(prediction.probabilities.draw),
    pct(prediction.probabilities.away),
    prediction.scorePicks.primary,
    prediction.scorePicks.secondary,
    prediction.halfFullPicks.primary,
    prediction.halfFullPicks.secondary,
    prediction.confidence,
    prediction.risk,
    upsetLevel(prediction),
    upsetDirection(prediction),
    oddsText(snapshot?.europeanOdds?.initial),
    oddsText(snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final),
    oddsDeltaText(snapshot?.europeanOdds),
    oddsText(snapshot?.handicapOdds?.initial),
    oddsText(snapshot?.handicapOdds?.current ?? snapshot?.handicapOdds?.final),
    oddsDeltaText(snapshot?.handicapOdds),
    totalGoalsBias(prediction),
    ...judgmentFactorRow(prediction),
    prediction.rationale
  ];
}

function toFourteenRow(selection) {
  const prediction = predictions.find((item) => item.fixture.marketType === "shengfucai" && String(item.fixture.sequence) === String(selection.index));
  const snapshot = prediction?.marketSnapshot;
  return [
    selection.index,
    selection.match,
    selection.single,
    selection.compound,
    selection.type,
    selection.risk,
    selection.confidence,
    oddsText(snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final),
    asianText(snapshot?.asianHandicap?.current ?? snapshot?.asianHandicap?.final),
    selection.reason
  ];
}

function toOddsRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  const europeanInitial = snapshot?.europeanOdds?.initial;
  const europeanCurrent = snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final;
  const asianInitial = snapshot?.asianHandicap?.initial;
  const asianCurrent = snapshot?.asianHandicap?.current ?? snapshot?.asianHandicap?.final;
  const handicapInitial = snapshot?.handicapOdds?.initial;
  const handicapCurrent = snapshot?.handicapOdds?.current ?? snapshot?.handicapOdds?.final;
  return [
    fixture.marketType,
    fixture.sequence,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    snapshot?.collectedAt ?? "",
    snapshot?.source ?? "",
    num(europeanInitial?.home),
    num(europeanInitial?.draw),
    num(europeanInitial?.away),
    num(europeanCurrent?.home),
    num(europeanCurrent?.draw),
    num(europeanCurrent?.away),
    delta(europeanCurrent?.home, europeanInitial?.home),
    delta(europeanCurrent?.draw, europeanInitial?.draw),
    delta(europeanCurrent?.away, europeanInitial?.away),
    num(asianInitial?.line),
    num(asianInitial?.homeWater),
    num(asianInitial?.awayWater),
    num(asianCurrent?.line),
    num(asianCurrent?.homeWater),
    num(asianCurrent?.awayWater),
    num(handicapInitial?.home),
    num(handicapInitial?.draw),
    num(handicapInitial?.away),
    num(handicapCurrent?.home),
    num(handicapCurrent?.draw),
    num(handicapCurrent?.away)
  ];
}

function toFactorRow(prediction) {
  const fixture = prediction.fixture;
  return [
    fixture.marketType,
    fixture.sequence,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.scorePicks.primary,
    prediction.halfFullPicks.primary,
    prediction.confidence,
    prediction.risk,
    ...judgmentFactorRow(prediction)
  ];
}

function toUpsetRow(prediction) {
  const fixture = prediction.fixture;
  const analysis = buildJudgmentFactors(prediction);
  return [
    fixture.marketType,
    fixture.sequence,
    `${fixture.homeTeam} vs ${fixture.awayTeam}`,
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.risk,
    prediction.confidence,
    analysis.factors.upset.level,
    analysis.factors.upset.point,
    defensiveCover(prediction)
  ];
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fixtureOrder(fixture) {
  return `${fixture.date}-${String(fixture.sequence).padStart(8, "0")}`;
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "";
}

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : "";
}

function delta(current, initial) {
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(initial))) return "";
  return Number((Number(current) - Number(initial)).toFixed(3));
}

function oddsText(odds) {
  if (!odds) return "";
  return `主${blank(odds.home)} 平${blank(odds.draw)} 客${blank(odds.away)}`;
}

function asianText(odds) {
  if (!odds) return "";
  return `盘${blank(odds.line)} 主水${blank(odds.homeWater)} 客水${blank(odds.awayWater)}`;
}

function oddsDeltaText(odds) {
  if (!odds?.initial) return "";
  const current = odds.current ?? odds.final;
  if (!current) return "";
  return `主${signed(delta(current.home, odds.initial.home))} 平${signed(delta(current.draw, odds.initial.draw))} 客${signed(delta(current.away, odds.initial.away))}`;
}

function signed(value) {
  if (value === "") return "";
  return value > 0 ? `+${value}` : String(value);
}

function blank(value) {
  return Number.isFinite(Number(value)) ? Number(value) : "";
}

function upsetLevel(prediction) {
  if (prediction.risk === "high") return "高";
  if (prediction.confidence < 45) return "中高";
  if (prediction.confidence < 55) return "中";
  return "低";
}

function upsetDirection(prediction) {
  return outcomeCodeToChinese(prediction.secondaryPick.code);
}

function upsetReason(prediction) {
  const probabilities = prediction.probabilities;
  const sorted = [
    ["主胜", probabilities.home],
    ["平局", probabilities.draw],
    ["客胜", probabilities.away]
  ].sort((left, right) => right[1] - left[1]);
  const gap = sorted[0][1] - sorted[1][1];
  if (prediction.risk === "high" || gap < 0.08) return "主选与备选概率接近，盘口分歧大，需防冷";
  if (prediction.confidence < 55) return "信心不足中位，赔率变化需继续观察";
  return "主方向较清晰，冷门仅作组合防守";
}

function defensiveCover(prediction) {
  return `${outcomeCodeToChinese(prediction.pick.code)} / ${outcomeCodeToChinese(prediction.secondaryPick.code)}`;
}

function totalGoalsBias(prediction) {
  const expectedGoals = prediction.simulation?.expectedGoals ?? prediction.advancedFeatures?.expectedGoals;
  if (!Number.isFinite(Number(expectedGoals))) return "";
  if (expectedGoals >= 3) return `偏大球(${Number(expectedGoals).toFixed(2)})`;
  if (expectedGoals <= 2.2) return `偏小球(${Number(expectedGoals).toFixed(2)})`;
  return `中性(${Number(expectedGoals).toFixed(2)})`;
}
