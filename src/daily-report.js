import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";
import { judgmentFactorColumns, judgmentFactorRow } from "./factor-analysis.js";
import { recommendFixtures, outcomeCodeToChinese } from "./prediction-engine.js";
import { auditRecommendations, writeRecommendationAudit } from "./recommendation-audit.js";
import { assertLatestRealtimeSourceGate } from "./realtime-source-gate.js";
import { writeXlsxWorkbook } from "./xlsx-writer.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const ledgerPath = join(exportDir, "recommendation-ledger.json");

export function buildDailyRecommendationPackage(date, options = {}) {
  mkdirSync(exportDir, { recursive: true });
  const sourceGate = assertLatestRealtimeSourceGate(date, { skip: options.skipRealtimeGate === true });
  const recommendations = recommendFixtures(date);
  const audit = auditRecommendations(recommendations);
  const auditPath = writeRecommendationAudit(date, audit);
  if (!audit.ok) throw new Error(`推荐内容审核未通过：${audit.errors.map((item) => item.message).join("；")}`);
  const jingcai = recommendations.predictions.filter((prediction) => prediction.fixture.marketType !== "shengfucai");
  const fourteen = recommendations.fourteen.selections;
  const recapRows = recommendations.predictions.map(toLedgerRow);
  const ledger = updateLedger(date, recapRows);
  const dailyPath = join(exportDir, `football-recommendations-${date}.xlsx`);
  const masterPath = join(exportDir, "football-recap-master.xlsx");
  writeXlsxWorkbook(dailyPath, [
    { name: "竞彩足球", rows: [jingcaiHeaders(), ...jingcai.map(toJingcaiRow)] },
    { name: "14场胜负彩", rows: [fourteenHeaders(), ...fourteen.map(toFourteenRow)] },
    { name: "任选9", rows: renxuan9Rows(recommendations.fourteen.renxuan9) },
    { name: "赔率变化对比", rows: [oddsComparisonHeaders(), ...recommendations.predictions.map(toOddsComparisonRow)] },
    { name: "融合判断要点", rows: [judgmentHeaders(), ...recommendations.predictions.map(toJudgmentRow)] },
    { name: "大小球阵容特色", rows: [totalGoalsLineupHeaders(), ...recommendations.predictions.map(toTotalGoalsLineupRow)] },
    { name: "复盘对比", rows: [recapHeaders(), ...recapRows.map(Object.values)] },
    { name: "模型健康", rows: modelHealthRows(sourceGate, audit) }
  ]);
  writeXlsxWorkbook(masterPath, [{ name: "复盘总表", rows: [recapHeaders(), ...ledger.map(Object.values)] }]);
  return { date, dailyPath, masterPath, recommendations, audit, auditPath, sourceGate, health: { ok: true }, ledgerRows: ledger.length };
}

function toJingcaiRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  return [
    fixture.date,
    fixture.sequence,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    snapshot ? "实时赔率已接入" : "缺少完整实时赔率",
    oddsText(snapshot?.europeanOdds),
    oddsText(snapshot?.asianHandicap),
    oddsText(snapshot?.handicapOdds),
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    pct(prediction.probabilities.home),
    pct(prediction.probabilities.draw),
    pct(prediction.probabilities.away),
    prediction.scorePicks.primary,
    prediction.scorePicks.secondary,
    prediction.halfFullPicks.primary,
    prediction.halfFullPicks.secondary,
    prediction.risk,
    prediction.confidence,
    bettingTier(prediction.probabilities),
    prediction.bankroll?.decision ?? "",
    prediction.bankroll?.ev ?? "",
    prediction.bankroll?.stakeUnitsPer100 ?? "",
    prediction.rationale
  ];
}

// 下注分级:按首选(top-prob)分桶,阈值依据 recommend:coverage 曲线
// (≥65%→历史命中~73%,50-65%→~64-67%,<50%→低于全推基线 54%)。
// 仅是「帮你挑高把握场」的过滤,不改变模型预测本身。
export function bettingTier(probabilities) {
  const top = Math.max(probabilities?.home ?? 0, probabilities?.draw ?? 0, probabilities?.away ?? 0);
  if (top >= 0.65) return "🟢 建议下注";
  if (top >= 0.50) return "🟡 可选";
  return "⚪ 慎选/观望";
}

function toFourteenRow(selection) {
  return [selection.index, selection.match, selection.single, selection.compound, selection.type, selection.risk, selection.confidence, selection.reason];
}

function toOddsComparisonRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  const europeanInitial = snapshot?.europeanOdds?.initial;
  const europeanCurrent = snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final;
  const asianInitial = snapshot?.asianHandicap?.initial;
  const asianCurrent = snapshot?.asianHandicap?.current ?? snapshot?.asianHandicap?.final;
  const handicapInitial = snapshot?.handicapOdds?.initial;
  const handicapCurrent = snapshot?.handicapOdds?.current ?? snapshot?.handicapOdds?.final;
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    snapshot?.collectedAt ?? "",
    snapshot ? "已接入实时赔率" : "缺少实时赔率",
    numberOrBlank(europeanInitial?.home),
    numberOrBlank(europeanInitial?.draw),
    numberOrBlank(europeanInitial?.away),
    numberOrBlank(europeanCurrent?.home),
    numberOrBlank(europeanCurrent?.draw),
    numberOrBlank(europeanCurrent?.away),
    oddsDelta(europeanCurrent?.home, europeanInitial?.home),
    oddsDelta(europeanCurrent?.draw, europeanInitial?.draw),
    oddsDelta(europeanCurrent?.away, europeanInitial?.away),
    numberOrBlank(asianInitial?.line),
    numberOrBlank(asianInitial?.homeWater),
    numberOrBlank(asianInitial?.awayWater),
    numberOrBlank(asianCurrent?.line),
    numberOrBlank(asianCurrent?.homeWater),
    numberOrBlank(asianCurrent?.awayWater),
    oddsDelta(asianCurrent?.line, asianInitial?.line),
    oddsDelta(asianCurrent?.homeWater, asianInitial?.homeWater),
    oddsDelta(asianCurrent?.awayWater, asianInitial?.awayWater),
    numberOrBlank(handicapInitial?.home),
    numberOrBlank(handicapInitial?.draw),
    numberOrBlank(handicapInitial?.away),
    numberOrBlank(handicapCurrent?.home),
    numberOrBlank(handicapCurrent?.draw),
    numberOrBlank(handicapCurrent?.away),
    oddsDelta(handicapCurrent?.home, handicapInitial?.home),
    oddsDelta(handicapCurrent?.draw, handicapInitial?.draw),
    oddsDelta(handicapCurrent?.away, handicapInitial?.away),
    marketOddsText(snapshot?.scoreOdds),
    marketOddsText(snapshot?.halfFullOdds),
    snapshot?.source ?? "",
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.scorePicks.primary,
    prediction.scorePicks.secondary,
    prediction.halfFullPicks.primary,
    prediction.halfFullPicks.secondary,
    prediction.risk,
    prediction.confidence,
    prediction.rationale
  ];
}

function toTotalGoalsLineupRow(prediction) {
  const fixture = prediction.fixture;
  const snapshot = prediction.marketSnapshot;
  const totalMarket = totalGoalsMarket(snapshot);
  const totalInitial = totalMarket?.initial;
  const totalCurrent = totalMarket?.current ?? totalMarket?.final;
  const model = modelTotalGoals(prediction);
  const fixtureData = prediction.advancedFeatures?.external?.fixtureData ?? {};
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    totalMarket ? "已接入大小球盘口" : "未抓到大小球盘口，使用模型派生",
    numberOrBlank(totalInitial?.line),
    numberOrBlank(totalInitial?.overWater ?? totalInitial?.over ?? totalInitial?.bigWater ?? totalInitial?.big),
    numberOrBlank(totalInitial?.underWater ?? totalInitial?.under ?? totalInitial?.smallWater ?? totalInitial?.small),
    numberOrBlank(totalCurrent?.line),
    numberOrBlank(totalCurrent?.overWater ?? totalCurrent?.over ?? totalCurrent?.bigWater ?? totalCurrent?.big),
    numberOrBlank(totalCurrent?.underWater ?? totalCurrent?.under ?? totalCurrent?.smallWater ?? totalCurrent?.small),
    oddsDelta(totalCurrent?.line, totalInitial?.line),
    oddsDelta(totalCurrent?.overWater ?? totalCurrent?.over ?? totalCurrent?.bigWater ?? totalCurrent?.big, totalInitial?.overWater ?? totalInitial?.over ?? totalInitial?.bigWater ?? totalInitial?.big),
    oddsDelta(totalCurrent?.underWater ?? totalCurrent?.under ?? totalCurrent?.smallWater ?? totalCurrent?.small, totalInitial?.underWater ?? totalInitial?.under ?? totalInitial?.smallWater ?? totalInitial?.small),
    model.expectedGoals,
    pct(model.over25),
    pct(model.under25),
    pct(model.over35),
    model.bias,
    teamStyle("home", prediction),
    teamStyle("away", prediction),
    formText(fixtureData.form?.home),
    formText(fixtureData.form?.away),
    eloText(fixtureData.elo?.home),
    eloText(fixtureData.elo?.away),
    injuryText(fixtureData.injuries),
    projectedLineupText(fixtureData.lineups, fixture),
    actualLineupText(fixtureData.lineups, fixture),
    lineupSourceText(fixtureData.lineups),
    prediction.rationale
  ];
}

function toJudgmentRow(prediction) {
  const fixture = prediction.fixture;
  return [
    fixture.date,
    fixture.sequence,
    fixture.marketType,
    fixture.competition,
    fixture.homeTeam,
    fixture.awayTeam,
    fixture.kickoff,
    outcomeCodeToChinese(prediction.pick.code),
    outcomeCodeToChinese(prediction.secondaryPick.code),
    prediction.scorePicks.primary,
    prediction.halfFullPicks.primary,
    prediction.confidence,
    prediction.risk,
    ...judgmentFactorRow(prediction)
  ];
}

// 取某选项(pickCode 3=主/1=平/0=客)在一组欧赔里的小数赔率。
function pickDecimalOdds(europeanOdds, pickCode) {
  const key = pickCode === "3" ? "home" : pickCode === "1" ? "draw" : pickCode === "0" ? "away" : null;
  if (!key) return null;
  const v = Number(europeanOdds?.[key]);
  return Number.isFinite(v) && v > 1 ? v : null;
}

function toLedgerRow(prediction) {
  const fixture = prediction.fixture;
  const actual = fixture.result ? resultCode(fixture.result) : "";
  // CLV(分析师建议的真 KPI):记录下注时该选项的小数赔率 + 开盘价 + 捕获时刻,
  // 结算时与收盘快照对比算 CLV。current 是我们生成推荐时的"下注价"。
  const snap = prediction.marketSnapshot;
  const euBet = snap?.europeanOdds?.current ?? snap?.europeanOdds?.final;
  const euOpen = snap?.europeanOdds?.initial;
  return {
    date: fixture.date,
    sequence: fixture.sequence,
    competition: fixture.competition,
    match: `${fixture.homeTeam} 对 ${fixture.awayTeam}`,
    primary: outcomeCodeToChinese(prediction.pick.code),
    secondary: outcomeCodeToChinese(prediction.secondaryPick.code),
    scorePrimary: prediction.scorePicks.primary,
    scoreSecondary: prediction.scorePicks.secondary,
    halfFullPrimary: prediction.halfFullPicks.primary,
    halfFullSecondary: prediction.halfFullPicks.secondary,
    probabilityHome: prediction.probabilities.home,
    probabilityDraw: prediction.probabilities.draw,
    probabilityAway: prediction.probabilities.away,
    baseProbabilityHome: prediction.baseProbabilities?.home ?? "",
    baseProbabilityDraw: prediction.baseProbabilities?.draw ?? "",
    baseProbabilityAway: prediction.baseProbabilities?.away ?? "",
    monteCarloHome: prediction.simulation?.outcomeProbabilities?.home ?? "",
    monteCarloDraw: prediction.simulation?.outcomeProbabilities?.draw ?? "",
    monteCarloAway: prediction.simulation?.outcomeProbabilities?.away ?? "",
    monteCarloTopScores: prediction.simulation?.topScores?.slice(0, 3).map((item) => `${item.score}:${pct(item.probability)}`).join(" / ") ?? "",
    risk: prediction.risk,
    confidence: prediction.confidence,
    tier: bettingTier(prediction.probabilities),
    bankrollDecision: prediction.bankroll?.decision ?? "",
    ev: prediction.bankroll?.ev ?? null,
    stakeUnitsPer100: prediction.bankroll?.stakeUnitsPer100 ?? null,
    // D 档接入(2026-05-28):ensembleView 概率落盘,backtest 算其 RPS 跟主路径对比
    ensembleHome: prediction.ensembleView?.probabilities?.home ?? "",
    ensembleDraw: prediction.ensembleView?.probabilities?.draw ?? "",
    ensembleAway: prediction.ensembleView?.probabilities?.away ?? "",
    ensembleMethods: prediction.ensembleView?.methodCount ?? 0,
    reason: prediction.rationale,
    // CLV 原料(结算时用):primaryOdds=下注价,primaryOpeningOdds=开盘价,betCapturedAt=捕获时刻
    primaryOdds: pickDecimalOdds(euBet, prediction.pick.code),
    primaryOpeningOdds: pickDecimalOdds(euOpen, prediction.pick.code),
    betCapturedAt: snap?.collectedAt ?? null,
    actual: outcomeCodeToChinese(actual),
    actualScore: fixture.result ? `${fixture.result.home}-${fixture.result.away}` : "",
    hit: actual ? actual === prediction.pick.code : null
  };
}

function updateLedger(date, rows) {
  const existing = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")).filter((row) => row.date !== date) : [];
  const next = [...existing, ...rows];
  writeFileSync(ledgerPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function jingcaiHeaders() {
  return ["日期", "场次", "赛事", "主队", "客队", "开赛", "赔率实时状态", "胜平负赔率", "亚洲盘口", "让球胜平负", "胜平负首选", "胜平负次选", "主胜概率", "平局概率", "客胜概率", "比分首选", "比分次选", "半全场首选", "半全场次选", "风险", "信心", "下注分级", "资金决策", "EV", "每100单位建议", "推荐理由"];
}

function fourteenHeaders() {
  return ["场次", "比赛", "单式推荐", "覆盖选择", "类型", "风险", "信心", "选择理由"];
}

// 任选9 sheet:从 14 场挑最稳 9 场单选,9 场全对即中。
function renxuan9Rows(renxuan9) {
  const header = ["序", "比赛", "推荐", "主胜概率", "信心", "风险", "概率差"];
  if (!renxuan9?.ok) {
    return [header, ["—", renxuan9?.reason ?? "任选9 不可用(可选场次不足 9)", "", "", "", "", ""]];
  }
  const rows = renxuan9.picks.map((p) => [
    p.rank,
    p.match,
    p.pick,
    pct(p.probability),
    p.confidence,
    p.risk,
    p.gap
  ]);
  const ind = renxuan9.parlay?.jointProbabilityIndependent ?? null;
  const adj = renxuan9.parlay?.jointProbabilityCorrelated ?? null;
  const summary = [
    ["", "", "", "", "", "", ""],
    ["单式串", renxuan9.singleLine, "", "", "", "", ""],
    ["9 串联合命中率", ind != null ? `独立估计 ${pct(ind)}` : "—", adj != null ? `相关性修正 ${pct(adj)}` : "—", "", "", "", ""],
    ["说明", renxuan9.note, "", "", "", "", ""]
  ];
  return [header, ...rows, ...summary];
}

function judgmentHeaders() {
  return ["日期", "场次", "市场", "赛事", "主队", "客队", "开赛", "首选", "备选", "比分首选", "半全场首选", "信心", "风险", ...judgmentFactorColumns()];
}

function oddsComparisonHeaders() {
  return [
    "日期",
    "场次",
    "市场",
    "赛事",
    "主队",
    "客队",
    "开赛时间",
    "赔率采集时间",
    "实时状态",
    "欧赔初始主胜",
    "欧赔初始平局",
    "欧赔初始客胜",
    "欧赔实时主胜",
    "欧赔实时平局",
    "欧赔实时客胜",
    "欧赔主胜变化",
    "欧赔平局变化",
    "欧赔客胜变化",
    "亚盘初始盘口",
    "亚盘初始主水",
    "亚盘初始客水",
    "亚盘实时盘口",
    "亚盘实时主水",
    "亚盘实时客水",
    "亚盘盘口变化",
    "亚盘主水变化",
    "亚盘客水变化",
    "让球初始主胜",
    "让球初始平局",
    "让球初始客胜",
    "让球实时主胜",
    "让球实时平局",
    "让球实时客胜",
    "让球主胜变化",
    "让球平局变化",
    "让球客胜变化",
    "比分赔率",
    "半全场赔率",
    "赔率来源",
    "胜平负首选",
    "胜平负备选",
    "比分首选",
    "比分备选",
    "半全场首选",
    "半全场备选",
    "风险",
    "信心",
    "模型理由"
  ];
}

function totalGoalsLineupHeaders() {
  return [
    "日期",
    "场次",
    "市场",
    "赛事",
    "主队",
    "客队",
    "开赛时间",
    "大小球数据状态",
    "大小球初始盘口",
    "初始大球水",
    "初始小球水",
    "大小球实时盘口",
    "实时大球水",
    "实时小球水",
    "大小球盘口变化",
    "大球水变化",
    "小球水变化",
    "模型预期总进球",
    "大2.5概率",
    "小2.5概率",
    "大3.5概率",
    "大小球倾向",
    "主队特色",
    "客队特色",
    "主队近期状态",
    "客队近期状态",
    "主队Elo",
    "客队Elo",
    "伤停信息",
    "预计阵容",
    "实际阵容",
    "阵容来源状态",
    "模型理由"
  ];
}

function recapHeaders() {
  return ["日期", "场次", "赛事", "比赛", "首选", "次选", "比分首选", "比分次选", "半全场首选", "半全场次选", "主胜概率", "平局概率", "客胜概率", "原始主胜概率", "原始平局概率", "原始客胜概率", "蒙特卡洛主胜", "蒙特卡洛平局", "蒙特卡洛客胜", "蒙特卡洛比分Top3", "风险", "信心", "资金决策", "EV", "每100单位建议", "理由", "实际赛果", "实际比分", "命中"];
}

function modelHealthRows(sourceGate, audit) {
  return [
    ["检查项", "状态", "说明"],
    ["实时数据源闸门", sourceGate.ok ? "通过" : "失败", `闸门年龄 ${sourceGate.ageMinutes ?? 0} 分钟`],
    ["推荐内容审核", audit.ok ? "通过" : "失败", `${audit.summary.totalChecks} 场已审核`],
    ["14场输出规则", "启用", "表格主输出胜平负、胆/双选/全选；比分和半全场只从已定胜平负派生并通过冲突审计"],
    ["严格赔率门槛", process.env.SOURCE_GATE_REQUIRE_FULL_ODDS === "1" ? "启用" : "降级允许", "启用后缺少全量赔率会阻断正式生成"]
  ];
}

function oddsText(oddsSet) {
  const point = oddsSet?.current ?? oddsSet?.final ?? oddsSet?.initial;
  if (!point) return "缺失";
  if ("line" in point) return `盘口 ${point.line}，主水 ${point.homeWater}，客水 ${point.awayWater}`;
  return `胜 ${point.home}，平 ${point.draw}，负 ${point.away}`;
}

function marketOddsText(oddsSet) {
  if (!oddsSet) return "缺失";
  if (Array.isArray(oddsSet)) return oddsSet.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  if (Array.isArray(oddsSet.top)) return oddsSet.top.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  const point = oddsSet.current ?? oddsSet.final ?? oddsSet.initial ?? oddsSet;
  if (Array.isArray(point)) return point.map(formatMarketOddsPoint).filter(Boolean).join(" / ") || "缺失";
  return formatMarketOddsPoint(point) || oddsText(oddsSet);
}

function formatMarketOddsPoint(point) {
  if (!point || typeof point !== "object") return "";
  if ("score" in point) return `${point.score}:${point.odds ?? point.value ?? ""}`;
  if ("halfFull" in point) return `${point.halfFull}:${point.odds ?? point.value ?? ""}`;
  if ("label" in point) return `${point.label}:${point.odds ?? point.value ?? ""}`;
  if ("home" in point || "draw" in point || "away" in point) return `胜 ${point.home ?? ""}，平 ${point.draw ?? ""}，负 ${point.away ?? ""}`;
  return "";
}

function numberOrBlank(value) {
  return Number.isFinite(value) ? value : "";
}

function oddsDelta(current, initial) {
  if (!Number.isFinite(current) || !Number.isFinite(initial)) return "";
  const delta = Math.round((current - initial) * 1000) / 1000;
  if (Object.is(delta, -0)) return "0";
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function totalGoalsMarket(snapshot) {
  const total = snapshot?.totalGoalsOdds ?? snapshot?.overUnderOdds ?? snapshot?.totalsOdds ?? snapshot?.totals ?? null;
  if (!total) return null;
  if (total.initial || total.current || total.final) return total;
  return { initial: total, current: total };
}

function modelTotalGoals(prediction) {
  const lambdas = prediction.simulation?.lambdas ?? {};
  const expectedGoals = round((lambdas.home ?? 0) + (lambdas.away ?? 0));
  const over25 = round(1 - poissonCdf(2, expectedGoals));
  const under25 = round(1 - over25);
  const over35 = round(1 - poissonCdf(3, expectedGoals));
  return {
    expectedGoals,
    over25,
    under25,
    over35,
    bias: over25 >= 0.58 ? "偏大球" : under25 >= 0.58 ? "偏小球" : "中性"
  };
}

function teamStyle(side, prediction) {
  const lambdas = prediction.simulation?.lambdas ?? {};
  const own = side === "home" ? lambdas.home ?? 0 : lambdas.away ?? 0;
  const opponent = side === "home" ? lambdas.away ?? 0 : lambdas.home ?? 0;
  const total = own + opponent;
  if (own >= 2.1) return "高压强攻/进球上限高";
  if (own >= 1.65 && own - opponent >= 0.35) return "进攻优势/主动压制";
  if (own <= 1.05 && opponent >= 1.55) return "防守承压/反击为主";
  if (total <= 2.25) return "节奏偏慢/小比分属性";
  if (Math.abs(own - opponent) <= 0.2) return "均衡对抗/容错偏低";
  return "均衡偏主动";
}

function formText(form) {
  if (!form || !Number.isFinite(form.matches) || form.matches <= 0) return "缺失";
  return `近${form.matches}场 ${numberOrBlank(form.pointsPerMatch)}分/场，净胜球${numberOrBlank(form.goalDiff)}`;
}

function eloText(elo) {
  if (!elo) return "缺失";
  const value = elo.Elo ?? elo.elo ?? elo.rating;
  return Number.isFinite(Number(value)) ? `Elo ${Math.round(Number(value))}` : "缺失";
}

function injuryText(injuries) {
  const rows = injuries?.injuries ?? injuries?.rows ?? (Array.isArray(injuries) ? injuries : []);
  if (!Array.isArray(rows) || !rows.length) return "缺失/未返回";
  const names = rows.map((row) => row.player?.name ?? row.playerName ?? row.name).filter(Boolean).slice(0, 8);
  return `${rows.length}条${names.length ? `：${names.join("、")}` : ""}`;
}

function projectedLineupText(lineups, fixture) {
  const projected = lineups?.projected ?? lineups?.predicted ?? lineups?.probable ?? lineups?.expected;
  if (projected) return formatLineupRows(projected, fixture);
  if (lineups?.lineups?.length) return "未提供预计阵容；已有确认阵容见实际阵容";
  return "缺失：未配置/未返回 LINEUP_SOURCE_URL";
}

function actualLineupText(lineups, fixture) {
  const actual = lineups?.actual ?? lineups?.confirmed ?? lineups?.lineups;
  if (actual) return formatLineupRows(actual, fixture);
  return "未公布/未返回；通常赛前约1小时才有";
}

function lineupSourceText(lineups) {
  if (!lineups) return "缺 LINEUP_SOURCE_URL/API-Football 未匹配";
  if (lineups.error) return `阵容源错误：${lineups.error}`;
  if (lineups.providerFixtureId) return `API-Football fixture=${lineups.providerFixtureId}`;
  return "授权阵容源";
}

function formatLineupRows(value, fixture) {
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => {
    const team = row.team?.name ?? row.teamName ?? row.name ?? "";
    const formation = row.formation ? ` ${row.formation}` : "";
    const starters = row.startXI ?? row.startingXI ?? row.players ?? row.lineup ?? [];
    const names = Array.isArray(starters)
      ? starters.map((item) => item.player?.name ?? item.name ?? item.playerName).filter(Boolean).slice(0, 11)
      : [];
    const label = team || (sameText(row.side, "home") ? fixture.homeTeam : sameText(row.side, "away") ? fixture.awayTeam : "阵容");
    return `${label}${formation}${names.length ? `：${names.join("、")}` : ""}`;
  }).filter(Boolean).join(" | ") || "未返回球员明细";
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function poissonCdf(maxGoals, lambda) {
  if (!Number.isFinite(lambda) || lambda < 0) return 0;
  let sum = 0;
  for (let goals = 0; goals <= maxGoals; goals += 1) {
    sum += Math.exp(-lambda) * (lambda ** goals) / factorial(goals);
  }
  return Math.max(0, Math.min(1, sum));
}

function factorial(value) {
  let result = 1;
  for (let index = 2; index <= value; index += 1) result *= index;
  return result;
}

function resultCode(result) {
  if (result.home > result.away) return "3";
  if (result.home === result.away) return "1";
  return "0";
}

function pct(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
