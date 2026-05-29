import { loadFixtures } from "./fixture-store.js";
import { findMarketSnapshot, loadMarketSnapshots } from "./market-data-store.js";
import { buildAdvancedFixtureFeatures } from "./advanced-football-features.js";
import { loadAdvancedData } from "./advanced-data-store.js";
import { buildMonteCarloSimulation } from "./monte-carlo-simulator.js";
import { buildBankrollRisk } from "./bankroll-risk.js";
import { calibrateProbabilities, loadCalibrationProfile } from "./model-calibration.js";
import { applyTemperature } from "./temperature-calibration.js";
import { fitFromFixtureStore, predictFromFitted, blendWithOdds } from "./dixon-coles-engine.js";
import { buildEnsemblePrediction } from "./ratings-ensemble.js";
import { bootstrapRatings } from "./ratings-bootstrap.js";
import { getSignalScale, loadSignalWeights } from "./signal-weight-tuner.js";
import { applyLayer2Signals } from "./feature-enhancers.js";
import { fuseSignals, loadFusionWeightProfile, SIGNAL_NAMES } from "./signal-fusion-layer.js";
import { loadHistoricalResults, buildFusionContext } from "./fusion-context-builder.js";
import { adjustParlayForCorrelation } from "./parlay-correlation-adjuster.js";
import { canonicalTeamName as canonicalTeamNameFromTable } from "./team-aliases.js";

const OUTCOMES = [
  { key: "home", code: "3", label: "主胜" },
  { key: "draw", code: "1", label: "平局" },
  { key: "away", code: "0", label: "客胜" }
];

const SCORE_POOLS = {
  "3": ["2-0", "2-1", "1-0"],
  "1": ["1-1", "0-0", "2-2"],
  "0": ["0-1", "1-2", "0-2"]
};

const HALF_FULL_POOLS = {
  "3": ["主胜-主胜", "平局-主胜", "客胜-主胜"],
  "1": ["平局-平局", "主胜-平局", "客胜-平局"],
  "0": ["客胜-客胜", "平局-客胜", "主胜-客胜"]
};

const FOURTEEN_DEFAULT_MAX_BANKERS = 4;
const FOURTEEN_DEFAULT_BANKER_MIN_GAP = 0.22;
const FOURTEEN_DEFAULT_BANKER_MIN_CONFIDENCE = 60;
const FOURTEEN_DEFAULT_DOUBLE_MIN_GAP = 0.08;

export function recommendFixtures(date) {
  const fixtureSet = loadFixtures(date);
  const marketSnapshots = loadMarketSnapshots(fixtureSet.date).snapshots;
  const advancedData = loadAdvancedData(fixtureSet.date);
  const calibrationProfile = loadCalibrationProfile();
  const dixonColesFitted = fitFromFixtureStore();
  // D 档接入(2026-05-28):一次性加载所有评级,传给 predictFixture 算 ensembleView.
  // 失败时(样本不足等)bootstrap.* 字段为 null,不影响主路径.
  let ratingsBootstrap = null;
  try {
    ratingsBootstrap = bootstrapRatings();
  } catch {
    // bootstrap 失败 → 跳过,主路径仍工作
  }
  // V 档:从历史赛果(严格早于当前比赛日,防泄漏)装配每场的 fusionContext,
  // 激活信号融合层里的 h2h / clean-sheet-streak / streak 信号(内部数据源,无需外部 API)。
  const history = loadHistoricalResults({ beforeDate: fixtureSet.date });
  const predictions = harmonizeDuplicatePredictions(fixtureSet.fixtures.map((fixture, index) => predictFixture(fixture, marketSnapshots, index, { advancedData, calibrationProfile, dixonColesFitted, ratingsBootstrap, fusionContext: buildFusionContext(fixture, history) })));
  return {
    date: fixtureSet.date,
    generatedAt: new Date().toISOString(),
    fixtures: predictions.length,
    predictions,
    ratingsBootstrap: ratingsBootstrap ? {
      samples: ratingsBootstrap.samples,
      methods: {
        pi: ratingsBootstrap.pi?.ok ?? false,
        massey: ratingsBootstrap.massey?.ok ?? false,
        colley: ratingsBootstrap.colley?.ok ?? false,
        bivariate: ratingsBootstrap.bivariate?.ok ?? false,
        hierarchical: ratingsBootstrap.hierarchical?.ok ?? false
      }
    } : null,
    fourteen: buildFourteenPlan(predictions)
  };
}

function harmonizeDuplicatePredictions(predictions) {
  const authoritative = new Map(
    predictions
      .filter((prediction) => prediction.fixture.marketType === "jingcai")
      .map((prediction) => [fixtureIdentityKey(prediction.fixture), prediction])
  );
  return predictions.map((prediction, index) => {
    if (prediction.fixture.marketType !== "shengfucai") return prediction;
    const source = authoritative.get(fixtureIdentityKey(prediction.fixture));
    if (!source) return prediction;
    const scorePicks = buildScorePicks(source.pick.code, source.secondaryPick.code, prediction.marketSnapshot, source.probabilities, index);
    const halfFullPicks = buildHalfFullPicks(source.pick.code, source.secondaryPick.code, prediction.marketSnapshot, source.probabilities, index, scorePicks);
    const next = {
      ...prediction,
      probabilities: { ...source.probabilities },
      probabilityAdjustment: {
        ...prediction.probabilityAdjustment,
        harmonizedWith: source.fixture.id
      },
      pick: { ...source.pick },
      secondaryPick: { ...source.secondaryPick },
      risk: source.risk,
      confidence: source.confidence,
      scorePicks,
      halfFullPicks,
      rationale: `${prediction.rationale}；同场次已与竞彩足球 ${source.fixture.sequence} 胜平负方向强制一致`
    };
    const consistencyErrors = validatePredictionConsistency(next);
    if (consistencyErrors.length) throw new Error(`同场次一致性修复失败：${prediction.fixture.homeTeam} 对 ${prediction.fixture.awayTeam}：${consistencyErrors.join("；")}`);
    return next;
  });
}

function fixtureIdentityKey(fixture) {
  return `${canonicalTeamName(fixture.homeTeam)}__${canonicalTeamName(fixture.awayTeam)}`;
}

function canonicalTeamName(value) {
  return canonicalTeamNameFromTable(value);
}

export function predictFixture(fixture, marketSnapshots = [], index = 0, options = {}) {
  const snapshot = findMarketSnapshot(fixture, marketSnapshots);
  const oddsProbabilities = snapshot?.europeanOdds?.current ? probabilitiesFromOdds(snapshot.europeanOdds.current) : null;
  const dcResult = options.dixonColesFitted ? predictFromFitted(options.dixonColesFitted, fixture) : null;
  const blendResult = oddsProbabilities
    ? blendWithOdds(oddsProbabilities, dcResult, { competition: fixture.competition, weightProfile: loadSignalWeights() })
    : dcResult
      ? { probabilities: dcResult.probabilities, blendSource: "dixon-coles-only", dcWeight: 1, dcResult }
      : { probabilities: seededProbabilities(fixture, index), blendSource: "seeded-fallback", dcWeight: 0, dcResult: null };
  const baseProbabilities = blendResult.probabilities;
  const probabilityAdjustment = adjustProbabilitiesWithAdvancedData(fixture, baseProbabilities, options.advancedData);
  // V 档:贝叶斯信号融合层 —— 把伤停/H2H/赛季阶段/赛事性质等信号以 LR 证据融进概率。
  // 缺数据的信号自动休眠(见 fusion.dormant),冷启动下只有元数据类信号会真 fire。
  // X 档(2026-05-29):把市场开盘→当前的盘口移动接进融合层。europeanOdds.initial=开盘、
  // current=当前(竞彩多次捕获赔率变化时更新)。line-movement 信号据此 fire。
  // ⚠️ 诚实标注:baseProbabilities 已用 current 赔率 blend,current 信息大部分已计入 prior;
  // 本信号是"近期盘口移动显著时、略偏向更 sharp 的当前价"的二阶修正(LR 夹 [0.5,2]、
  // 融合总位移每 outcome 封顶 ±12%,且其后 market-prior isotonic 校准会再纠一次),不重复放大。
  const fusionContext = {
    ...(options.fusionContext ?? {}),
    ...(oddsProbabilities && snapshot?.europeanOdds?.initial
      ? { openingOdds: probabilitiesFromOdds(snapshot.europeanOdds.initial), currentOdds: oddsProbabilities }
      : {})
  };
  // 回测学到的信号权重 profile(剔除/弱化害校准的融合信号);options 可覆盖。
  const weightProfile = loadFusionWeightProfile();
  // 头号杠杆 A(backtest:odds 实证):市场赔率隐含=54.8% 命中,blend=54.2%,但 blend+融合层
  // 反而掉到 52.9%。即「有市场 prior 时融合层是净负的」——市场价已含全部公开信息,
  // 模型的 LR 信号反而引入噪声/过度自信。故有 prior 时默认关闭融合(可用 profile.fuseWithMarketPrior=true
  // 或 options.fuseWithMarketPrior 覆盖)。无赔率场次保留融合(那里它相对纯 DC 是正的)。
  const hasMarketPrior = Boolean(oddsProbabilities);
  const fuseWithMarketPrior = options.fuseWithMarketPrior ?? weightProfile?.fuseWithMarketPrior ?? false;
  const gateFusionOff = hasMarketPrior && !fuseWithMarketPrior;
  const fusionOpts = options.fusionOpts ?? (gateFusionOff
    ? { disabledSignals: SIGNAL_NAMES }
    : weightProfile
      ? { signalWeights: weightProfile.signalWeights, disabledSignals: weightProfile.disabledSignals }
      : {});
  const fusion = fuseSignals(probabilityAdjustment.probabilities, fixture, options.advancedData, fusionContext, fusionOpts);
  probabilityAdjustment.fusionGatedOff = gateFusionOff;
  probabilityAdjustment.fusion = fusion;
  // 温度校准(回测拟合,治过度自信):单调软化,不改 argmax/命中,只把虚高的强热门拉回。
  // 放在 cold-start favorite 收缩之前,软化后多数 favorite 已 <0.65,二者互补不重复收缩。
  let fusedProbs = fusion.probabilities;
  const fusionTemperature = weightProfile?.temperature;
  if (Number.isFinite(fusionTemperature) && fusionTemperature > 0 && fusionTemperature !== 1) {
    fusedProbs = applyTemperature(fusedProbs, fusionTemperature);
    probabilityAdjustment.temperature = fusionTemperature;
  }
  // hasMarketPrior:prior 已含市场赔率时(已被市场校准),跳过 cold-start favorite 收缩,避免过度收缩。
  const calibrated = calibrateProbabilities(fusedProbs, options.calibrationProfile, { fixture, snapshot, hasMarketPrior: Boolean(oddsProbabilities) });
  const probabilities = calibrated.probabilities;
  probabilityAdjustment.calibration = calibrated.calibration;
  const fixtureAdvancedData = advancedFixtureData(options.advancedData, fixture);
  const ranked = OUTCOMES.map((outcome) => ({ ...outcome, probability: probabilities[outcome.key] })).sort((a, b) => b.probability - a.probability);
  const gap = ranked[0].probability - ranked[1].probability;
  const advancedFeatures = buildAdvancedFixtureFeatures(fixture, snapshot, probabilities, options);
  const simulation = buildMonteCarloSimulation(fixture, probabilities, { xg: fixtureAdvancedData.xg, iterations: options.simulationIterations });
  const risk = riskWithAdvancedSignals(gap, advancedFeatures);
  const confidence = confidenceWithAdvancedSignals(ranked[0].probability, gap, advancedFeatures);
  const scorePicks = buildScorePicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, blendResult.dcResult);
  const halfFullPicks = buildHalfFullPicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, scorePicks, blendResult.dcResult);
  const expectedValue = computeExpectedValueLabels(ranked, snapshot);
  // D 档接入(2026-05-28):用 bootstrap 传入的多评级算 ensembleView 作为 supplementary.
  // 不替换 main 路径 — 主推荐仍走 calibrated probabilities;ensembleView 用于 backtest 对比和未来切主.
  const ensembleView = options.ratingsBootstrap
    ? buildEnsembleViewFromBootstrap(fixture, options.ratingsBootstrap, oddsProbabilities, blendResult.dcResult)
    : null;
  const prediction = {
    fixture,
    baseProbabilities,
    probabilities,
    probabilityAdjustment,
    dixonColes: blendResult.dcResult ? {
      source: blendResult.blendSource,
      independentProbs: blendResult.dcResult?.probabilities,
      expectedGoals: blendResult.dcResult?.expectedGoals,
      teamStrength: blendResult.dcResult?.teamStrength,
    } : null,
    ensembleView,
    simulation,
    marketSnapshot: snapshot,
    advancedFeatures,
    bankroll: null,
    pick: ranked[0],
    secondaryPick: ranked[1],
    risk,
    confidence,
    scorePicks,
    halfFullPicks,
    expectedValue,
    rationale: buildReason(fixture, snapshot, ranked[0], ranked[1], risk)
  };
  prediction.bankroll = buildBankrollRisk(prediction, options.env ?? process.env);
  const consistencyErrors = validatePredictionConsistency(prediction);
  if (consistencyErrors.length) throw new Error(`推荐派生市场冲突：${fixture.homeTeam} 对 ${fixture.awayTeam}；${consistencyErrors.join("；")}`);
  return prediction;
}

function advancedFixtureData(advancedData, fixture) {
  return advancedData?.fixtures?.find((row) => row.fixtureId === fixture.id)?.data ?? {};
}

export function outcomeCodeToChinese(code) {
  return code === "3" ? "主胜" : code === "1" ? "平局" : code === "0" ? "客胜" : "";
}

export function scoreOutcomeCode(score) {
  const match = String(score ?? "").trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!match) return "";
  const home = Number(match[1]);
  const away = Number(match[2]);
  if (home > away) return "3";
  if (home === away) return "1";
  return "0";
}

export function halfFullFinalOutcomeCode(value) {
  const finalLabel = normalizeHalfFull(value).split("-").at(-1)?.trim();
  return chineseOutcomeToCode(finalLabel);
}

export function halfFullFirstOutcomeCode(value) {
  const firstLabel = normalizeHalfFull(value).split("-").at(0)?.trim();
  return chineseOutcomeToCode(firstLabel);
}

export function scoreHalfFullConsistent(score, halfFull) {
  const scoreCode = scoreOutcomeCode(score);
  const finalCode = halfFullFinalOutcomeCode(halfFull);
  const firstCode = halfFullFirstOutcomeCode(halfFull);
  if (!scoreCode || !finalCode || !firstCode || scoreCode !== finalCode) return false;
  return possibleHalfOutcomeCodes(score).has(firstCode);
}

export function validatePredictionConsistency(prediction) {
  const checks = [
    ["比分首选", prediction.scorePicks?.primary, prediction.pick?.code, scoreOutcomeCode],
    ["比分次选", prediction.scorePicks?.secondary, prediction.secondaryPick?.code, scoreOutcomeCode],
    ["半全场首选", prediction.halfFullPicks?.primary, prediction.pick?.code, halfFullFinalOutcomeCode],
    ["半全场次选", prediction.halfFullPicks?.secondary, prediction.secondaryPick?.code, halfFullFinalOutcomeCode]
  ];
  const errors = checks.flatMap(([label, value, expectedCode, parser]) => {
    const actualCode = parser(value);
    if (!expectedCode || actualCode === expectedCode) return [];
    return `${label} ${value || "缺失"} 与 ${outcomeCodeToChinese(expectedCode)} 不一致`;
  });
  const pathChecks = [
    ["比分/半全场首选", prediction.scorePicks?.primary, prediction.halfFullPicks?.primary],
    ["比分/半全场次选", prediction.scorePicks?.secondary, prediction.halfFullPicks?.secondary]
  ];
  for (const [label, score, halfFull] of pathChecks) {
    if (score && halfFull && !scoreHalfFullConsistent(score, halfFull)) errors.push(`${label} ${score} 与 ${halfFull} 路径冲突`);
  }
  return errors;
}

function probabilitiesFromOdds(odds) {
  const raw = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const total = raw.home + raw.draw + raw.away;
  return { home: round(raw.home / total), draw: round(raw.draw / total), away: round(raw.away / total) };
}

// D 档接入:把每个评级模型的预测打包成 ensembleView,backtest 时算其 RPS 跟主路径对比.
// 任何评级缺数据/失败 → 该方法 null,buildEnsemblePrediction 自动跳过.
export function buildEnsembleViewFromBootstrap(fixture, bootstrap, oddsProbabilities, dcResult) {
  if (!bootstrap) return null;
  const preds = {};
  // odds 隐含(无 stacker 时仍可作一票)
  if (oddsProbabilities) preds.odds = oddsProbabilities;
  // Dixon-Coles
  if (dcResult?.probabilities) preds.dixonColes = dcResult.probabilities;
  // Pi-ratings
  if (bootstrap.pi?.ok && typeof bootstrap.pi.predictWinProb === "function") {
    try {
      const p = bootstrap.pi.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.pi = { home: p.home, draw: p.draw, away: p.away };
    } catch { /* graceful skip */ }
  }
  // Massey
  if (bootstrap.massey?.ok && typeof bootstrap.massey.predictWinProb === "function") {
    try {
      const p = bootstrap.massey.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.massey = { home: p.home, draw: p.draw, away: p.away };
    } catch { /* */ }
  }
  // Colley
  if (bootstrap.colley?.ok && typeof bootstrap.colley.predictWinProb === "function") {
    try {
      const p = bootstrap.colley.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.colley = { home: p.home, draw: p.draw, away: p.away };
    } catch { /* */ }
  }
  // Bivariate Poisson
  if (bootstrap.bivariate?.ok && typeof bootstrap.bivariate.predict === "function") {
    try {
      const p = bootstrap.bivariate.predict(fixture.homeTeam, fixture.awayTeam);
      if (p?.probabilities) preds.bivariatePoisson = p.probabilities;
    } catch { /* */ }
  }
  const result = buildEnsemblePrediction(preds);
  if (!result.ok) return null;
  return {
    probabilities: result.probabilities,
    source: result.source,
    methodCount: Object.keys(result.contributions).length,
    contributions: result.contributions
  };
}

// Expected Value 计算:
//   EV = p × (odds - 1) - (1 - p) × 1
//      = p × odds - 1
// p 是模型给的真实概率,odds 是 sporttery 当前赔率(SP)。
// EV > 0:value bet,长期正期望
// EV > 0.05:强 value bet(给 5% 安全垫,避免估计误差)
// EV < 0:不该投,即便概率最高(赔率太低 = 价值不足)
//
// 这条算法是 EV 思维的核心 ── 持续正 EV 是长期盈利的唯一数学路径,
// 而不是追求"看上去概率高"的票。配合 1/4 凯利仓位(已在 bankroll-risk.js),
// 形成完整的 valuation + sizing 闭环。
export function computeExpectedValueLabels(rankedOutcomes, snapshot) {
  const oddsCurrent = snapshot?.europeanOdds?.current;
  if (!oddsCurrent || !rankedOutcomes?.length) return null;
  const oddsByCode = {
    "3": Number(oddsCurrent.home),
    "1": Number(oddsCurrent.draw),
    "0": Number(oddsCurrent.away)
  };
  const labels = rankedOutcomes.map((outcome) => {
    const odds = oddsByCode[outcome.code];
    if (!Number.isFinite(odds) || odds <= 1) {
      return { code: outcome.code, label: outcome.label, ev: null, odds: null, valueBet: false };
    }
    const ev = outcome.probability * odds - 1;
    return {
      code: outcome.code,
      label: outcome.label,
      odds: round(odds),
      ev: round(ev),
      valueBet: ev > 0.05,
      verdict: ev > 0.15 ? "strong-value" : ev > 0.05 ? "value" : ev > -0.05 ? "fair" : "negative-ev"
    };
  });
  return {
    primary: labels[0] ?? null,
    secondary: labels[1] ?? null,
    all: labels
  };
}

function adjustProbabilitiesWithAdvancedData(fixture, baseProbabilities, advancedData) {
  const fixtureData = advancedData?.fixtures?.find((row) => row.fixtureId === fixture.id)?.data ?? {};
  const signals = [];
  let weights = { ...baseProbabilities };
  const elo = eloSignal(fixtureData.elo);
  if (elo) {
    weights.home *= Math.exp(elo.score);
    weights.away *= Math.exp(-elo.score);
    weights.draw *= Math.exp(-Math.abs(elo.score) * 0.25);
    signals.push(elo);
  }
  const form = formSignal(fixtureData.form);
  if (form) {
    weights.home *= Math.exp(form.score);
    weights.away *= Math.exp(-form.score);
    weights.draw *= Math.exp(-Math.abs(form.score) * 0.3);
    signals.push(form);
  }
  const weather = weatherSignal(fixtureData.weather);
  if (weather) {
    weights.home *= weather.homeMultiplier;
    weights.draw *= weather.drawMultiplier;
    weights.away *= weather.awayMultiplier;
    signals.push(weather);
  }
  const layer2 = applyLayer2Signals(weights, fixtureData, getSignalScale);
  weights = layer2.weights;
  signals.push(...layer2.signals);
  if (!signals.length) return { applied: false, probabilities: baseProbabilities, signals: [] };
  const adjusted = capProbabilityShift(baseProbabilities, normalizeProbabilities(weights), 0.1);
  return {
    applied: true,
    probabilities: adjusted,
    signals,
    maxShift: round(Math.max(...["home", "draw", "away"].map((key) => Math.abs(adjusted[key] - baseProbabilities[key]))))
  };
}

function eloSignal(elo) {
  const home = Number(elo?.home?.Elo);
  const away = Number(elo?.away?.Elo);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const diff = clamp(home - away, -450, 450);
  return {
    key: "elo",
    home,
    away,
    diff: round(diff),
    score: round((diff / 400) * 0.18 * getSignalScale("elo"))
  };
}

function formSignal(form) {
  const home = form?.home;
  const away = form?.away;
  if ((home?.matches ?? 0) < 4 || (away?.matches ?? 0) < 4) return null;
  const ppgDiff = clamp((home.pointsPerMatch ?? 0) - (away.pointsPerMatch ?? 0), -2, 2);
  const goalDiffPerMatch = clamp((home.goalDiff / home.matches) - (away.goalDiff / away.matches), -3, 3);
  const shotQualityDiff = shotQualitySignal(home, away);
  return {
    key: "form",
    homePointsPerMatch: round(home.pointsPerMatch),
    awayPointsPerMatch: round(away.pointsPerMatch),
    ppgDiff: round(ppgDiff),
    goalDiffPerMatch: round(goalDiffPerMatch),
    shotQualityDiff: shotQualityDiff === null ? null : round(shotQualityDiff),
    score: round((ppgDiff * 0.08 + goalDiffPerMatch * 0.025 + (shotQualityDiff ?? 0) * 0.015) * getSignalScale("form"))
  };
}

function shotQualitySignal(home, away) {
  const homeShotEdge = shotEdge(home);
  const awayShotEdge = shotEdge(away);
  if (!Number.isFinite(homeShotEdge) || !Number.isFinite(awayShotEdge)) return null;
  return clamp(homeShotEdge - awayShotEdge, -2, 2);
}

function shotEdge(row) {
  const attack = Number(row.shotsOnTargetForPerMatch ?? row.shotsForPerMatch);
  const defense = Number(row.shotsOnTargetAgainstPerMatch ?? row.shotsAgainstPerMatch);
  if (!Number.isFinite(attack) || !Number.isFinite(defense)) return Number.NaN;
  return attack - defense;
}

function weatherSignal(weather) {
  const precipitation = Number(weather?.hourly?.precipitation?.avg);
  const wind = Number(weather?.hourly?.windSpeed10m?.avg);
  if (!Number.isFinite(precipitation) && !Number.isFinite(wind)) return null;
  const badWeather = (Number.isFinite(precipitation) && precipitation >= 0.8) || (Number.isFinite(wind) && wind >= 22);
  if (!badWeather) return null;
  return {
    key: "weather",
    precipitation: Number.isFinite(precipitation) ? round(precipitation) : null,
    windSpeed10m: Number.isFinite(wind) ? round(wind) : null,
    homeMultiplier: 1 - 0.02 * getSignalScale("weather"),
    drawMultiplier: 1 + 0.04 * getSignalScale("weather"),
    awayMultiplier: 1 - 0.02 * getSignalScale("weather")
  };
}

function normalizeProbabilities(values) {
  const total = (values.home ?? 0) + (values.draw ?? 0) + (values.away ?? 0);
  if (!Number.isFinite(total) || total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: values.home / total, draw: values.draw / total, away: values.away / total };
}

function capProbabilityShift(base, adjusted, maxShift) {
  const maxActualShift = Math.max(...["home", "draw", "away"].map((key) => Math.abs(adjusted[key] - base[key])));
  if (maxActualShift <= maxShift) return roundedProbabilitySet(adjusted);
  const scale = maxShift / maxActualShift;
  return roundedProbabilitySet(Object.fromEntries(["home", "draw", "away"].map((key) => [key, base[key] + (adjusted[key] - base[key]) * scale])));
}

function roundedProbabilitySet(values) {
  const home = round(values.home);
  const draw = round(values.draw);
  return { home, draw, away: round(1 - home - draw) };
}

function seededProbabilities(fixture, index) {
  const seed = hash(`${fixture.homeTeam}-${fixture.awayTeam}-${index}`);
  const home = 0.35 + (seed % 21) / 100;
  const draw = 0.24 + ((seed >> 3) % 10) / 100;
  const away = Math.max(0.12, 1 - home - draw);
  const total = home + draw + away;
  return { home: round(home / total), draw: round(draw / total), away: round(away / total) };
}

// 比分预测优先级:
//   1. snapshot.scoreOdds.top  ── sporttery 官方比分赔率(市场共识,准确度最高)
//   2. dcResult.topScores      ── Dixon-Coles 泊松矩阵 (用历史进球独立估计的概率)
//   3. scoreForOutcome         ── if-else 硬编码 fallback(coldStart 或 DC 不可用时)
//
// 之前(2026-05-28 之前)只走 1 和 3,DC 拿到的 topScores 完全闲置 — 这就是"敷衍"的根本原因。
function buildScorePicks(code, secondaryCode, snapshot = null, probabilities = {}, index = 0, dcResult = null) {
  const fromMarket = scoreFromMarket(snapshot, code);
  const fromMarketSecondary = scoreFromMarket(snapshot, secondaryCode, new Set(fromMarket ? [fromMarket] : []));
  const fromDc = fromMarket ? null : scoreFromDcResult(dcResult, code);
  const exclusionForSecondary = new Set([fromMarket, fromDc].filter(Boolean));
  const fromDcSecondary = fromMarketSecondary ? null : scoreFromDcResult(dcResult, secondaryCode, exclusionForSecondary);
  return {
    primary: fromMarket ?? fromDc ?? scoreForOutcome(code, 0, probabilities, index),
    secondary: fromMarketSecondary ?? fromDcSecondary ?? scoreForOutcome(secondaryCode, secondaryCode === code ? 1 : 0, probabilities, index + 1)
  };
}

// 半全场预测优先级同上:市场 → DC 泊松半场分布 → 硬编码 fallback
function buildHalfFullPicks(code, secondaryCode, snapshot = null, probabilities = {}, index = 0, scorePicks = {}, dcResult = null) {
  const primaryScore = scorePicks.primary ?? scoreForOutcome(code, 0, probabilities, index);
  const secondaryScore = scorePicks.secondary ?? scoreForOutcome(secondaryCode, secondaryCode === code ? 1 : 0, probabilities, index + 1);
  const primaryFromMarket = halfFullFromMarket(snapshot, code, new Set(), primaryScore);
  const primaryFromDc = primaryFromMarket ? null : halfFullFromDcResult(dcResult, code, new Set(), primaryScore);
  const exclusion = new Set([primaryFromMarket, primaryFromDc].filter(Boolean));
  const secondaryFromMarket = halfFullFromMarket(snapshot, secondaryCode, exclusion, secondaryScore);
  const secondaryFromDc = secondaryFromMarket ? null : halfFullFromDcResult(dcResult, secondaryCode, exclusion, secondaryScore);
  return {
    primary: primaryFromMarket ?? primaryFromDc ?? halfFullForScore(primaryScore, code, 0, probabilities, index),
    secondary: secondaryFromMarket ?? secondaryFromDc ?? halfFullForScore(secondaryScore, secondaryCode, secondaryCode === code ? 1 : 0, probabilities, index + 1)
  };
}

// 从 Dixon-Coles 的 topScores(已经按概率从高到低排好)挑符合指定 outcome 的最高概率比分。
// dcResult.topScores 形如 [{ score: "2-1", probability: 0.087 }, ...]
export function scoreFromDcResult(dcResult, code, excluded = new Set()) {
  if (!dcResult?.topScores?.length) return null;
  for (const entry of dcResult.topScores) {
    const score = String(entry.score ?? "").trim();
    if (!score) continue;
    if (scoreOutcomeCode(score) !== code) continue;
    if (excluded.has(score)) continue;
    return score;
  }
  return null;
}

// 半全场分布:DC 引擎给了全场 expectedGoals { home: λ, away: μ }。
// 我们假设上半场进球率 ≈ 全场的 halfRatio(默认 0.46,这是英超/五大联赛大量历史数据
// 上半场进球占比的稳定经验值)。下半场进球率 = 全场 - 上半场。
// 半场和下半场进球独立(简化假设,实际有微弱负相关但量级小可忽略)。
// 联合分布 -> 6 outcome 概率聚合,挑符合 final outcome 的最高 outcome,
// 并保证跟 score 路径一致(scoreHalfFullConsistent)。
export function halfFullFromDcResult(dcResult, code, excluded = new Set(), score = "") {
  if (!dcResult?.expectedGoals) return null;
  const halfRatio = Number(process.env.DC_HALF_RATIO ?? 0.46);
  const probs = halfFullProbsFromLambdas(dcResult.expectedGoals.home, dcResult.expectedGoals.away, halfRatio);
  const candidates = Object.entries(probs)
    .filter(([halfFull]) => halfFullFinalOutcomeCode(halfFull) === code)
    .filter(([halfFull]) => !excluded.has(halfFull))
    .filter(([halfFull]) => !score || scoreHalfFullConsistent(score, halfFull))
    .sort((a, b) => b[1] - a[1]);
  return candidates[0]?.[0] ?? null;
}

// 输入全场 λ_home / μ_away,输出 9 个 outcome("主胜-主胜" 等)的概率字典。
// 注意:有 3 个 outcome 在半全场玩法里不参与("主胜-客胜" 等),仍计算以方便测试。
export function halfFullProbsFromLambdas(lambdaHome, muAway, halfRatio = 0.46, maxGoals = 5) {
  const lambdaH1 = lambdaHome * halfRatio;
  const muA1 = muAway * halfRatio;
  const lambdaH2 = lambdaHome - lambdaH1;
  const muA2 = muAway - muA1;
  const distH1 = poissonDist(lambdaH1, maxGoals);
  const distA1 = poissonDist(muA1, maxGoals);
  const distH2 = poissonDist(lambdaH2, maxGoals);
  const distA2 = poissonDist(muA2, maxGoals);
  const probs = {
    "主胜-主胜": 0, "主胜-平局": 0, "主胜-客胜": 0,
    "平局-主胜": 0, "平局-平局": 0, "平局-客胜": 0,
    "客胜-主胜": 0, "客胜-平局": 0, "客胜-客胜": 0
  };
  for (let h1 = 0; h1 <= maxGoals; h1++) {
    for (let a1 = 0; a1 <= maxGoals; a1++) {
      const p1 = distH1[h1] * distA1[a1];
      const halfLabel = h1 > a1 ? "主胜" : h1 === a1 ? "平局" : "客胜";
      for (let h2 = 0; h2 <= maxGoals; h2++) {
        for (let a2 = 0; a2 <= maxGoals; a2++) {
          const p2 = distH2[h2] * distA2[a2];
          const fullH = h1 + h2;
          const fullA = a1 + a2;
          const fullLabel = fullH > fullA ? "主胜" : fullH === fullA ? "平局" : "客胜";
          probs[`${halfLabel}-${fullLabel}`] += p1 * p2;
        }
      }
    }
  }
  return probs;
}

function poissonDist(lambda, maxGoals) {
  const out = new Array(maxGoals + 1).fill(0);
  if (!Number.isFinite(lambda) || lambda <= 0) {
    out[0] = 1;
    return out;
  }
  let sum = 0;
  for (let k = 0; k <= maxGoals; k++) {
    out[k] = Math.exp(k * Math.log(lambda) - lambda - logFact(k));
    sum += out[k];
  }
  // 归一化:截尾(maxGoals 以上)概率重新分到 0..maxGoals,保证总和=1
  if (sum > 0) for (let k = 0; k <= maxGoals; k++) out[k] /= sum;
  return out;
}

function logFact(n) {
  let v = 0;
  for (let i = 2; i <= n; i++) v += Math.log(i);
  return v;
}

function scoreFromMarket(snapshot, code, excluded = new Set()) {
  const rows = snapshot?.scoreOdds?.top ?? [];
  return rows
    .map((row) => String(row.score ?? "").replace(":", "-").trim())
    .filter((score) => scoreOutcomeCode(score) === code && !excluded.has(score))
    .at(0);
}

function halfFullFromMarket(snapshot, code, excluded = new Set(), score = "") {
  const rows = snapshot?.halfFullOdds?.top ?? [];
  return rows
    .map((row) => normalizeHalfFull(row.halfFull))
    .filter((halfFull) => halfFullFinalOutcomeCode(halfFull) === code && !excluded.has(halfFull))
    .filter((halfFull) => !score || scoreHalfFullConsistent(score, halfFull))
    .at(0);
}

function possibleHalfOutcomeCodes(score) {
  const match = String(score ?? "").trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  if (!match) return new Set();
  const homeGoals = Number(match[1]);
  const awayGoals = Number(match[2]);
  const codes = new Set();
  for (let homeHalf = 0; homeHalf <= homeGoals; homeHalf += 1) {
    for (let awayHalf = 0; awayHalf <= awayGoals; awayHalf += 1) {
      if (homeHalf > awayHalf) codes.add("3");
      else if (homeHalf === awayHalf) codes.add("1");
      else codes.add("0");
    }
  }
  return codes;
}

function halfFullForScore(score, code, variant = 0, probabilities = {}, index = 0) {
  const possible = [...possibleHalfOutcomeCodes(score)];
  const finalCode = scoreOutcomeCode(score) || code;
  const preferred = preferredHalfOutcomeCodes(finalCode, variant, probabilities, index);
  const firstCode = preferred.find((candidate) => possible.includes(candidate)) ?? possible.at(0) ?? finalCode;
  return `${outcomeCodeToChinese(firstCode)}-${outcomeCodeToChinese(finalCode)}`;
}

function preferredHalfOutcomeCodes(finalCode, variant = 0, probabilities = {}, index = 0) {
  const variantIndex = Math.abs(index + variant) % 3;
  if (finalCode === "3") {
    if ((probabilities.home ?? 0) >= 0.58) return ["3", "1", "0"];
    return variantIndex === 0 ? ["1", "3", "0"] : ["3", "1", "0"];
  }
  if (finalCode === "0") {
    if ((probabilities.away ?? 0) >= 0.58) return ["0", "1", "3"];
    return variantIndex === 0 ? ["1", "0", "3"] : ["0", "1", "3"];
  }
  if (variantIndex === 1 && (probabilities.home ?? 0) > (probabilities.away ?? 0)) return ["3", "1", "0"];
  if (variantIndex === 2 && (probabilities.away ?? 0) > (probabilities.home ?? 0)) return ["0", "1", "3"];
  return ["1", "3", "0"];
}

function scoreForOutcome(code, variant = 0, probabilities = {}, index = 0) {
  const favoriteStrength = Math.max(probabilities.home ?? 0, probabilities.draw ?? 0, probabilities.away ?? 0);
  const variantIndex = Math.abs(index + variant) % 3;
  if (code === "3") {
    if (favoriteStrength >= 0.72) return variantIndex === 1 ? "3-0" : "2-0";
    if (favoriteStrength >= 0.58) return variantIndex === 2 ? "3-1" : "2-0";
    return variantIndex === 0 ? "1-0" : "2-1";
  }
  if (code === "0") {
    if (favoriteStrength >= 0.72) return variantIndex === 1 ? "0-3" : "0-2";
    if (favoriteStrength >= 0.58) return variantIndex === 2 ? "1-3" : "0-2";
    return variantIndex === 0 ? "0-1" : "1-2";
  }
  if ((probabilities.home ?? 0) + (probabilities.away ?? 0) > 0.72) return variantIndex === 1 ? "2-2" : "1-1";
  return variantIndex === 2 ? "0-0" : "1-1";
}

function halfFullForOutcome(code, variant = 0, probabilities = {}, index = 0) {
  const favoriteStrength = Math.max(probabilities.home ?? 0, probabilities.draw ?? 0, probabilities.away ?? 0);
  const variantIndex = Math.abs(index + variant) % 3;
  if (code === "3") return favoriteStrength >= 0.62 ? "主胜-主胜" : (variantIndex === 0 ? "平局-主胜" : "客胜-主胜");
  if (code === "0") return favoriteStrength >= 0.62 ? "客胜-客胜" : (variantIndex === 0 ? "平局-客胜" : "主胜-客胜");
  if (variantIndex === 1 && (probabilities.home ?? 0) > (probabilities.away ?? 0)) return "主胜-平局";
  if (variantIndex === 2 && (probabilities.away ?? 0) > (probabilities.home ?? 0)) return "客胜-平局";
  return "平局-平局";
}

function chineseOutcomeToCode(value) {
  const normalized = String(value ?? "").trim();
  if (["主胜", "胜"].includes(normalized)) return "3";
  if (["平局", "平"].includes(normalized)) return "1";
  if (["客胜", "负"].includes(normalized)) return "0";
  if (["主胜", "胜", "3"].includes(value)) return "3";
  if (["平局", "平", "1"].includes(value)) return "1";
  if (["客胜", "负", "0"].includes(value)) return "0";
  return "";
}

function normalizeHalfFull(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("-")) {
    return raw.split("-").map((part) => outcomeCodeToChinese(chineseOutcomeToCode(part.trim())) || part.trim()).join("-");
  }
  const compact = raw.replace(/\s+/g, "");
  if (compact.length === 2) {
    const first = outcomeCodeToChinese(chineseOutcomeToCode(compact[0]));
    const second = outcomeCodeToChinese(chineseOutcomeToCode(compact[1]));
    if (first && second) return `${first}-${second}`;
  }
  return raw;
}

export function buildFourteenPlan(predictions) {
  const selected = predictions.filter((prediction) => prediction.fixture.marketType === "shengfucai" || prediction.fixture.tags.includes("14场胜负彩")).slice(0, 14);
  const source = selected.length ? selected : predictions.slice(0, 14);
  const rules = fourteenSelectionRules();
  // 冷启动模式:当所有 prediction 都没有真实高级数据(quality.score 一律 D 级 ≤ 62),
  // 严格 quality 门槛会过滤所有场次到 0 胆。这时改用更严格的概率/置信筛选,
  // 让模型仍能基于赔率给出胆材,同时维持"不容易给胆"的保守特性。
  const coldStartAll = source.every((p) => (p.advancedFeatures?.quality?.score ?? 0) < 62);
  const bankerIndexes = new Set(
    source
      .map((prediction, index) => ({ index, prediction, gap: prediction.pick.probability - prediction.secondaryPick.probability }))
      .filter((item) => item.gap >= rules.bankerMinGap && item.prediction.confidence >= rules.bankerMinConfidence)
      .filter((item) => {
        if (item.prediction.risk === "高") return false;
        const qualityOk = (item.prediction.advancedFeatures?.quality?.score ?? 0) >= 62;
        if (qualityOk) return true;
        // 冷启动放宽:gap ≥ 0.35 且置信 ≥ 65 也允许进强胆池,但单独打 cold-start 标签
        if (coldStartAll && item.gap >= 0.35 && item.prediction.confidence >= 65) return true;
        return false;
      })
      .sort((a, b) => b.gap - a.gap || b.prediction.confidence - a.prediction.confidence)
      .slice(0, rules.maxBankers)
      .map((item) => item.index)
  );
  const selections = source.map((prediction, index) => {
    const gap = prediction.pick.probability - prediction.secondaryPick.probability;
    const isBanker = bankerIndexes.has(index);
    const codes = isBanker ? [prediction.pick.code] : gap >= rules.doubleMinGap ? [prediction.pick.code, prediction.secondaryPick.code] : ["3", "1", "0"];
    return {
      index: index + 1,
      match: `${prediction.fixture.homeTeam} 对 ${prediction.fixture.awayTeam}`,
      single: outcomeCodeToChinese(prediction.pick.code),
      compound: codes.map(outcomeCodeToChinese).join("/"),
      type: codes.length === 1 ? "胆" : codes.length === 2 ? "双选" : "全选",
      risk: prediction.risk,
      confidence: prediction.confidence,
      reason: `概率差 ${Math.round(gap * 100)}%；14场严格定胆规则：${isBanker ? "进入强胆池" : "未入强胆池，降为覆盖"}；${prediction.rationale}`
    };
  });
  // 胆腿串关相关性修正(接孤儿模块 parlay-correlation-adjuster):
  // 14 场胆是同一天、常同联赛的多腿串关,独立连乘 ∏p_i 会系统性误估真实联合命中率。
  // 这里给出"独立估计"与"相关性修正估计"两个诚实数字,供报告/风控参考(不改变选胆)。
  const bankerLegs = source
    .map((prediction, index) => ({ prediction, index }))
    .filter(({ index }) => bankerIndexes.has(index))
    .map(({ prediction }) => ({
      fixtureId: prediction.fixture.id,
      league: prediction.fixture.competition,
      kickoffDate: prediction.fixture.date,
      outcome: prediction.pick.code,
      probability: prediction.pick.probability,
      homeTeam: prediction.fixture.homeTeam,
      awayTeam: prediction.fixture.awayTeam
    }));
  const bankerParlay = adjustParlayForCorrelation(bankerLegs);

  // 任选9:从 14 场里任选 9 场、全对即中(比 14 场全中容易得多)。
  // 推荐 = 取最稳的 9 场(按 置信度→概率差 排序)的单选,给联合命中率(独立+相关性修正)。
  const renxuan9 = buildRenxuan9(source);

  return {
    count: selections.length,
    singleLine: selections.map((item) => item.single).join(" "),
    compoundLine: selections.map((item) => item.compound).join(" "),
    selections,
    bankerParlay,
    renxuan9
  };
}

/**
 * 任选9 选场:从给定预测里挑置信度最高的 9 场单选,算 9 串联合命中率。
 * 不足 9 场返回 ok:false(诚实,不硬凑)。
 */
export function buildRenxuan9(source) {
  if (!Array.isArray(source) || source.length < 9) {
    return { ok: false, reason: `可选场次不足 9(${source?.length ?? 0})`, picks: [] };
  }
  const ranked = source
    .map((prediction, index) => ({
      index,
      prediction,
      gap: prediction.pick.probability - prediction.secondaryPick.probability
    }))
    .sort((a, b) => b.prediction.confidence - a.prediction.confidence || b.gap - a.gap)
    .slice(0, 9);
  const picks = ranked.map(({ prediction, gap }, i) => ({
    rank: i + 1,
    match: `${prediction.fixture.homeTeam} 对 ${prediction.fixture.awayTeam}`,
    pick: outcomeCodeToChinese(prediction.pick.code),
    code: prediction.pick.code,
    probability: prediction.pick.probability,
    confidence: prediction.confidence,
    risk: prediction.risk,
    gap: Math.round(gap * 100) / 100
  }));
  const legs = ranked.map(({ prediction }) => ({
    fixtureId: prediction.fixture.id,
    league: prediction.fixture.competition,
    kickoffDate: prediction.fixture.date,
    outcome: prediction.pick.code,
    probability: prediction.pick.probability,
    homeTeam: prediction.fixture.homeTeam,
    awayTeam: prediction.fixture.awayTeam
  }));
  const parlay = adjustParlayForCorrelation(legs);
  const singleLine = picks.map((p) => p.pick).join(" ");
  return {
    ok: true,
    needCorrect: 9,
    picks,
    singleLine,
    parlay,
    note: "从 14 场挑置信最高的 9 场单选;9 场全对即中任选9。联合命中率见 parlay(相关性修正后更诚实)。"
  };
}

export function fourteenSelectionRules(env = process.env) {
  return {
    maxBankers: wholeNumber(env.FOURTEEN_MAX_BANKERS, FOURTEEN_DEFAULT_MAX_BANKERS),
    bankerMinGap: finiteNumber(env.FOURTEEN_BANKER_MIN_GAP, FOURTEEN_DEFAULT_BANKER_MIN_GAP),
    bankerMinConfidence: finiteNumber(env.FOURTEEN_BANKER_MIN_CONFIDENCE, FOURTEEN_DEFAULT_BANKER_MIN_CONFIDENCE),
    doubleMinGap: finiteNumber(env.FOURTEEN_DOUBLE_MIN_GAP, FOURTEEN_DEFAULT_DOUBLE_MIN_GAP)
  };
}

function wholeNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildReason(fixture, snapshot, primary, secondary, risk) {
  const oddsText = snapshot ? "已接入本次实时赔率快照，并完成隐含概率换算与高级数据修正" : "缺少完整实时赔率，仅允许降级/演示模式，不允许作为严格正式推荐";
  return `经模型综合分析：${fixture.competition}，${primary.label}概率领先${secondary.label}；风险${risk}；${oddsText}`;
}

function riskWithAdvancedSignals(gap, advancedFeatures) {
  const base = gap >= 0.16 ? "低" : gap >= 0.08 ? "中" : "高";
  const tags = advancedFeatures?.riskTags ?? [];
  const hardRisk = tags.some((tag) => ["missing-european-odds", "missing-asian-handicap", "large-odds-drift", "large-asian-line-move"].includes(tag));
  if (hardRisk) return "高";
  if (base === "低" && tags.includes("missing-top-tier-team-intelligence")) return "中";
  return base;
}

function confidenceWithAdvancedSignals(primaryProbability, gap, advancedFeatures) {
  const base = primaryProbability * 72 + gap * 90;
  const quality = advancedFeatures?.quality?.score ?? 65;
  const penalty = Math.max(0, (88 - quality) * 0.35);
  const bounded = Math.max(0, Math.min(100, base - penalty));
  return Math.round(bounded * 100) / 100;
}

function hash(value) {
  let result = 0;
  for (const char of String(value)) result = (result * 31 + char.charCodeAt(0)) >>> 0;
  return result;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
