const OUTCOME_LABELS = {
  "3": "主胜",
  "1": "平局",
  "0": "客胜"
};

export function buildJudgmentFactors(prediction) {
  const upset = upsetFactor(prediction);
  const totals = totalsFactor(prediction);
  const motivation = motivationFactor(prediction);
  const lineup = lineupFactor(prediction);
  const form = formFactor(prediction);
  const odds = oddsMovementFactor(prediction);
  const factors = { upset, totals, motivation, lineup, form, odds };
  const riskScore = Object.values(factors).reduce((sum, factor) => sum + factor.riskScore, 0);
  const supportScore = Object.values(factors).reduce((sum, factor) => sum + factor.supportScore, 0);
  const net = supportScore - riskScore;
  const confidence = prediction.confidence >= 70 && net >= -1 ? "强" : prediction.confidence >= 55 && net >= -2 ? "中强" : net <= -4 ? "谨慎" : "中";
  return {
    factors,
    riskScore,
    supportScore,
    confidence,
    summary: [
      `主判断：${outcomeLabel(prediction.pick?.code)}，防${outcomeLabel(prediction.secondaryPick?.code)}`,
      `冷门：${upset.level}（${upset.point}）`,
      `大小球：${totals.bias}（${totals.point}）`,
      `赔率：${odds.direction}（${odds.point}）`,
      `状态/阵容：${form.direction}；${lineup.direction}`,
      `综合：${confidence}信心，${net >= 0 ? "支撑大于风险" : "风险需覆盖"}`
    ].join("；")
  };
}

export function judgmentFactorColumns() {
  return [
    "爆冷因素",
    "大小球因素",
    "升降级/战意因素",
    "阵容因素",
    "状态因素",
    "赔率变化因素",
    "融合判断要点"
  ];
}

export function judgmentFactorRow(prediction) {
  const analysis = buildJudgmentFactors(prediction);
  return [
    factorText(analysis.factors.upset),
    factorText(analysis.factors.totals),
    factorText(analysis.factors.motivation),
    factorText(analysis.factors.lineup),
    factorText(analysis.factors.form),
    factorText(analysis.factors.odds),
    analysis.summary
  ];
}

function upsetFactor(prediction) {
  const gap = probabilityGap(prediction);
  const risk = prediction.risk === "高" || gap < 0.08 ? "高" : gap < 0.14 ? "中" : "低";
  const secondary = outcomeLabel(prediction.secondaryPick?.code);
  const odds = prediction.marketSnapshot?.europeanOdds?.current ?? {};
  const pickKey = outcomeKey(prediction.pick?.code);
  const secondaryKey = outcomeKey(prediction.secondaryPick?.code);
  const pickOdds = Number(odds[pickKey]);
  const secondaryOdds = Number(odds[secondaryKey]);
  const priceWarning = Number.isFinite(pickOdds) && Number.isFinite(secondaryOdds) && secondaryOdds / pickOdds < 1.55;
  return {
    name: "爆冷",
    level: priceWarning && risk !== "低" ? "中高" : risk,
    direction: `防${secondary}`,
    point: gap < 0.08 ? "概率差过小" : priceWarning ? "备选赔付不高，市场不排除" : "主方向概率领先",
    riskScore: risk === "高" ? 3 : risk === "中" || priceWarning ? 2 : 0,
    supportScore: risk === "低" ? 2 : 0
  };
}

function totalsFactor(prediction) {
  const expectedGoals = totalExpectedGoals(prediction);
  const snapshot = prediction.marketSnapshot;
  const totalMarket = snapshot?.totalGoalsOdds ?? snapshot?.overUnderOdds ?? snapshot?.totalsOdds ?? snapshot?.totals;
  const current = totalMarket?.current ?? totalMarket?.final ?? totalMarket;
  const line = Number(current?.line);
  const bias = Number.isFinite(expectedGoals)
    ? expectedGoals >= 3 ? "偏大球" : expectedGoals <= 2.2 ? "偏小球" : "中性"
    : "缺少盘口";
  const marketPoint = Number.isFinite(line) ? `盘口${line}` : "无明确大小球盘口，使用比分/蒙特卡洛推导";
  return {
    name: "大小球",
    level: bias,
    bias,
    direction: bias,
    point: Number.isFinite(expectedGoals) ? `${marketPoint}，模型总进球${expectedGoals.toFixed(2)}` : marketPoint,
    riskScore: bias === "中性" ? 1 : 0,
    supportScore: bias !== "中性" && bias !== "缺少盘口" ? 1 : 0
  };
}

function motivationFactor(prediction) {
  const fixtureData = fixtureDataOf(prediction);
  const motivation = fixtureData.motivation ?? fixtureData.news?.motivation ?? fixtureData.tableContext ?? {};
  const text = [motivation.home, motivation.away, motivation.summary, motivation.note].filter(Boolean).join("；");
  const competition = String(prediction.fixture?.competition ?? "");
  const inferred = /英冠|西甲|意甲|德甲|荷乙|瑞超|芬超|美职/.test(competition)
    ? "联赛阶段需关注争冠、欧战、保级、升级附加赛战意"
    : "杯赛/跨联赛战意以轮换和赛程优先";
  return {
    name: "升降级/战意",
    level: text ? "已接入" : "推断",
    direction: text || inferred,
    point: text || inferred,
    riskScore: text ? 0 : 1,
    supportScore: text ? 1 : 0
  };
}

function lineupFactor(prediction) {
  const fixtureData = fixtureDataOf(prediction);
  const injuries = fixtureData.injuries?.injuries ?? fixtureData.injuries?.rows ?? (Array.isArray(fixtureData.injuries) ? fixtureData.injuries : []);
  const lineups = fixtureData.lineups;
  const injuryCount = Array.isArray(injuries) ? injuries.length : 0;
  const hasLineup = Boolean(lineups?.actual || lineups?.confirmed || lineups?.lineups || lineups?.projected || lineups?.predicted || lineups?.probable);
  const level = injuryCount >= 4 ? "伤停偏多" : hasLineup ? "阵容有源" : "阵容缺口";
  return {
    name: "阵容",
    level,
    direction: hasLineup ? "阵容源已匹配" : "未匹配预计/实际阵容，临场需复核",
    point: `${hasLineup ? "有阵容信息" : "无阵容信息"}；伤停记录${injuryCount}条`,
    riskScore: hasLineup ? (injuryCount >= 4 ? 2 : 0) : 1,
    supportScore: hasLineup && injuryCount < 4 ? 1 : 0
  };
}

function formFactor(prediction) {
  const form = fixtureDataOf(prediction).form;
  const home = form?.home;
  const away = form?.away;
  if (!home || !away) {
    return {
      name: "状态",
      level: "缺口",
      direction: "近期状态源未完全匹配",
      point: "使用赔率与基础概率替代，信心需打折",
      riskScore: 1,
      supportScore: 0
    };
  }
  const ppgDiff = Number(home.pointsPerMatch ?? 0) - Number(away.pointsPerMatch ?? 0);
  const goalDiff = Number(home.goalDiff ?? 0) - Number(away.goalDiff ?? 0);
  const supportsHome = ppgDiff > 0.25 || goalDiff > 2;
  const supportsAway = ppgDiff < -0.25 || goalDiff < -2;
  const pick = prediction.pick?.code;
  const aligned = (pick === "3" && supportsHome) || (pick === "0" && supportsAway) || (pick === "1" && Math.abs(ppgDiff) <= 0.25);
  return {
    name: "状态",
    level: aligned ? "支撑主判断" : "有分歧",
    direction: `主${round(home.pointsPerMatch)}分/场 vs 客${round(away.pointsPerMatch)}分/场`,
    point: `近况差${round(ppgDiff)}分/场，净胜球差${round(goalDiff)}`,
    riskScore: aligned ? 0 : 2,
    supportScore: aligned ? 2 : 0
  };
}

function oddsMovementFactor(prediction) {
  const movement = prediction.advancedFeatures?.market?.probabilityMovement;
  const asianMove = prediction.advancedFeatures?.market?.asianLineMovement;
  const shifts = movement?.shifts ?? [];
  const pickKey = outcomeKey(prediction.pick?.code);
  const pickShift = shifts.find((item) => item.key === pickKey)?.shift;
  const maxShift = movement?.maxAbsShift;
  const direction = Number.isFinite(pickShift)
    ? pickShift > 0.025 ? "资金/赔率支持首选" : pickShift < -0.025 ? "首选热度走弱" : "赔率变化平稳"
    : "缺少初赔对比";
  const lineText = Number.isFinite(asianMove) ? `亚盘变化${signed(asianMove)}` : "亚盘变化缺失";
  return {
    name: "赔率变化",
    level: Number.isFinite(maxShift) && maxShift >= 0.07 ? "大幅波动" : "常规",
    direction,
    point: `${direction}；${lineText}`,
    riskScore: direction === "首选热度走弱" || (Number.isFinite(maxShift) && maxShift >= 0.07) ? 2 : 0,
    supportScore: direction === "资金/赔率支持首选" ? 2 : 1
  };
}

function factorText(factor) {
  return `${factor.level}｜${factor.point}`;
}

function fixtureDataOf(prediction) {
  return prediction.advancedFeatures?.external?.fixtureData ?? {};
}

function probabilityGap(prediction) {
  const probabilities = [prediction.probabilities?.home, prediction.probabilities?.draw, prediction.probabilities?.away]
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  return probabilities.length >= 2 ? probabilities[0] - probabilities[1] : 0;
}

function totalExpectedGoals(prediction) {
  const lambdas = prediction.simulation?.lambdas;
  const total = Number(lambdas?.home ?? 0) + Number(lambdas?.away ?? 0);
  return Number.isFinite(total) && total > 0 ? total : Number.NaN;
}

function outcomeKey(code) {
  if (code === "3") return "home";
  if (code === "1") return "draw";
  if (code === "0") return "away";
  return "";
}

function outcomeLabel(code) {
  return OUTCOME_LABELS[code] ?? "";
}

function signed(value) {
  if (!Number.isFinite(Number(value))) return "";
  const rounded = round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : "";
}
