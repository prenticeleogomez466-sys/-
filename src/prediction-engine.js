import { loadFixtures } from "./fixture-store.js";
import { findMarketSnapshot, loadMarketSnapshots } from "./market-data-store.js";
import { buildAdvancedFixtureFeatures } from "./advanced-football-features.js";
import { loadAdvancedData } from "./advanced-data-store.js";
import { buildMonteCarloSimulation } from "./monte-carlo-simulator.js";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapCoverFromMatrix, scoreProbFromMatrix, topScoresWithProb, bestDistinctFirstHalfHalfFull, topHalfFull } from "./derived-score-model.js";
import { analyzeAsianHandicapWater } from "./asian-handicap-water.js";
import { buildBankrollRisk } from "./bankroll-risk.js";
import { calibrateProbabilities, loadCalibrationProfile } from "./model-calibration.js";
import { applyTemperature } from "./temperature-calibration.js";
import { fitFromFixtureStore, predictFromFitted, blendWithOdds } from "./dixon-coles-engine.js";
import { buildEnsemblePrediction } from "./ratings-ensemble.js";
import { loadEnsembleWeightsProfile } from "./ensemble-weights-profile.js";
import { bootstrapRatings } from "./ratings-bootstrap.js";
import { getSignalScale, loadSignalWeights } from "./signal-weight-tuner.js";
import { applyLayer2Signals } from "./feature-enhancers.js";
import { fuseSignals, loadFusionWeightProfile, SIGNAL_NAMES } from "./signal-fusion-layer.js";
import { loadHistoricalResults, buildFusionContext } from "./fusion-context-builder.js";
import { adjustParlayForCorrelation } from "./parlay-correlation-adjuster.js";
import { canonicalTeamName as canonicalTeamNameFromTable } from "./team-aliases.js";
import { scopeJingcaiFixtures } from "./jingcai-business-day.js";
import { buildExtendedMarkets } from "./extended-markets.js";
import { deriveHandicapFromScore, verifyRecommendationConsistency } from "./consistency-derivation.js";
import { asianHandicapFromSkellam } from "./skellam-distribution.js";

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

const FOURTEEN_DEFAULT_MAX_BANKERS = 6;
const FOURTEEN_DEFAULT_BANKER_MIN_GAP = 0.22;
// 用户指令(2026-05-29)"别降级门槛 推出最合理的真实分析"。
// 恢复合理门槛:置信 ≥50 + 概率差 ≥22%(标准 14 场胆门槛)。
// 模型本来就保守,出几个胆就几个胆,不靠降门槛凑数。
const FOURTEEN_DEFAULT_BANKER_MIN_CONFIDENCE = 50;
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
  // 限业务日 + 跨源去重(2026-05-30):兜底/多源抓取会把次日(周日)与重复场次(XML 6001 与 Playwright 周六001 同场)
  // 灌进当日,产生 34 场假象;此处收敛到目标业务日的去重竞彩单 + 原样保留 14 场/其它。
  const scopedFixtures = scopeJingcaiFixtures(fixtureSet.date, fixtureSet.fixtures);
  const rawPredictions = scopedFixtures.map((fixture, index) => predictFixture(fixture, marketSnapshots, index, { advancedData, calibrationProfile, dixonColesFitted, ratingsBootstrap, fusionContext: buildFusionContext(fixture, history) }));
  // 2026-05-30 诚实闸门:无真实先验的场(unpredictable=data-missing)绝不进推荐/14 场,
  //   单列在 unpredictable[] 如实标注「未预测·需补抓赔率」,而非用假方向凑数。
  const unpredictable = rawPredictions
    .filter((p) => p.unpredictable)
    .map((p) => ({
      homeTeam: p.fixture.homeTeam,
      awayTeam: p.fixture.awayTeam,
      sequence: p.fixture.sequence ?? null,
      marketType: p.fixture.marketType ?? null,
      reason: p.dataMissingReason ?? "数据缺失·未预测"
    }));
  const predictions = harmonizeDuplicatePredictions(rawPredictions.filter((p) => !p.unpredictable));
  return {
    date: fixtureSet.date,
    generatedAt: new Date().toISOString(),
    fixtures: predictions.length,
    unpredictable,
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
    fourteen: buildFourteenPlan(predictions, fixtureSet.date)
  };
}

// 取比赛真实开球日(YYYY-MM-DD)。kickoff 形如 "2026-05-31 21:00";退回 fixture.date。
// 平局倾向判定:纯 argmax 永不推平是结构性缺陷。低进球均势("闷平")里平局是价值选择。
// 判据(只用概率,平≥30% 本身已蕴含低进球均势):平不是最高、平≥0.30、平与最高差≤0.05 → 把平提为主推。
// 阈值可由 env 覆盖。返回 { applies, ranked, margin }。
export function evaluateDrawLean(ranked, env = process.env) {
  const minDraw = Number(env.DRAW_LEAN_MIN_PROB ?? 0.30);
  const maxGap = Number(env.DRAW_LEAN_MAX_GAP ?? 0.05);
  const draw = ranked.find((r) => r.code === "1");
  const leader = ranked[0];
  if (!draw || leader.code === "1") return { applies: false, ranked };
  const gap = leader.probability - draw.probability;
  if (draw.probability < minDraw || gap > maxGap) return { applies: false, ranked };
  // 把平提到首位,其余按概率降序(原热门退为次选)
  const rest = ranked.filter((r) => r.code !== "1").sort((a, b) => b.probability - a.probability);
  return { applies: true, ranked: [draw, ...rest], margin: round(gap) };
}

function fixtureKickoffDate(fixture) {
  return String(fixture?.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
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
    // 同场比分/半全场也走真矩阵(复用同场竞彩的 λ 构造真泊松矩阵),不落死表。
    const scoreModel = buildDerivedScoreModel(source.simulation?.lambdas?.home, source.simulation?.lambdas?.away);
    const scorePicks = buildScorePicks(source.pick.code, source.secondaryPick.code, prediction.marketSnapshot, source.probabilities, index, scoreModel);
    const halfFullPicks = buildHalfFullPicks(source.pick.code, source.secondaryPick.code, prediction.marketSnapshot, source.probabilities, index, scorePicks, scoreModel);
    enrichScoreAndHalfFull(scorePicks, halfFullPicks, scoreModel, source.pick.code);
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
  // 2026-05-29:删除冷启动 fallback。冷启动队若有亚盘+大小球 → 走市场推断 λ;否则 dcResult=null。
  const _asianLineHint = Number(snapshot?.asianHandicap?.current?.line ?? snapshot?.asianHandicap?.initial?.line ?? snapshot?.asianHandicap?.final?.line);
  const _ouLineHint = Number(snapshot?.totalGoals?.current?.line ?? snapshot?.totalGoals?.initial?.line ?? 2.55);
  const _marketHints = Number.isFinite(_asianLineHint) ? { asianLine: _asianLineHint, overUnderLine: _ouLineHint } : null;
  const dcResult = options.dixonColesFitted ? predictFromFitted(options.dixonColesFitted, fixture, _marketHints) : null;
  const blendResult = oddsProbabilities
    ? blendWithOdds(oddsProbabilities, dcResult, { competition: fixture.competition, weightProfile: loadSignalWeights() })
    : dcResult
      ? { probabilities: dcResult.probabilities, blendSource: "dixon-coles-only", dcWeight: 1, dcResult }
      : { probabilities: null, blendSource: "data-missing", dcWeight: 0, dcResult: null };
  // 2026-05-30 诚实闸门(用户硬规则「缺失数据绝不编造」):既无实时市场赔率、又不在 Dixon-Coles
  //   训练集 ⇒ 没有任何真实先验。绝不再用队名哈希的 seededProbabilities 编一个假概率
  //   —— 那会让胜平负 / 比分 / 半全场方向全部伪造、还被自检误标成「纯赔率」放行。
  //   直接返回「未预测·数据缺失」:不进推荐、不进 14 场;recommendFixtures 单列展示,
  //   pre-export 自检据 provenance=data-missing 拦截。需要预测就先补抓该场赔率。
  if (!blendResult.probabilities) {
    return {
      fixture,
      unpredictable: true,
      provenance: "data-missing",
      dataMissingReason: "未捕获实时赔率且该队不在 Dixon-Coles 训练集——无真实先验,按规则不预测(不编造)",
      marketSnapshot: snapshot,
      probabilities: null,
      pick: null,
      secondaryPick: null,
      scorePicks: null,
      halfFullPicks: null,
      handicapPick: null
    };
  }
  const baseProbabilities = blendResult.probabilities;
  const probabilityAdjustment = adjustProbabilitiesWithAdvancedData(fixture, baseProbabilities, options.advancedData);
  // V 档:贝叶斯信号融合层 —— 把伤停/H2H/赛季阶段/赛事性质等信号以 LR 证据融进概率。
  // 缺数据的信号自动休眠(见 fusion.dormant),冷启动下只有元数据类信号会真 fire。
  // X 档(2026-05-29):把市场开盘→当前的盘口移动接进融合层。europeanOdds.initial=开盘、
  // current=当前(竞彩多次捕获赔率变化时更新)。line-movement 信号据此 fire。
  // ⚠️ 诚实标注:baseProbabilities 已用 current 赔率 blend,current 信息大部分已计入 prior;
  // 本信号是"近期盘口移动显著时、略偏向更 sharp 的当前价"的二阶修正(LR 夹 [0.5,2]、
  // 融合总位移每 outcome 封顶 ±12%,且其后 market-prior isotonic 校准会再纠一次),不重复放大。
  // 亚盘水位(皇冠等风向标,初→即)装进 fusion context,激活 asian-handicap-water 信号 + 供展示判读。
  const _ah = snapshot?.asianHandicap;
  const asianHandicapWater = (_ah?.initial || _ah?.current) ? {
    earlyHome: _ah?.initial?.homeWater ?? null,
    earlyAway: _ah?.initial?.awayWater ?? null,
    lateHome: _ah?.current?.homeWater ?? _ah?.initial?.homeWater ?? null,
    lateAway: _ah?.current?.awayWater ?? _ah?.initial?.awayWater ?? null,
    line: Number(_ah?.current?.line ?? _ah?.initial?.line ?? 0)
  } : null;
  const fusionContext = {
    ...(options.fusionContext ?? {}),
    ...(oddsProbabilities && snapshot?.europeanOdds?.initial
      ? { openingOdds: probabilitiesFromOdds(snapshot.europeanOdds.initial), currentOdds: oddsProbabilities }
      : {}),
    ...(asianHandicapWater ? { asianHandicapWater } : {})
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
  //
  // 2026-05-30 修 bug:温度在 favBias=-0.37/Brier=0.70 的**无赔率冷启动样本**上拟合出 T≈1.975,
  //   但原先无差别套到**已被市场校准的混合路径**(favBias≈0/Brier≈0.57),把 0.764 砸到 0.568、
  //   favBias 反转成 +0.29(过度不自信),信心被系统性压低。校准步早有 hasMarketPrior 闸门跳过
  //   二次收缩,温度步却漏了同一闸门。修复:温度只软化**无市场先验**路径(那里模型确实过度自信);
  //   有市场先验时市场价已校准好,跳过温度,交给下游 isotonic-market 近恒等微调。
  let fusedProbs = fusion.probabilities;
  const fusionTemperature = weightProfile?.temperature;
  if (!hasMarketPrior && Number.isFinite(fusionTemperature) && fusionTemperature > 0 && fusionTemperature !== 1) {
    fusedProbs = applyTemperature(fusedProbs, fusionTemperature);
    probabilityAdjustment.temperature = fusionTemperature;
  } else if (hasMarketPrior && Number.isFinite(fusionTemperature) && fusionTemperature !== 1) {
    probabilityAdjustment.temperatureSkipped = { value: fusionTemperature, reason: "market-prior-already-calibrated" };
  }
  // hasMarketPrior:prior 已含市场赔率时(已被市场校准),跳过 cold-start favorite 收缩,避免过度收缩。
  const calibrated = calibrateProbabilities(fusedProbs, options.calibrationProfile, { fixture, snapshot, hasMarketPrior: Boolean(oddsProbabilities) });
  const probabilities = calibrated.probabilities;
  probabilityAdjustment.calibration = calibrated.calibration;
  const fixtureAdvancedData = advancedFixtureData(options.advancedData, fixture);
  let ranked = OUTCOMES.map((outcome) => ({ ...outcome, probability: probabilities[outcome.key] })).sort((a, b) => b.probability - a.probability);
  // 平局倾向修正(2026-05-30 用户要求强化):纯 argmax 结构性永不推平(平局概率上限~30%,常低于热门胜率)。
  // 真实足球知识:平局概率高(≥30%)本身只在"低进球+均势"profile 出现(高进球均势场平局概率反而低),
  // 这类"闷平"里平局是价值选择。命中 draw-favorable(平≥30% 且与最高仅差≤5%)时把平提为主推。
  const drawLean = evaluateDrawLean(ranked);
  if (drawLean.applies) ranked = drawLean.ranked;
  probabilityAdjustment.drawLean = drawLean.applies ? { margin: drawLean.margin, note: "低进球均势·平局为价值选择" } : null;
  const gap = ranked[0].probability - ranked[1].probability;
  const advancedFeatures = buildAdvancedFixtureFeatures(fixture, snapshot, probabilities, options);
  const simulation = buildMonteCarloSimulation(fixture, probabilities, { xg: fixtureAdvancedData.xg, iterations: options.simulationIterations });
  const risk = riskWithAdvancedSignals(gap, advancedFeatures);
  const confidence = confidenceWithAdvancedSignals(ranked[0].probability, gap, advancedFeatures);
  // 比分/半全场真实来源(2026-05-30 用户硬要求"不许兜底"):
  //   优先用训练 DC 矩阵;无训练 DC(冷门/友谊)时,用本场 λ(赔率/xG 推得)构造真 Dixon-Coles τ 泊松矩阵。
  //   两者同形状({topScores, expectedGoals, matrix}),喂给现成 scoreFromDcResult / halfFullFromDcResult,
  //   使比分/半全场恒由真矩阵派生,scoreForOutcome/halfFullForOutcome 死表不再触达。
  const scoreModel = blendResult.dcResult
    ?? buildDerivedScoreModel(simulation.lambdas?.home, simulation.lambdas?.away);
  const scorePicks = buildScorePicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, scoreModel);
  const halfFullPicks = buildHalfFullPicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, scorePicks, scoreModel);
  // 深度强化(2026-05-30 用户要求):给比分/半全场附真实概率 + 主方向内反超备选 + 完整分布,
  // 不再只给单一 argmax。所有附加量来自同一真泊松矩阵/半全场联合分布,可追溯、不破坏 wld 锚。
  enrichScoreAndHalfFull(scorePicks, halfFullPicks, scoreModel, ranked[0].code);
  // FF 档:从 dc matrix 派生扩展玩法(大小球/单双/上半场/亚盘/双胜彩/比分组/总进球)。
  // 缺 matrix 时 buildExtendedMarkets 自动返回 null,daily-report 据此决定是否输出该列。
  const extendedMarkets = blendResult.dcResult?.matrix
    ? buildExtendedMarkets(blendResult.dcResult.matrix)
    : null;
  // 2026-05-29 用户指令:**所有推荐以胜负平方向为锚**,handicap direction 直接 = wld,
  // 不再从 score 反推。原因:模型先决定 wld(pick.label),用户玩让球时买的就是这个方向;
  // score 选满足该 wld 的最高概率比分(已在 buildScorePicks 里做),半全场再跟 score 同步。
  // wld + score 可能不严格"几球领先"对齐 line(例 wld=主胜 + score=1-0 + 让 -1 实际让球后平),
  // 但这是诚实模型的局限,不掩盖。让球玩法的方向 = wld 主推荐方向,跟比分独立解读。
  // 让球线优先级:竞彩官方让球线(500.com 抓的整数线,让球玩法的真实盘口)> 亚盘线 > 0。
  const handicapLine = Number(snapshot?.jingcaiHandicap?.line
    ?? snapshot?.asianHandicap?.current?.line
    ?? snapshot?.asianHandicap?.initial?.line
    ?? snapshot?.asianHandicap?.final?.line
    ?? 0);
  const handicapLineSource = Number.isFinite(snapshot?.jingcaiHandicap?.line)
    ? "500.com-jczq"
    : (Number.isFinite(Number(snapshot?.asianHandicap?.current?.line ?? snapshot?.asianHandicap?.initial?.line)) ? "asian" : "default-0");
  // 让球方向以胜负平(wld)为锚(用户硬规则 2026-05-30):让球 direction 直接 = wld 主推方向,
  // 不再用 expectedGoals 独立反推。所有派生字段(让球/比分/半全场)统一从 wld 派生,保持口径一致。
  // 注:盘口线 line 仍来自市场,只是方向锚定 wld;netExpected 仅作内部参考量保留在 debug。
  const handicapPick = (() => {
    if (!ranked[0]?.label) return null;
    // 让球分析强化(2026-05-30):方向仍锚 wld(用户硬规则,不反推),但从真泊松矩阵算
    // 让球后真实覆盖/走盘概率 + 净期望 + 模型公平让球线,让"让球"不再只是"跟 wld + 让0"。
    const eg = scoreModel?.expectedGoals ?? blendResult.dcResult?.expectedGoals;
    const goalDiff = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)
      ? round(Number(eg.home) - Number(eg.away))
      : null;
    const coverInfo = scoreModel?.matrix ? handicapCoverFromMatrix(scoreModel.matrix, handicapLine) : null;
    const pickCover = (c) => c
      ? (ranked[0].code === "3" ? c.home : ranked[0].code === "0" ? c.away : (c.push ?? c.draw))
      : null;
    const coverProbability = pickCover(coverInfo?.cover);
    // Skellam 独立交叉校验(2026-05-30):用同一组 λ 经 Skellam 进球差分布算让球覆盖,
    //   与全场比分矩阵的覆盖概率比对。两条独立路径(一维 Skellam vs 二维 DC 矩阵)一致 ⇒ 让球高信心;
    //   分歧大 ⇒ 打「低信心」风险提示。**只提示、不改方向、不弃赛**(用户硬规则:弃赛由用户决定)。
    const skellamCover = (eg && Number.isFinite(eg.home) && Number.isFinite(eg.away))
      ? asianHandicapFromSkellam(eg.home, eg.away, handicapLine)
      : null;
    const skellamCoverProbability = pickCover(skellamCover);
    const skellamCheck = (coverProbability != null && skellamCoverProbability != null)
      ? (() => {
          const gap = round(Math.abs(coverProbability - skellamCoverProbability));
          const agree = gap <= 0.08;
          return {
            coverProbability: skellamCoverProbability,
            cover: skellamCover,
            gap,
            agree,
            note: agree
              ? `✓ 让球一致(矩阵 ${pctOrEmpty(coverProbability)} ≈ Skellam ${pctOrEmpty(skellamCoverProbability)})`
              : `⚠️ 让球低信心:矩阵 ${pctOrEmpty(coverProbability)} vs Skellam ${pctOrEmpty(skellamCoverProbability)} 分歧 ${pctOrEmpty(gap)},两模型不一致,谨慎`
          };
        })()
      : null;
    return {
      line: handicapLine,
      lineSource: handicapLineSource,
      direction: ranked[0].label,
      anchor: "wld",
      netExpected: goalDiff !== null ? round(goalDiff + handicapLine) : null,
      expectedGoalDiff: goalDiff,
      coverProbability,
      coverBreakdown: coverInfo?.cover ?? null,
      modelFairLine: coverInfo?.modelFairLine ?? null,
      skellamCheck
    };
  })();
  // 亚盘水位判读(展示用):真实皇冠初→即水位 + 盘口,按"升盘/降水"惯例给方向暗示(可追溯,不盲改概率)
  const asianWaterAnalysis = asianHandicapWater && Number.isFinite(asianHandicapWater.lateHome)
    ? analyzeAsianHandicapWater(asianHandicapWater)
    : null;
  const expectedValue = computeExpectedValueLabels(ranked, snapshot);
  // D 档接入(2026-05-28):用 bootstrap 传入的多评级算 ensembleView 作为 supplementary.
  // 不替换 main 路径 — 主推荐仍走 calibrated probabilities;ensembleView 用于 backtest 对比和未来切主.
  const ensembleView = options.ratingsBootstrap
    ? buildEnsembleViewFromBootstrap(fixture, options.ratingsBootstrap, oddsProbabilities, blendResult.dcResult)
    : null;
  const prediction = {
    fixture,
    // provenance:本场胜平负先验的真实来源(odds-only / odds(x)+dixon-coles(y) / dixon-coles-only)。
    // 自检据此核每个方向可追溯到赔率/DC,绝不会是 data-missing 编造。
    provenance: blendResult.blendSource,
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
    handicapPick,
    asianWaterAnalysis,
    extendedMarkets,
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
  // 2026-05-30(用户硬规则):让球方向以 wld 为锚 —— handicapPick.direction 直接 = wld 主推方向
  // (见上方 handicapPick 生成逻辑)。所有派生字段(让球/比分/半全场)统一从 wld 派生,口径一致,
  // 不再让 handicap 用 λ 净期望独立反推而 ≠ wld。这里不单独校验 handicap 方向,因为它按定义恒等于 wld。
  if (prediction.handicapPick && prediction.handicapPick.direction !== prediction.pick?.label) {
    errors.push(`让球方向 ${prediction.handicapPick.direction} 未以 wld(${prediction.pick?.label})为锚`);
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
  // GG 档:回测学到的 ensemble 权重 profile 优先(若不存在则用 ratings-ensemble 默认权重)
  const learnedWeights = loadEnsembleWeightsProfile()?.weights;
  const result = buildEnsemblePrediction(preds, learnedWeights ? { weights: learnedWeights } : {});
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

// 2026-05-30 已删除 seededProbabilities:它按 `队名-index` 哈希编造 home 0.35~0.55 的假概率,
//   是「胜平负/比分/半全场方向假数据」的根源(违反硬规则「缺失数据绝不编造」)。
//   现无真实先验的场一律走 predictFixture 的 data-missing 早返回,不再有任何伪造概率。

// 比分预测优先级(2026-05-30 用户硬要求"不许兜底",已删 if-else 死表):
//   1. snapshot.scoreOdds.top  ── sporttery 官方比分赔率(市场共识,准确度最高)
//   2. dcResult.topScores      ── Dixon-Coles 泊松矩阵 topScores(训练 DC 或 λ 派生矩阵)
//   3. bestScoreFromMatrix     ── 全矩阵扫描该 wld 方向最高概率比分(保证有解,仍是真泊松,非死表)
// dcResult 现恒为真矩阵(训练 DC 或 buildDerivedScoreModel 的 λ 泊松矩阵),scoreForOutcome 死表已不接入。
function buildScorePicks(code, secondaryCode, snapshot = null, probabilities = {}, index = 0, dcResult = null) {
  const matrix = dcResult?.matrix ?? null;
  const fromMarket = scoreFromMarket(snapshot, code);
  const fromMarketSecondary = scoreFromMarket(snapshot, secondaryCode, new Set(fromMarket ? [fromMarket] : []));
  const fromDc = fromMarket ? null : scoreFromDcResult(dcResult, code);
  const exclusionForSecondary = new Set([fromMarket, fromDc].filter(Boolean));
  const fromDcSecondary = fromMarketSecondary ? null : scoreFromDcResult(dcResult, secondaryCode, exclusionForSecondary);
  const primary = fromMarket ?? fromDc ?? bestScoreFromMatrix(matrix, code);
  const secondaryExclusion = new Set([primary].filter(Boolean));
  // 来源标记(供自检判真假):market=官方比分赔率;dcResult.source=训练DC/λ派生真泊松矩阵;
  // matrix-scan=全矩阵扫描(仍真泊松)。绝不出现死表来源 —— 死表已删。
  const source = fromMarket ? "market" : (fromDc ? (dcResult?.source ?? "dc-matrix") : (matrix ? (dcResult?.source ?? "poisson-matrix") : "none"));
  return {
    primary,
    secondary: fromMarketSecondary ?? fromDcSecondary ?? bestScoreFromMatrix(matrix, secondaryCode, secondaryExclusion) ?? bestScoreFromMatrix(matrix, secondaryCode),
    source
  };
}

// 半全场预测优先级同上:市场比分赔率 → DC/λ 泊松半场联合分布(halfFullFromDcResult 从 expectedGoals 真算)。
// dcResult 恒为真矩阵(带 expectedGoals),halfFullFromDcResult 必有解,halfFullForScore 死表已不接入。
function buildHalfFullPicks(code, secondaryCode, snapshot = null, probabilities = {}, index = 0, scorePicks = {}, dcResult = null) {
  const primaryScore = scorePicks.primary ?? bestScoreFromMatrix(dcResult?.matrix, code);
  const secondaryScore = scorePicks.secondary ?? bestScoreFromMatrix(dcResult?.matrix, secondaryCode);
  const primaryFromMarket = halfFullFromMarket(snapshot, code, new Set(), primaryScore);
  const primaryFromDc = primaryFromMarket ? null : halfFullFromDcResult(dcResult, code, new Set(), primaryScore);
  const exclusion = new Set([primaryFromMarket, primaryFromDc].filter(Boolean));
  const secondaryFromMarket = halfFullFromMarket(snapshot, secondaryCode, exclusion, secondaryScore);
  const secondaryFromDc = secondaryFromMarket ? null : halfFullFromDcResult(dcResult, secondaryCode, exclusion, secondaryScore);
  const source = primaryFromMarket ? "market" : (dcResult?.expectedGoals ? "poisson-half-joint" : "none");
  return {
    primary: primaryFromMarket ?? primaryFromDc ?? halfFullFromDcResult(dcResult, code, new Set(), primaryScore),
    secondary: secondaryFromMarket ?? secondaryFromDc ?? halfFullFromDcResult(dcResult, secondaryCode, new Set(), secondaryScore),
    source
  };
}

// 深度强化:给比分/半全场附概率 + 分布 + 主方向内"不同首半场"反超备选(真实矩阵派生,可追溯)。
function enrichScoreAndHalfFull(scorePicks, halfFullPicks, scoreModel, primaryCode) {
  const matrix = scoreModel?.matrix ?? null;
  scorePicks.primaryProbability = scoreProbFromMatrix(matrix, scorePicks.primary);
  scorePicks.secondaryProbability = scoreProbFromMatrix(matrix, scorePicks.secondary);
  scorePicks.distribution = topScoresWithProb(matrix, 5);
  const eg = scoreModel?.expectedGoals;
  const halfRatio = Number(process.env.DC_HALF_RATIO ?? 0.46);
  const hfDist = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)
    ? halfFullProbsFromLambdas(eg.home, eg.away, halfRatio)
    : null;
  halfFullPicks.primaryProbability = hfDist?.[halfFullPicks.primary] != null ? round(hfDist[halfFullPicks.primary]) : null;
  halfFullPicks.secondaryProbability = hfDist?.[halfFullPicks.secondary] != null ? round(hfDist[halfFullPicks.secondary]) : null;
  // 主方向内的反超/不同首半场备选(如主胜场的"平局-主胜"慢热反超),挖出被单 argmax 埋没的二线路径
  halfFullPicks.primaryAlt = bestDistinctFirstHalfHalfFull(hfDist, primaryCode, halfFullPicks.primary);
  halfFullPicks.distribution = topHalfFull(hfDist, 4);
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
// 联合分布 → 9 outcome 概率聚合,挑符合 final outcome + 跟 score 兼容的最高 prob 的。
// 改进(2026-05-29 用户反馈"半全场全一样"):secondary 从原本"按 prob 第二"变成
// "first-half 不同的 prob 最高"— 这样主胜场不会出现 主胜-主胜 备 主胜-主胜 的废话备选。
export function halfFullFromDcResult(dcResult, code, excluded = new Set(), score = "") {
  if (!dcResult?.expectedGoals) return null;
  const halfRatio = Number(process.env.DC_HALF_RATIO ?? 0.46);
  const probs = halfFullProbsFromLambdas(dcResult.expectedGoals.home, dcResult.expectedGoals.away, halfRatio);
  const candidates = Object.entries(probs)
    .filter(([halfFull]) => halfFullFinalOutcomeCode(halfFull) === code)
    .filter(([halfFull]) => !excluded.has(halfFull))
    .filter(([halfFull]) => !score || scoreHalfFullConsistent(score, halfFull))
    .sort((a, b) => b[1] - a[1]);
  // 如果 excluded 非空,说明这是 secondary 调用,且首选 first-half 已记入 excluded
  // —— 此时挑跟首选 first-half 不同的最高 prob 半全场,而不是 prob 第二(可能 first 相同)
  if (excluded.size > 0) {
    const excludedFirsts = new Set([...excluded].map((s) => String(s).split("-")[0]?.trim()));
    const diff = candidates.find(([halfFull]) => !excludedFirsts.has(String(halfFull).split("-")[0]?.trim()));
    if (diff) return diff[0];
  }
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

export function buildFourteenPlan(predictions, date = null) {
  const selected = predictions.filter((prediction) => prediction.fixture.marketType === "shengfucai" || prediction.fixture.tags.includes("14场胜负彩")).slice(0, 14);
  // 硬规则:14 场只在有真实 14 场胜负彩期(恰好 14 场)时才对外发布。
  // 串关/任选9 数学仍照常计算(供单元测试与内部分析),但用 available=false 标记,
  // 由报告层据此决定是否展示,避免把当日竞彩比赛冒充成 14 场。
  // 2026-05-30 追加:胜负彩整期提前数日开售,但比赛在未来(如第 26083 期 05-27 开售、赛在 05-31~06-02)。
  // 若传入推荐日,则还要求本期至少有一场比赛落在当天,否则不算"今日 14 场",不发(避免把未来期混进今天的单)。
  const matchOnDate = !date || selected.some((p) => fixtureKickoffDate(p.fixture) === date);
  const fourteenFull = selected.length === 14;
  const hasRealFourteen = fourteenFull && matchOnDate;
  const periodLabel = (selected[0]?.fixture?.notes ?? "").match(/第\d+期/)?.[0] ?? "本期";
  const source = selected.length ? selected : predictions.slice(0, 14);
  const rules = fourteenSelectionRules();
  // 冷启动模式:当所有 prediction 都没有真实高级数据(quality.score 一律 D 级 ≤ 62),
  // 严格 quality 门槛会过滤所有场次到 0 胆。这时改用更严格的概率/置信筛选,
  // 让模型仍能基于赔率给出胆材,同时维持"不容易给胆"的保守特性。
  const coldStartAll = source.every((p) => (p.advancedFeatures?.quality?.score ?? 0) < 62);

  // 候选胆:严格按 模型置信 + 概率差 双达标(不再有"市场共识"降级旁路)
  const candidates = source
    .map((prediction, index) => {
      const gap = prediction.pick.probability - prediction.secondaryPick.probability;
      const eo = prediction.marketSnapshot?.europeanOdds?.current ?? prediction.marketSnapshot?.europeanOdds?.initial;
      const favOdds = eo ? Math.min(Number(eo.home || 99), Number(eo.draw || 99), Number(eo.away || 99)) : 99;
      const isDeepFav = favOdds <= 1.65;
      return { index, prediction, gap, favOdds, isDeepFav, code: prediction.pick.code };
    })
    .filter((item) => {
      if (item.prediction.risk === "高") return false;
      if (item.gap < rules.bankerMinGap) return false;
      if (item.prediction.confidence < rules.bankerMinConfidence) return false;
      return true;
    })
    .sort((a, b) => (b.gap * b.prediction.confidence) - (a.gap * a.prediction.confidence));

  // 多样化约束:不让 6 胆全是深盘 favorite。挑选时:
  //   - 同一方向(主胜/平/客胜)最多 3 个胆
  //   - 深盘胆(赔率≤1.65)最多 3 个,剩下用中等胆填(避免一翻车整票完)
  //   - 优先保留前 N 个高分,但分类后强制平衡
  const pickedBankers = [];
  const codeCounts = { "3": 0, "1": 0, "0": 0 };
  let deepCount = 0;
  for (const item of candidates) {
    if (pickedBankers.length >= rules.maxBankers) break;
    if (codeCounts[item.code] >= 3) continue;
    if (item.isDeepFav && deepCount >= 3) continue;
    pickedBankers.push(item);
    codeCounts[item.code]++;
    if (item.isDeepFav) deepCount++;
  }
  // 深盘 cap 卡掉名额时,把跳过的中等胆补回来
  if (pickedBankers.length < rules.maxBankers) {
    for (const item of candidates) {
      if (pickedBankers.length >= rules.maxBankers) break;
      if (pickedBankers.includes(item)) continue;
      if (codeCounts[item.code] >= 3) continue;
      pickedBankers.push(item);
      codeCounts[item.code]++;
    }
  }
  const bankerIndexes = new Set(pickedBankers.map((item) => item.index));
  const selections = source.map((prediction, index) => {
    const probs = prediction.probabilities ?? {};
    const drawProb = Number(probs.draw ?? 0);
    const homeProb = Number(probs.home ?? 0);
    const awayProb = Number(probs.away ?? 0);
    const maxProb = Math.max(homeProb, drawProb, awayProb);
    const gap = prediction.pick.probability - prediction.secondaryPick.probability;
    const isBanker = bankerIndexes.has(index);

    // 14 场单式优先级:argmax 是默认,但**爆冷场强制让平局当 single**:
    //   draw ≥ 28% 且 favorite 优势 < 12pp → single = 平局(反 favorite 押爆冷)
    //   draw ≥ 32% 且 favorite 优势 < 8pp → 极端平局倾向,信号更强
    let singleCode = prediction.pick.code;
    let singleNote = "";
    if (drawProb >= 0.32 && maxProb - drawProb < 0.08) {
      singleCode = "1";
      singleNote = "平局倾向(draw≥32%,favorite优势<8pp)";
    } else if (drawProb >= 0.28 && maxProb - drawProb < 0.12 && drawProb >= Math.min(homeProb, awayProb)) {
      singleCode = "1";
      singleNote = "平局倾向(draw≥28%,favorite优势<12pp)";
    }

    // 覆盖逻辑同前,但参考 singleCode 决定覆盖中是否含 draw
    let codes;
    let coverageReason;
    if (isBanker) {
      codes = [singleCode];
      coverageReason = "✅ 胆码";
    } else if (drawProb >= 0.30 && maxProb - drawProb < 0.10) {
      codes = ["3", "1", "0"];
      coverageReason = "⚠ 平局 ≥30% 且接近最高,三选全覆盖";
    } else if (drawProb >= 0.25 && singleCode !== "1") {
      codes = [singleCode, "1"];
      coverageReason = "⚠ 平局 ≥25% 强制覆盖,搏爆冷";
    } else if (Math.min(homeProb, awayProb) >= 0.28 && Math.abs(homeProb - awayProb) <= 0.10) {
      codes = ["3", "1", "0"];
      coverageReason = "⚠ 主客实力接近,三选全防爆冷";
    } else if (singleCode === "1") {
      // 平局倾向时,覆盖一定带主胜或客胜 fallback
      codes = ["1", maxProb === homeProb ? "3" : "0"];
      coverageReason = "平局倾向 + 一侧 fallback";
    } else if (gap >= rules.doubleMinGap) {
      codes = [singleCode, prediction.secondaryPick.code];
      coverageReason = `双选(概率差 ${Math.round(gap * 100)}%)`;
    } else {
      codes = ["3", "1", "0"];
      coverageReason = `三选全(概率差仅 ${Math.round(gap * 100)}%,信号弱)`;
    }

    const weakerProb = Math.min(homeProb, awayProb);
    const upsetRisk = weakerProb >= 0.22 ? "⚠ 爆冷有戏" : weakerProb >= 0.15 ? "标准" : "公认 favorite";

    return {
      index: index + 1,
      match: `${prediction.fixture.homeTeam} 对 ${prediction.fixture.awayTeam}`,
      single: outcomeCodeToChinese(singleCode),
      compound: codes.map(outcomeCodeToChinese).join("/"),
      type: codes.length === 1 ? "胆" : codes.length === 2 ? "双选" : "全选",
      competitionType: competitionCategory(prediction.fixture?.competition),
      probabilities: { home: pctOrEmpty(homeProb), draw: pctOrEmpty(drawProb), away: pctOrEmpty(awayProb) },
      upsetRisk,
      risk: prediction.risk,
      confidence: prediction.confidence,
      reason: `${singleNote ? singleNote + "；" : ""}${coverageReason}；爆冷:${upsetRisk}；${prediction.rationale}`
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
    available: hasRealFourteen,
    note: hasRealFourteen
      ? undefined
      : fourteenFull && !matchOnDate
        ? `14 场胜负彩${periodLabel}比赛日不在 ${date}(本期赛在未来),按规则今日不发 14 场。`
        : "今日无 14 场胜负彩(不足 14 场),按硬规则不发 14 场。",
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
  const picks = ranked.map(({ prediction, gap }, i) => {
    const probs = prediction.probabilities ?? {};
    const drawProb = Number(probs.draw ?? 0);
    const homeProb = Number(probs.home ?? 0);
    const awayProb = Number(probs.away ?? 0);
    const maxProb = Math.max(homeProb, drawProb, awayProb);

    // 单式 = argmax 默认,平局倾向场强制改 single = 平局(同 14 场规则)
    let singleCode = prediction.pick.code;
    let singleNote = "";
    if (drawProb >= 0.30 && maxProb - drawProb < 0.10) {
      singleCode = "1";
      singleNote = "平局倾向(任选 9 严选 draw≥30%,gap<10pp)";
    } else if (drawProb >= 0.26 && maxProb - drawProb < 0.12 && drawProb >= Math.min(homeProb, awayProb)) {
      singleCode = "1";
      singleNote = "平局倾向";
    }

    // 任选 9 胆门槛恢复:置信 ≥50 + 概率差 ≥22%,不靠市场降级
    const isBanker = gap >= 0.22 && prediction.confidence >= 50
                     && prediction.risk !== "高" && singleCode !== "1";
    let codes, coverageReason;
    if (isBanker) {
      codes = [singleCode];
      coverageReason = "✅ 胆(高置信)";
    } else if (drawProb >= 0.30 && maxProb - drawProb < 0.10) {
      codes = ["3", "1", "0"];
      coverageReason = "⚠ 平局 ≥30% 三选全";
    } else if (drawProb >= 0.22 && singleCode !== "1") {
      codes = [singleCode, "1"];
      coverageReason = "⚠ 平局 ≥22% 强制覆盖";
    } else if (Math.min(homeProb, awayProb) >= 0.28 && Math.abs(homeProb - awayProb) <= 0.10) {
      codes = ["3", "1", "0"];
      coverageReason = "⚠ 主客接近,三选全";
    } else if (singleCode === "1") {
      codes = ["1", maxProb === homeProb ? "3" : "0"];
      coverageReason = "平局倾向 + 一侧 fallback";
    } else if (gap >= 0.10) {
      codes = [singleCode, prediction.secondaryPick.code];
      coverageReason = `双选(差 ${Math.round(gap * 100)}%)`;
    } else {
      codes = ["3", "1", "0"];
      coverageReason = `三选全(差 ${Math.round(gap * 100)}%,信号弱)`;
    }

    return {
      rank: i + 1,
      match: `${prediction.fixture.homeTeam} 对 ${prediction.fixture.awayTeam}`,
      competitionType: competitionCategory(prediction.fixture?.competition),
      pick: outcomeCodeToChinese(singleCode),
      code: singleCode,
      probability: prediction.pick.probability,
      probabilities: { home: pctOrEmpty(homeProb), draw: pctOrEmpty(drawProb), away: pctOrEmpty(awayProb) },
      compound: codes.map(outcomeCodeToChinese).join("/"),
      type: codes.length === 1 ? "胆" : codes.length === 2 ? "双选" : "全选",
      confidence: prediction.confidence,
      risk: prediction.risk,
      gap: Math.round(gap * 100) / 100,
      reason: `${singleNote ? singleNote + "；" : ""}${coverageReason}；${prediction.rationale ?? ""}`
    };
  });
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

/**
 * 把 fixture.competition 中文/英文联赛名归类成竞猜场景标签,用户看 xlsx 时能直观分辨
 * "这是欧冠/联赛/国家队赛/友谊赛"。归类影响推理 prior(欧冠 / 联赛差异大)。
 */
function pctOrEmpty(v) {
  if (!Number.isFinite(v)) return "";
  return `${Math.round(v * 1000) / 10}%`;
}

export function competitionCategory(competition) {
  if (!competition) return "未知赛事";
  const s = String(competition);
  if (/欧冠|Champions/i.test(s)) return "🏆 欧冠";
  if (/欧联|Europa/i.test(s)) return "🏆 欧联";
  if (/欧会|Conference/i.test(s)) return "🏆 欧会";
  if (/友谊|Friendly/i.test(s)) return "⚠ 友谊赛(战意低、随机性高)";
  if (/世预|World Cup Q/i.test(s)) return "🌍 世预赛";
  if (/国家|National|国际赛/.test(s)) return "🌍 国家队赛";
  if (/英超|Premier/i.test(s) || /西甲|La Liga/i.test(s) || /德甲|Bundesliga/i.test(s) || /意甲|Serie A/i.test(s) || /法甲|Ligue 1/i.test(s)) return "🥇 五大联赛";
  if (/杯|Cup/i.test(s)) return "🏅 杯赛";
  if (/超|甲|联赛|League|Liga/i.test(s)) return "⚽ 联赛";
  return s;
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
