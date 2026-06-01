import { loadFixtures } from "./fixture-store.js";
import { findMarketSnapshot, loadMarketSnapshots } from "./market-data-store.js";
import { buildAdvancedFixtureFeatures } from "./advanced-football-features.js";
import { loadAdvancedData } from "./advanced-data-store.js";
import { buildMonteCarloSimulation, lambdaTotalFromMarket } from "./monte-carlo-simulator.js";
import { worldCupLambdaContext, worldCupMatchPrior } from "./world-cup-priors.js";
import { getExperienceBaseline } from "./experience-library-store.js";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapCoverFromMatrix, scoreProbFromMatrix, topScoresWithProb, bestDistinctFirstHalfHalfFull, topHalfFull, handicapLadder, totalGoalsBands, halfFullDepth } from "./derived-score-model.js";
import { analyzeUpsetTrap } from "./upset-trap-detector.js";
import { analyzeAsianHandicapWater } from "./asian-handicap-water.js";
import { buildBankrollRisk } from "./bankroll-risk.js";
import { calibrateProbabilities, loadCalibrationProfile } from "./model-calibration.js";
import { loadModelMemory, recallSegmentPerformance } from "./model-memory.js";
import { loadNationalElo, nationalEloFor, eloToLambdas } from "./national-elo-source.js";
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
import { calibrateOver25 } from "./overunder-calibration.js";
import { asianHandicapFromSkellam } from "./skellam-distribution.js";
import { recalibrateSoftCompetition, softCompetitionLambdaScale } from "./competition-soft-recalibration.js";
import { halfFullJoint } from "./halftime-fulltime-model.js";
import { ensembleHalfFull } from "./ensemble-halffull.js";
import { scoreConfidenceTier, halfFullConfidenceTier } from "./score-halffull-tier.js";

// 半全场分布:优先多路集成(model_notau 80%+经验 20%,回测 LL 1.9624→1.9488),profile/经验表
// 不可用则回退裸 halfFullJoint(τ+状态默认)。league 缺则集成用全局经验。
function hfDistribution(lambdaHome, lambdaAway, league) {
  return ensembleHalfFull(lambdaHome, lambdaAway, league) ?? halfFullJoint(lambdaHome, lambdaAway);
}
import { selectionTier } from "./selection-tier.js";
import { optimizeTicket } from "./ticket-optimizer.js";
import { gate as marketDivergenceGate } from "./clv-confidence-gate.js";
import { analyzeMatch } from "./match-archetype-analyzer.js";
import { leagueExpertFromFitted } from "./league-expert-mixture.js";
import { multimodalAnalysis, summarizeMultimodal } from "./multimodal-collab.js";

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

// λ 物理上限闸门(2026-06-01,前置到 predictFixture):与 pre-export-selfcheck.js 的
//   LAMBDA_SIDE_BLOCK=4.0 / LAMBDA_TOTAL_BLOCK=5.5 同值同义。pre-export 是出表前最后拦截,
//   这里前置到算 handicap/比分之前——λ 一旦超物理上限,后续派生全失真,直接判 unpredictable,
//   不再白算。复用同一组阈值,确保前后口径一致。
const LAMBDA_SIDE_BLOCK = 4.0;
const LAMBDA_TOTAL_BLOCK = 5.5;

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
  // 永久记忆(2026-06-01):模型分段真实战绩,用时召回给推荐附"本类历史命中率"。盘上无则 null,优雅降级。
  const modelMemory = loadModelMemory();
  // 国家队 Elo(2026-06-01):历史库无国家队时的模型先验源,盘上无则 null(优雅降级)。
  const nationalElo = loadNationalElo();
  // 全量历史拟合(2026-05-31):放开默认 120 天上限,吃满 34k+ 场/37 联赛/762 队语料,
  //   让所有球队攻防特征都被学到(用户要求"所有队伍特征都吸取";time-decay 自动降权旧赛)。
  //   全量拟合仅 ~400ms,启动一次,可接受。回测走 fitFromMatches/显式 maxDates 不受影响。
  const dixonColesFitted = fitFromFixtureStore({ maxDates: 2000 });
  // D 档接入(2026-05-28):一次性加载所有评级,传给 predictFixture 算 ensembleView.
  // 失败时(样本不足等)bootstrap.* 字段为 null,不影响主路径.
  let ratingsBootstrap = null;
  try {
    ratingsBootstrap = bootstrapRatings({ maxDates: 2000 });  // 全量语料:37 联赛全覆盖,供联赛专家门控
  } catch {
    // bootstrap 失败 → 跳过,主路径仍工作
  }
  // V 档:从历史赛果(严格早于当前比赛日,防泄漏)装配每场的 fusionContext,
  // 激活信号融合层里的 h2h / clean-sheet-streak / streak 信号(内部数据源,无需外部 API)。
  const history = loadHistoricalResults({ beforeDate: fixtureSet.date });
  // 限业务日 + 跨源去重(2026-05-30):兜底/多源抓取会把次日(周日)与重复场次(XML 6001 与 Playwright 周六001 同场)
  // 灌进当日,产生 34 场假象;此处收敛到目标业务日的去重竞彩单 + 原样保留 14 场/其它。
  const scopedFixtures = scopeJingcaiFixtures(fixtureSet.date, fixtureSet.fixtures);
  const predictOne = (fixture, index, extra = {}) => predictFixture(fixture, marketSnapshots, index, { advancedData, calibrationProfile, modelMemory, nationalElo, dixonColesFitted, ratingsBootstrap, fusionContext: buildFusionContext(fixture, history), ...extra });
  let rawPredictions = scopedFixtures.map((fixture, index) => predictOne(fixture, index));
  // 「竞彩要全」铁律(2026-05-31):竞彩缺欧赔被判 data-missing 的场,若同场在 14 场有真实预测 → 借其 wld 重算补全。
  const shengfucaiByKey = new Map(
    rawPredictions.filter((p) => !p.unpredictable && p.fixture.marketType === "shengfucai")
      .map((p) => [fixtureIdentityKey(p.fixture), p])
  );
  rawPredictions = rawPredictions.map((p, index) => {
    if (!p.unpredictable || p.fixture.marketType !== "jingcai") return p;
    const src = shengfucaiByKey.get(fixtureIdentityKey(p.fixture));
    if (!src?.probabilities) return p; // 无可借 → 保持 data-missing(诚实)
    return predictOne(p.fixture, index, {
      priorProbabilities: src.probabilities,
      priorSource: `borrowed-shengfucai:${src.fixture.sequence ?? src.fixture.id}`,
    });
  });
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
  // 多模态协作汇总(2026-05-31):各路独立模型(市场赔率/DC纯泊松/信号融合/历史经验/让球覆盖)
  //   各自给胜平负判断 → 本层做 分流×对比×裁决,挂到每场 prediction.multimodal。
  //   严守硬规则:只读已算好的真实中间量、以 wld 为锚不改方向、分歧只下调信心不弃赛、缺数据 available:false。
  for (const p of predictions) {
    // 传入已加载的历史比赛库(上方 loadHistoricalResults)→ 附 H2H/近期 历史小模型(稀疏则 available:false)。
    try { p.multimodal = multimodalAnalysis(p, { history }); } catch { p.multimodal = null; }
  }
  const multimodalSummary = summarizeMultimodal(predictions);
  return {
    date: fixtureSet.date,
    generatedAt: new Date().toISOString(),
    fixtures: predictions.length,
    unpredictable,
    predictions,
    multimodalSummary,
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
  // 2026-06-01 修「永远不推平」:旧门槛 minDraw=0.30,但真实均势国际赛平局率 26-29%(模型软重校准后
  //   平局上限≈29%),永远够不到 0.30 → drawLean 从不触发、argmax 结构性永不选平。诊断实证:某日 20 场
  //   平局概率均 24%/最高 28.8%、推平 0 场。下调门槛到能反映真实均势平局,并放宽 gap:平局只要进前二、
  //   与领先者足够接近(均势闷局),即把平提为主推。仍以 wld 概率为锚、不反推。
  const minDraw = Number(env.DRAW_LEAN_MIN_PROB ?? 0.26);
  const maxGap = Number(env.DRAW_LEAN_MAX_GAP ?? 0.08);
  const draw = ranked.find((r) => r.code === "1");
  const leader = ranked[0];
  if (!draw || leader.code === "1") return { applies: false, ranked };
  const gap = leader.probability - draw.probability;
  // 平局须进前二(是第二高)才提为主推,避免把明显第三的平局硬抬。
  const drawRank = ranked.findIndex((r) => r.code === "1");
  if (draw.probability < minDraw || gap > maxGap || drawRank > 1) return { applies: false, ranked };
  // 把平提到首位,其余按概率降序(原热门退为次选)
  const rest = ranked.filter((r) => r.code !== "1").sort((a, b) => b.probability - a.probability);
  return { applies: true, ranked: [draw, ...rest], margin: round(gap) };
}

function fixtureKickoffDate(fixture) {
  return String(fixture?.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

// 双选(双重机会)建议(2026-05-31)—— 诚实回测结论:单选平局命中率物理上限 ~28%(基线26%),
// 平局本质不可预测,硬推单平=72%翻车。所以均势场不强行猜平,而是给"主推方向+平"双选覆盖平局风险。
// 触发:无强热门(领先<55%)且平局有威胁(≥28%)且平不是首推。返回 null 表示该场强热门、无需双选。
// 不改 pick/比分/半全场(仍锚 wld),只附加一条覆盖平局的双选建议(用户决定买不买,不替弃赛)。
export function computeDoubleChance(ranked, env = process.env) {
  const minDraw = Number(env.DOUBLE_CHANCE_MIN_DRAW ?? 0.28);
  const maxLeader = Number(env.DOUBLE_CHANCE_MAX_LEADER ?? 0.55);
  const draw = ranked.find((r) => r.code === "1");
  const leader = ranked[0];
  if (!draw || !leader || leader.code === "1") return null;
  if (draw.probability < minDraw || leader.probability >= maxLeader) return null;
  const combined = round(leader.probability + draw.probability);
  return {
    pick: `${leader.label}/平局`,
    codes: [leader.code, "1"],
    combinedProbability: combined,
    drawProbability: round(draw.probability),
    note: `均势场·平局风险高(平${(draw.probability * 100).toFixed(0)}%),单选命中低 → 建议双选 ${leader.label}/平 覆盖(合计${(combined * 100).toFixed(0)}%)`,
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
    // 同场次直接复用竞彩源已算的比分/半全场(同一场比赛、同一 λ)——2026-06-01 修:旧逻辑按各自
    //   index 重算 buildScorePicks,导致同场在竞彩表与14场表显示不同比分(如土耳其 0-1 vs 1-2)。
    //   既然 wld/让球/概率都强制对齐竞彩源,比分/半全场也应原样复制,保证两表完全一致、不再各算各的。
    const scorePicks = source.scorePicks ? JSON.parse(JSON.stringify(source.scorePicks)) : null;
    const halfFullPicks = source.halfFullPicks ? JSON.parse(JSON.stringify(source.halfFullPicks)) : null;
    const next = {
      ...prediction,
      probabilities: { ...source.probabilities },
      // 同步竞彩源 λ:14场原 simulation.lambdas 来自 14场自有赔率,与已对齐的比分/让球不同源,留着会误导核验。
      simulation: source.simulation ? { ...prediction.simulation, ...source.simulation } : prediction.simulation,
      probabilityAdjustment: {
        ...prediction.probabilityAdjustment,
        harmonizedWith: source.fixture.id
      },
      pick: { ...source.pick },
      secondaryPick: { ...source.secondaryPick },
      doubleChance: source.doubleChance ? { ...source.doubleChance } : null,
      risk: source.risk,
      confidence: source.confidence,
      // 同场次已强制对齐竞彩源的 wld → 市场背离度也直接取竞彩源(其持真实欧赔),避免 14 场缺欧赔时陈旧/不一致。
      marketDivergence: source.marketDivergence ? { ...source.marketDivergence } : null,
      scorePicks,
      halfFullPicks,
      // 让球方向也必须跟着 wld 锚走(2026-05-31 修):同场次强制对齐竞彩 wld 后,pick.label 变了,
      //   但原 handicapPick 仍是 shengfucai 自己旧 wld 的方向 → 近平局盘(如瑞士vs约旦 2.32/2.30
      //   两源各判主/客胜)会触发"让球方向未以 wld 为锚"自检。采用竞彩源的 handicapPick(同一场比赛、
      //   竞彩持官方让球线,direction 恒等于 source.pick.label),无则按新 wld 兜底改向。
      handicapPick: source.handicapPick
        ? { ...source.handicapPick }
        : (prediction.handicapPick ? { ...prediction.handicapPick, direction: source.pick.label, anchor: "wld" } : null),
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
  let dcResult = options.dixonColesFitted ? predictFromFitted(options.dixonColesFitted, fixture, _marketHints) : null;
  // 国家队 Elo 兜底(2026-06-01):历史库无该国家队(俱乐部源不含国家队友谊/资格赛)→ dcResult=null
  //   → 原退回纯 odds-only(无模型视角、无比分/半全场真矩阵)。改:两队都有国家队 Elo 时,用 Elo 差转
  //   期望进球 λ 建同款 DC-τ 矩阵作模型先验,使国家队也有 胜平负+比分+半全场。友谊赛信心不夸大(homeAdv 取小)。
  let nationalEloUsed = null;
  if (!dcResult?.probabilities && options.nationalElo) {
    const eh = nationalEloFor(options.nationalElo, fixture.homeTeam);
    const ea = nationalEloFor(options.nationalElo, fixture.awayTeam);
    const lam = (Number.isFinite(eh) && Number.isFinite(ea))
      ? eloToLambdas(eh, ea, { totalGoals: Number.isFinite(_ouLineHint) ? _ouLineHint : undefined })
      : null;
    if (lam) {
      const eloModel = buildDerivedScoreModel(lam.home, lam.away);
      if (eloModel) {
        eloModel.source = "national-elo";
        dcResult = eloModel;
        nationalEloUsed = { home: eh, away: ea, supremacy: lam.supremacy, eloDiff: lam.eloDiff };
      }
    }
  }
  let blendResult = oddsProbabilities
    ? blendWithOdds(oddsProbabilities, dcResult, nationalEloUsed
        // 国家队 Elo 是长期实力先验、友谊赛噪声大(整夜回测:弱信号高权重融市场会拖累)→ 权重保守 0.22,市场仍主导。
        ? { competition: fixture.competition, weightProfile: loadSignalWeights(), dcWeight: 0.22 }
        : { competition: fixture.competition, weightProfile: loadSignalWeights() })
    : dcResult
      ? { probabilities: dcResult.probabilities, blendSource: "dixon-coles-only", dcWeight: 1, dcResult }
      : { probabilities: null, blendSource: "data-missing", dcWeight: 0, dcResult: null };
  // 来源诚实改写:Elo 兜底产的先验不冒充 dixon-coles(国家队 Elo ≠ 俱乐部 DC 拟合)。
  if (nationalEloUsed && typeof blendResult.blendSource === "string") {
    blendResult.blendSource = blendResult.blendSource.replace(/dixon-coles/g, "national-elo");
  }
  // 借用先验(2026-05-31,「竞彩要全」铁律):竞彩让0档"未开售"→无欧赔、国际队又冷启动 ⇒ 本会 data-missing 被删。
  //   但同一场比赛常在 14 场胜负彩里有真实预测(同队)。recommendFixtures 二次传入该场 14 场的 wld 作先验,
  //   让竞彩跑完整机器(让球/比分/半全场/分档),竞彩明细补全。这是借**模型已对同场做出的真实预测**,非编造。
  if (!blendResult.probabilities && options.priorProbabilities && Number.isFinite(options.priorProbabilities.home)) {
    blendResult = { probabilities: { ...options.priorProbabilities }, blendSource: options.priorSource ?? "borrowed-prior", dcWeight: 0, dcResult: null };
  }
  // 世界杯 Elo 先验兜底(2026-06-01):世界杯参赛队赛前常**既无竞彩赔率、又不在俱乐部 DC 训练集**,
  //   原本直接 data-missing 整场放弃。改为:若对阵双方都是 48 强(team-priors 有 Elo),用真实 Elo
  //   推标准胜平负先验(world-cup-priors.eloExpectation)兜底。这是**用查证到的真实实力数据**作先验,
  //   非队名哈希编造;质量已验证(挪威vs瑞典 Elo先验≈实盘竞赛)。仍排在赔率/DC/同场14场先验之后。
  if (!blendResult.probabilities) {
    const wcPrior = worldCupMatchPrior(fixture?.homeTeam, fixture?.awayTeam, { hostHome: true });
    if (wcPrior && Number.isFinite(wcPrior.probabilities?.home)) {
      blendResult = { probabilities: { ...wcPrior.probabilities }, blendSource: wcPrior.source, dcWeight: 0, dcResult: null };
    }
  }
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
  // 温度软化层已删除(2026-05-31 用户铁律「删掉所有兜底」):温度只在 isotonic 缺失的冷启动兜底才生效,
  //   生产两条路径(市场先验 / 模型 isotonic)本就不走它。校准统一交给下面数据驱动的 isotonic
  //   (保留——它是用真实历史学出的纠偏,不是凑数)。不再保留温度创可贴。
  let fusedProbs = fusion.probabilities;
  // hasMarketPrior:prior 已含市场赔率时(已被市场校准),跳过 cold-start favorite 收缩,避免过度收缩。
  const calibrated = calibrateProbabilities(fusedProbs, options.calibrationProfile, { fixture, snapshot, hasMarketPrior: Boolean(oddsProbabilities) });
  let probabilities = calibrated.probabilities;
  probabilityAdjustment.calibration = calibrated.calibration;
  const fixtureAdvancedData = advancedFixtureData(options.advancedData, fixture);
  // 经验库基线(2026-05-30):查该联赛该热门档/亚盘档的历史真实进球水平 + 平局率。
  // 用途:① 给无训练 DC 的场(odds-only)提供联赛特异 λ,修"比分跨联赛雷同";
  //       ② 历史平局率:既供平局风险提示,也作软赛事平局重校准的实证目标(见下)。
  //   先于 ranked 计算:用 pre-recal 概率定"同情境"热门档,避免循环依赖。
  const experienceBaseline = options.experienceBaseline === null
    ? null
    : (options.experienceBaseline ?? getExperienceBaseline(fixture, probabilities, snapshot, {
        opening: fusionContext.openingOdds ?? null,
        closing: fusionContext.currentOdds ?? oddsProbabilities ?? null,
      }));
  // 软赛事(友谊/国家队/国际赛)平局重校准(2026-05-31):五大联赛 isotonic 校准把强热门压到
  //   ~0.807、平局机械钉 ~13%,但国际赛/友谊赛真实平局率 28-30%。仅命中软赛事时,把平局有界地
  //   朝"赛事性质先验 + 历史同情境平局率"移动(改 wld 锚本身,下游派生一致)。**俱乐部路径零改动**。
  const softRecal = recalibrateSoftCompetition(probabilities, fixture?.competition, experienceBaseline);
  if (softRecal.applied) probabilities = softRecal.probabilities;
  probabilityAdjustment.softCompetitionRecal = softRecal.applied ? softRecal.detail : null;
  let ranked = OUTCOMES.map((outcome) => ({ ...outcome, probability: probabilities[outcome.key] })).sort((a, b) => b.probability - a.probability);
  // 平局倾向修正(2026-05-30 用户要求强化):纯 argmax 结构性永不推平(平局概率上限~30%,常低于热门胜率)。
  // 真实足球知识:平局概率高(≥30%)本身只在"低进球+均势"profile 出现(高进球均势场平局概率反而低),
  // 这类"闷平"里平局是价值选择。命中 draw-favorable(平≥30% 且与最高仅差≤5%)时把平提为主推。
  const drawLean = evaluateDrawLean(ranked);
  if (drawLean.applies) ranked = drawLean.ranked;
  probabilityAdjustment.drawLean = drawLean.applies ? { margin: drawLean.margin, note: "低进球均势·平局为价值选择" } : null;
  const gap = ranked[0].probability - ranked[1].probability;
  const advancedFeatures = buildAdvancedFixtureFeatures(fixture, snapshot, probabilities, options);
  // 大小球(O/U)盘口校准 λ 总量(2026-05-31 回测证实:比分命中+0.84pp/半全场LogLoss-0.46%/大小球校准更准)。
  //   从快照取 line + 两路 over/under 赔率(去vig→P(over)),解出市场预期进球总量,传给 λ 估计;
  //   缺盘口则为 null,estimateGoalLambdas 自动降级到联赛经验均值(无回退风险)。
  const tg = snapshot?.totalGoals ?? snapshot?.totalGoalsOdds ?? snapshot?.overUnderOdds ?? null;
  const tgNode = tg?.current ?? tg?.final ?? tg?.initial ?? tg ?? null;
  const ouLine = Number(tgNode?.line ?? snapshot?.totalGoals?.current?.line ?? snapshot?.totalGoals?.initial?.line);
  const ouOver = Number(tgNode?.over ?? tgNode?.overOdds ?? tgNode?.o);
  const ouUnder = Number(tgNode?.under ?? tgNode?.underOdds ?? tgNode?.u);
  const ouOverProb = (Number.isFinite(ouOver) && Number.isFinite(ouUnder) && ouOver > 1 && ouUnder > 1)
    ? (1 / ouOver) / (1 / ouOver + 1 / ouUnder) : null;
  const marketTotal = lambdaTotalFromMarket({ line: Number.isFinite(ouLine) ? ouLine : null, overProb: ouOverProb });
  // 世界杯专属特征(海拔/气温/赛制阶段 → λ 总量乘子)。非 2026 世界杯正赛场返回 isWC:false、乘子=1。
  const wcCtx = worldCupLambdaContext(fixture, fixture?.date ?? fixture?.matchDate ?? null);
  probabilityAdjustment.worldCup = wcCtx.isWC ? wcCtx : null;
  const simulation = buildMonteCarloSimulation(fixture, probabilities, { xg: fixtureAdvancedData.xg, iterations: options.simulationIterations, experienceBaseline, marketTotal, worldCupMult: wcCtx.lambdaMult });
  const risk = riskWithAdvancedSignals(gap, advancedFeatures);
  const confidence = confidenceWithAdvancedSignals(ranked[0].probability, gap, advancedFeatures);
  // 比分/半全场真实来源(2026-05-30 用户硬要求"不许兜底"):
  //   优先用训练 DC 矩阵;无训练 DC(冷门/友谊)时,用本场 λ(赔率/xG 推得)构造真 Dixon-Coles τ 泊松矩阵。
  //   两者同形状({topScores, expectedGoals, matrix}),喂给现成 scoreFromDcResult / halfFullFromDcResult,
  //   使比分/半全场恒由真矩阵派生,scoreForOutcome/halfFullForOutcome 死表不再触达。
  // 软赛事 λ 强度衰减(2026-05-31):友谊/国际赛进球偏低,competition intensityMultiplier 半强度缩放
  //   (避免与市场赔率已隐含信息重复打折)。非软赛事 scale=1,俱乐部/有训练 DC 的场不受影响。
  const _lamScale = softCompetitionLambdaScale(fixture?.competition);
  // 比分 λ 市场校准对齐(2026-05-31 修 DC 强队 λ 高估):训练 DC 评级算的 λ **不含本场大小球盘口**,
  //   强队对鱼腩(拜仁/曼城等)λ 会冲到 4+ → 4-0/5-0 极端比分且触 λ 物理闸门拦掉全表,而概率
  //   融合里 DC 仅占 dcWeight、比分却 100% 用这个高估 λ(口径不一致)。修复:有市场校准 λ
  //   (simulation.lambdas,来自大小球盘口+经验库,已回测证比分+0.84pp)时,把比分 λ 按概率融合
  //   **同权重(dcWeight)** 向市场 λ 收缩,使比分与胜负平同口径、λ 回物理区间;DC 的 home/away
  //   形状信息经 buildDerivedScoreModel 用收缩后 λ 重建保留(与无训练 DC 的 fallback 同一构造)。
  const _dcEg = blendResult.dcResult?.expectedGoals;
  const _mh = Number(simulation.lambdas?.home);
  const _ma = Number(simulation.lambdas?.away);
  const _dcW = Math.min(1, Math.max(0, Number(blendResult.dcWeight) || 0));
  let scoreModel;
  if (blendResult.dcResult && Number.isFinite(_mh) && Number.isFinite(_ma)
      && _dcEg && Number.isFinite(_dcEg.home) && Number.isFinite(_dcEg.away)) {
    const lamH = ((1 - _dcW) * _mh + _dcW * _dcEg.home) * _lamScale;
    const lamA = ((1 - _dcW) * _ma + _dcW * _dcEg.away) * _lamScale;
    scoreModel = buildDerivedScoreModel(lamH, lamA);
    if (scoreModel && blendResult.dcResult.source) scoreModel.source = blendResult.dcResult.source;
  } else {
    scoreModel = blendResult.dcResult
      ?? buildDerivedScoreModel((simulation.lambdas?.home ?? 0) * _lamScale, (simulation.lambdas?.away ?? 0) * _lamScale);
  }
  // 上报给自检/让球/日报的 expectedGoals 与比分用的同一 λ(收缩后),保证 λ 物理闸门核到的就是真用值。
  const reconciledExpectedGoals = scoreModel?.expectedGoals ?? blendResult.dcResult?.expectedGoals ?? null;
  // λ 物理上限闸门前置(2026-06-01 P3):算完 scoreModel/reconciledExpectedGoals 后立即体检——
  //   单队 λ>4.0 或合计>5.5 = 非物理(DC 强队对鱼腩 λ 偶尔冲到 4+),后续 handicap/比分/半全场
  //   连带失真。直接判该场 unpredictable(沿用 data-missing 结构),不再往下算。复用 pre-export 同阈值。
  const _lamH = Number(reconciledExpectedGoals?.home);
  const _lamA = Number(reconciledExpectedGoals?.away);
  if (Number.isFinite(_lamH) && Number.isFinite(_lamA)
      && (_lamH > LAMBDA_SIDE_BLOCK || _lamA > LAMBDA_SIDE_BLOCK || (_lamH + _lamA) > LAMBDA_TOTAL_BLOCK)) {
    return {
      fixture,
      unpredictable: true,
      provenance: blendResult.blendSource,
      dataMissingReason: `λ超物理上限(主${_lamH.toFixed(2)}/客${_lamA.toFixed(2)}/合计${(_lamH + _lamA).toFixed(2)})——疑 λ 被算错放大,不预测(不出失真比分/让球)`,
      marketSnapshot: snapshot,
      probabilities: null,
      pick: null,
      secondaryPick: null,
      scorePicks: null,
      halfFullPicks: null,
      handicapPick: null
    };
  }
  const scorePicks = buildScorePicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, scoreModel);
  const halfFullPicks = buildHalfFullPicks(ranked[0].code, ranked[1].code, snapshot, probabilities, index, scorePicks, scoreModel, fixture?.competition);
  // 深度强化(2026-05-30 用户要求):给比分/半全场附真实概率 + 主方向内反超备选 + 完整分布,
  // 不再只给单一 argmax。所有附加量来自同一真泊松矩阵/半全场联合分布,可追溯、不破坏 wld 锚。
  enrichScoreAndHalfFull(scorePicks, halfFullPicks, scoreModel, ranked[0].code, fixture?.competition);
  // 分析模块强化(2026-06-01 用户要求"让球方向/比分/半全场分析模块强化技能"):
  //   全部从同一真泊松矩阵/半全场联合分布派生,零编造、不破坏 wld 锚。
  //   · 比分:总进球区间(0/1/2/3/4+)+ 集中度信心;· 半全场:反转风险/逆转/上半平打破率。
  if (scoreModel?.matrix) {
    scorePicks.deepAnalysis = totalGoalsBands(scoreModel.matrix);
  }
  {
    const _eg = scoreModel?.expectedGoals ?? blendResult.dcResult?.expectedGoals;
    const _hf = _eg && Number.isFinite(_eg.home) && Number.isFinite(_eg.away) ? halfFullJoint(_eg.home, _eg.away) : null;
    if (_hf) halfFullPicks.deepAnalysis = halfFullDepth(_hf);
  }
  // FF 档:从 dc matrix 派生扩展玩法(大小球/单双/上半场/亚盘/双胜彩/比分组/总进球)。
  // 缺 matrix 时 buildExtendedMarkets 自动返回 null,daily-report 据此决定是否输出该列。
  // 2026-05-31:训练 DC matrix 缺失(冷启动/借用/国际赛)时,退回 scoreModel.matrix(由本场 λ 构造,
  //   与比分/半全场同源),让大小球/单双/上半场等扩展玩法对**所有场**可用,而非只俱乐部赛有。
  const _extMatrix = scoreModel?.matrix ?? blendResult.dcResult?.matrix ?? null;
  const extendedMarkets = _extMatrix ? buildExtendedMarkets(_extMatrix) : null;
  // 大小球 isotonic 校准(自主小模型,overunder-calibration):模型 P(over2.5) 校准。
  // 回测证校准后 Brier 0.2508→0.2494;有市场盘口时市场更优 → 仅标注校准值 + 是否有盘口,
  // 由 daily-report 决定无盘口冷门场用校准值。profile 缺失则 calibrateOver25 返回 null,优雅降级。
  if (extendedMarkets?.overUnder?.["2.5"] && Number.isFinite(extendedMarkets.overUnder["2.5"].over)) {
    const cal = calibrateOver25(extendedMarkets.overUnder["2.5"].over);
    if (cal != null) {
      extendedMarkets.overUnder["2.5"].overCalibrated = round(cal);
      extendedMarkets.overUnder["2.5"].underCalibrated = round(1 - cal);
      extendedMarkets.overUnder["2.5"].calibration = {
        source: "overunder-isotonic",
        hasMarketLine: Boolean(tgNode),
        note: tgNode ? "有大小球盘口,优先市场" : "无盘口,用校准模型值",
      };
    }
  }
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
    // 让球玩法按"让球分析"出胜平负(2026-05-31 用户硬规则:让球的就根据让球分析胜负平)。
    //   让球后三态:让主胜(home 覆盖盘口)/走盘(push 退款)/让客胜(away 覆盖),直接把官方让球线
    //   套进真泊松比分矩阵的覆盖分布,argmax 即让球玩法推荐。**独立于比赛原始 wld**——胜平负玩法仍锚
    //   wld(不反推),这条只服务"让球"玩法本身,不改 pick/比分/半全场的 wld 派生。
    const hc = coverInfo?.cover;
    // 市场亚盘水位融合(2026-05-31 矫正,leak-safe 回测 15008 场 +1.49pp):亚盘是足球最 sharp
    //   的盘口,两路收盘水位去 vig → 市场隐含主/客覆盖比例,优于纯 DC-τ 矩阵覆盖(42.98%→44.47%)。
    //   保留模型的 push(走盘)质量(让球胜平负的真实可投注结果),仅把"非 push 内主客比例"换成市场。
    //   **守护:仅当亚盘水位对应的线 == 本次覆盖用的 handicapLine 时才融合**(否则市场比例对的是另一条
    //   线的覆盖问题,不可叠加)→ 官方竞彩整数线 ≠ 亚盘线 / 无两路水位时降级纯 DC-τ(零回归)。
    const handicapWld = hc ? (() => {
      const lh = Number(asianHandicapWater?.lateHome);
      const la = Number(asianHandicapWater?.lateAway);
      const waterLine = Number(asianHandicapWater?.line);
      const marketUsable = lh > 1 && la > 1
        && Number.isFinite(waterLine) && Math.abs(waterLine - handicapLine) < 1e-9;
      let dist = { home: Number(hc.home) || 0, push: Number(hc.push) || 0, away: Number(hc.away) || 0 };
      let wldSource = "dc-tau";
      if (marketUsable) {
        const rh = 1 / lh, ra = 1 / la;
        const mktHome = rh / (rh + ra);
        const push = dist.push;
        const nonPush = Math.max(0, 1 - push);
        dist = { home: nonPush * mktHome, push, away: nonPush * (1 - mktHome) };
        wldSource = "market-asian-water";
      }
      const opts = [
        { code: "3", label: "让球主胜", prob: dist.home },
        { code: "1", label: "走盘", prob: dist.push },
        { code: "0", label: "让球客胜", prob: dist.away },
      ].sort((a, b) => b.prob - a.prob);
      return {
        pick: opts[0].label,
        pickCode: opts[0].code,
        probability: round(opts[0].prob),
        probabilities: { home: round(dist.home), push: round(dist.push), away: round(dist.away) },
        ranked: opts.map((o) => ({ label: o.label, code: o.code, probability: round(o.prob) })),
        source: wldSource,
        modelCover: { home: round(Number(hc.home) || 0), push: round(Number(hc.push) || 0), away: round(Number(hc.away) || 0) },
      };
    })() : null;
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
      handicapWld,
      coverBreakdown: coverInfo?.cover ?? null,
      modelFairLine: coverInfo?.modelFairLine ?? null,
      // 让球强化(2026-06-01):多档盘口(-2~+2)覆盖率阶梯 + 模型公平线。
      //   国际赛/竞彩无让球盘(line=0)时也能告诉用户"模型认为该让几球 + 各盘口主胜/走盘/客胜覆盖"。
      ladder: scoreModel?.matrix ? handicapLadder(scoreModel.matrix) : null,
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
      expectedGoals: reconciledExpectedGoals,
      teamStrength: blendResult.dcResult?.teamStrength,
    } : null,
    ensembleView,
    simulation,
    marketSnapshot: snapshot,
    advancedFeatures,
    bankroll: null,
    pick: ranked[0],
    secondaryPick: ranked[1],
    // 双选(双重机会)建议:均势场覆盖平局风险(单选平命中物理上限~28%,见 computeDoubleChance)。
    doubleChance: computeDoubleChance(ranked, options.env ?? process.env),
    risk,
    confidence,
    // 纯市场隐含概率(去vig)—— 选择分层的 sharp 信号(回测证明优于模型信心)。
    marketImpliedProbabilities: oddsProbabilities ?? null,
    // 选择分层(2026-05-31):按市场隐含热门概率定档 + 回测实测命中率。用市场隐含;缺则退最终融合概率。
    selectionTier: selectionTier(Math.max(
      ...[(oddsProbabilities ?? probabilities)?.home, (oddsProbabilities ?? probabilities)?.draw, (oddsProbabilities ?? probabilities)?.away]
        .map(Number).filter(Number.isFinite)
    )),
    scorePicks,
    halfFullPicks,
    handicapPick,
    // 爆冷风险 + 诱盘/真实盘识别(2026-05-31 L2):开盘→收盘隐含概率 + 模型概率对照,
    //   输出热门翻车概率 + 赔率变化是诱盘还是真实体现 + 人读原因。只读提示,不改 wld 锚、不自动弃赛。
    upsetTrap: analyzeUpsetTrap({
      opening: fusionContext.openingOdds ?? null,
      closing: oddsProbabilities ?? null,
      model: probabilities ?? null,
    }),
    // 永久记忆召回(2026-06-01):本场所属联赛/热门档的模型历史真实命中率(诚实自知,样本不足标 insufficient)。
    //   只读附注,不改 wld/概率;盘上无记忆则 null。
    memoryRecall: options.modelMemory
      ? recallSegmentPerformance(options.modelMemory, { competition: fixture.competition, probabilities, confidence })
      : null,
    // 国家队 Elo 兜底用到时记录(实力差来源可追溯,诚实标注非 DC 拟合)。
    nationalElo: nationalEloUsed,
    // 让球胜平负(竞彩独立玩法,与14场/任选9的胜负平不同;深盘让球场常**只开此盘、不开胜平负**)。
    //   直接用真实让球赔率去vig → 隐含概率 + 推荐方向。sfcSold=胜平负(让0档)是否开售。
    jingcaiLetqiu: (() => {
      const hc = snapshot?.handicapOdds?.current ?? snapshot?.handicapOdds?.initial ?? null;
      if (!hc || !(Number(hc.home) > 1 && Number(hc.draw) > 1 && Number(hc.away) > 1)) return null;
      const p = probabilitiesFromOdds(hc);
      const order = [["home", "主胜", "3"], ["draw", "平局", "1"], ["away", "客胜", "0"]];
      const best = order.reduce((b, o) => (p[o[0]] > p[b[0]] ? o : b), order[0]);
      return { line: handicapLine, probabilities: p, pick: { code: best[2], label: best[1], probability: round(p[best[0]]) }, sfcSold: Boolean(oddsProbabilities) };
    })(),
    asianWaterAnalysis,
    extendedMarkets,
    expectedValue,
    // 经验库情境(2026-05-30):历史同联赛同档情境的真实结果分布,供透明展示 + 平局风险提示。
    experienceContext: experienceBaseline
      ? {
          source: experienceBaseline.source,
          n: experienceBaseline.n,
          avgGoals: experienceBaseline.avgGoals,
          historicalDrawRate: experienceBaseline.drawRate,
          wld: experienceBaseline.wld,
          // 平局风险:历史平局率高(≥28%)而本次未推平 → 提示(不改方向,遵 wld 锚定+不替用户弃赛)
          drawAlert:
            experienceBaseline.drawRate >= 0.28 && ranked[0].code !== "1"
              ? `⚠️ 历史同情境平局率 ${(experienceBaseline.drawRate * 100).toFixed(0)}%(${experienceBaseline.n}场),平局风险偏高,可考虑兼顾平局`
              : null,
          // 大小球经验(2026-05-30/31):历史同情境真实总进球分布 → 大小球倾向(只提示,不替用户弃赛/不改 wld 锚)。
          // 留出回测(轮5)证大小球**联赛级最准**、热门档细分过拟合 → hint 优先用联赛级(n大稳),无则退桶级。
          overUnder: experienceBaseline.leagueOverUnder?.overUnder ?? experienceBaseline.overUnder ?? null,
          overUnderHint: experienceBaseline.leagueOverUnder
            ? buildOverUnderHint(experienceBaseline.leagueOverUnder.overUnder, experienceBaseline.leagueOverUnder.n)
            : buildOverUnderHint(experienceBaseline.overUnder, experienceBaseline.n),
          // 赔率漂移经验(2026-05-30):历史"同联赛+热门方+开→收漂移方向"的真实 WLD,
          // 学"赔率变化→结果"。只在开盘+收盘双价齐全时出;纯透明展示,不改 wld 锚。
          drift: experienceBaseline.drift ?? null,
          driftHint: buildDriftHint(experienceBaseline.drift),
        }
      : null,
    rationale: buildReason(fixture, snapshot, ranked[0], ranked[1], risk)
  };
  prediction.bankroll = buildBankrollRisk(prediction, options.env ?? process.env);
  // 市场背离置信门(2026-05-31 接生产)—— 实证(signal-crossval 回测):模型与市场分歧越大、市场赢越多,
  //   逆市场押独门=陷阱。此处把 clv-confidence-gate 接进每场预测,**只附加**背离标签 + 建议降档系数,
  //   遵 [[feedback_confidence_not_autosuppress]]:不改 pick、不覆盖 confidence、不抑制玩法,买不买由用户定。
  prediction.marketDivergence = computeMarketDivergence(prediction);
  // 联赛专家门控(2026-05-31):复用 ratingsBootstrap 已拟合的 hierarchical,取本联赛样本量+收缩权重,
  //   透明告诉用户"这场结论有多少是本联赛数据撑的、多少靠大模型兜底"(回测证分层收缩 -0.0099 LogLoss)。
  prediction.leagueExpert = options.ratingsBootstrap?.hierarchical
    ? leagueExpertFromFitted(options.ratingsBootstrap.hierarchical, fixture?.competition)
    : null;
  // 逐场差异化分析(2026-05-31):按 联赛性质×实力差×盘口深度 归原型,挑本场主导逻辑,
  //   替代旧固定模板 buildReason/generateExplanation。挂已算字段,零假编。
  prediction.differentialAnalysis = analyzeMatch(prediction);
  if (prediction.differentialAnalysis?.narrative) prediction.rationale = prediction.differentialAnalysis.narrative;
  // 红队自检(2026-06-01 P1/P2,落实 prompt <red_team> 硬规则):三条反问,只下调信心/加风险标签,
  //   不改 pick/概率方向(遵 wld 锚定 + 不替用户弃赛)。挂 prediction.redTeam + riskNotes。
  redTeamCheck(prediction, {
    blendSource: blendResult.blendSource,
    hasMarketPrior: Boolean(oddsProbabilities),
    analogWld: experienceBaseline?.wld ?? null,
    calibrationPriorProb: calibrated.priorProb,
    calibrationDelta: calibrated.delta,
  });
  const consistencyErrors = validatePredictionConsistency(prediction);
  if (consistencyErrors.length) throw new Error(`推荐派生市场冲突：${fixture.homeTeam} 对 ${fixture.awayTeam}；${consistencyErrors.join("；")}`);
  return prediction;
}

// 红队自检(2026-06-01,落实 prompt <red_team>):对已算好的预测做三条对抗性反问,命中则下调信心 +
//   加风险标签。**只附加/降信心,不改 pick.code/概率方向**(遵 wld 锚定 + 不替用户弃赛硬规则)。
//   结果挂 prediction.redTeam = { flags, note },并把标签并入 prediction.riskNotes。
//   信心下调后强制夹到 [0,100]。
export function redTeamCheck(prediction, ctx = {}) {
  const flags = [];
  let confidenceDelta = 0;
  let directionNote = null;
  // (a) 单一来源:provenance=dixon-coles-only 且无赔率印证 → 信心 -10pp。
  if (ctx.blendSource === "dixon-coles-only" && !ctx.hasMarketPrior) {
    flags.push("⚠单一来源(无市场印证)");
    confidenceDelta -= 10;
  }
  // (b) 历史类比(同情境历史 WLD,即 historical-analog/KNN)方向与 argmax(pick.label) 反向 → 信心 -5pp。
  //     analogWld={home,draw,away} 经验频率;取其 argmax 与本场 pick.code 比,反向(且不为平局)即分歧。
  const analog = ctx.analogWld;
  const pickCode = prediction?.pick?.code;
  if (analog && Number.isFinite(analog.home) && Number.isFinite(analog.away) && pickCode) {
    const analogRanked = [
      { code: "3", p: Number(analog.home) },
      { code: "1", p: Number(analog.draw) },
      { code: "0", p: Number(analog.away) },
    ].sort((a, b) => b.p - a.p);
    const analogTop = analogRanked[0].code;
    // 反向:类比主推与本场主推不一致(平局视为不同方向,但 1↔1 不算反向)。
    if (analogTop !== pickCode) {
      flags.push("⚠类比反向");
      confidenceDelta -= 5;
      directionNote = "分歧·中信心";
    }
  }
  // (c) 校准前后 argmax 概率跳变 >10pp → 加"校准过度自信"标签(不再额外降信心,标签即提示)。
  if (Number.isFinite(ctx.calibrationDelta) && Math.abs(ctx.calibrationDelta) > 0.10) {
    flags.push("⚠校准过度自信");
  }
  if (Number.isFinite(confidenceDelta) && confidenceDelta !== 0 && Number.isFinite(prediction.confidence)) {
    prediction.confidence = Math.max(0, Math.min(100, prediction.confidence + confidenceDelta));
  }
  const note = flags.length
    ? `红队自检命中${flags.length}条:${flags.join("、")}${confidenceDelta ? `(信心${confidenceDelta}pp)` : ""}`
    : "红队自检通过(无对抗性疑点)";
  prediction.redTeam = {
    flags,
    note,
    confidenceDelta,
    directionNote,
    priorProb: ctx.calibrationPriorProb ?? null,
    calibrationDelta: ctx.calibrationDelta ?? null,
  };
  prediction.riskNotes = [...(prediction.riskNotes ?? []), ...flags];
  return prediction.redTeam;
}

// 用本场欧赔(优先收盘 final → 当前 current → 开盘 initial,越接近收盘=市场金标准)算市场背离。
// 纯附加诚实信息:aligned(同向/次热/逆市)、divergence(模型比市场高几个 pp)、建议降档系数、tag。
// 无欧赔(深盘只开让球等)→ 返回 null,不臆造。
export function computeMarketDivergence(prediction) {
  const eo = prediction?.marketSnapshot?.europeanOdds;
  const odds = eo?.final ?? eo?.current ?? eo?.initial ?? null;
  if (!odds || !prediction?.pick?.code) return null;
  const result = marketDivergenceGate({
    pickCode: prediction.pick.code,
    probability: prediction.pick.probability,
    confidence: prediction.confidence,
    odds,
  });
  // 收盘价齐全时附带 CLV-就绪标记(下注价 vs 收盘价的对比由复盘 daily-recap 落实,这里只标方向)。
  return { ...result, closingAvailable: Boolean(eo?.final) };
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
function buildHalfFullPicks(code, secondaryCode, snapshot = null, probabilities = {}, index = 0, scorePicks = {}, dcResult = null, league = null) {
  const primaryScore = scorePicks.primary ?? bestScoreFromMatrix(dcResult?.matrix, code);
  const secondaryScore = scorePicks.secondary ?? bestScoreFromMatrix(dcResult?.matrix, secondaryCode);
  const primaryFromMarket = halfFullFromMarket(snapshot, code, new Set(), primaryScore);
  const primaryFromDc = primaryFromMarket ? null : halfFullFromDcResult(dcResult, code, new Set(), primaryScore, league);
  const exclusion = new Set([primaryFromMarket, primaryFromDc].filter(Boolean));
  const secondaryFromMarket = halfFullFromMarket(snapshot, secondaryCode, exclusion, secondaryScore);
  const secondaryFromDc = secondaryFromMarket ? null : halfFullFromDcResult(dcResult, secondaryCode, exclusion, secondaryScore, league);
  const source = primaryFromMarket ? "market" : (dcResult?.expectedGoals ? "poisson-half-joint" : "none");
  return {
    primary: primaryFromMarket ?? primaryFromDc ?? halfFullFromDcResult(dcResult, code, new Set(), primaryScore, league),
    secondary: secondaryFromMarket ?? secondaryFromDc ?? halfFullFromDcResult(dcResult, secondaryCode, new Set(), secondaryScore, league),
    source
  };
}

// 深度强化:给比分/半全场附概率 + 分布 + 主方向内"不同首半场"反超备选(真实矩阵派生,可追溯)。
function enrichScoreAndHalfFull(scorePicks, halfFullPicks, scoreModel, primaryCode, league = null) {
  const matrix = scoreModel?.matrix ?? null;
  scorePicks.primaryProbability = scoreProbFromMatrix(matrix, scorePicks.primary);
  scorePicks.secondaryProbability = scoreProbFromMatrix(matrix, scorePicks.secondary);
  scorePicks.distribution = topScoresWithProb(matrix, 8); // 2026-06-01 5→8:均势客胜场客胜比分概率分散,Top5 常只够 1 个 wld 一致比分(治"保黑只显示 0-1"),取 8 让各方向都凑得齐 Top3
  const eg = scoreModel?.expectedGoals;
  // 半全场联合分布(2026-05-31 升级,walk-forward 回测最优:τ低分修正+拟合半场比例+状态依赖 chase=0.18,
  //   LogLoss 1.9069→1.9039 / Brier 0.8136→0.8129;参数见 halftime-fulltime-model.HF_DEFAULTS)。
  const hfDist = eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)
    ? hfDistribution(eg.home, eg.away, league)
    : null;
  halfFullPicks.primaryProbability = hfDist?.[halfFullPicks.primary] != null ? round(hfDist[halfFullPicks.primary]) : null;
  halfFullPicks.secondaryProbability = hfDist?.[halfFullPicks.secondary] != null ? round(hfDist[halfFullPicks.secondary]) : null;
  // 主方向内的反超/不同首半场备选(如主胜场的"平局-主胜"慢热反超),挖出被单 argmax 埋没的二线路径
  halfFullPicks.primaryAlt = bestDistinctFirstHalfHalfFull(hfDist, primaryCode, halfFullPicks.primary);
  halfFullPicks.distribution = topHalfFull(hfDist, 4);
  // 信心分层板块(2026-06-02 通宵 cycle10,回测证高信心档命中率显著更高:半全场≥40%档命中43.2% vs 均27%):
  //   按首选概率贴档+该档实测命中率+是否够格胆码。只贴档不弃赛(feedback-confidence-not-autosuppress)。
  scorePicks.confidenceTier = scoreConfidenceTier(scorePicks.primaryProbability);
  halfFullPicks.confidenceTier = halfFullConfidenceTier(halfFullPicks.primaryProbability);
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
export function halfFullFromDcResult(dcResult, code, excluded = new Set(), score = "", league = null) {
  if (!dcResult?.expectedGoals) return null;
  // 多路集成半全场(model_notau 80%+经验 20%,回测 LL 1.9624→1.9488);profile 缺则回退 halfFullJoint。
  const probs = hfDistribution(dcResult.expectedGoals.home, dcResult.expectedGoals.away, league);
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
    // 2026-05-31:排序主键改用**市场隐含热门概率**(回测证明是 sharp 的选择信号,优于模型信心),
    //   模型信心/gap 作次级。让任选9 优先纳入市场最有把握的 9 场。
    .sort((a, b) =>
      (b.prediction.selectionTier?.marketFavProb ?? 0) - (a.prediction.selectionTier?.marketFavProb ?? 0)
      || b.prediction.confidence - a.prediction.confidence
      || b.gap - a.gap)
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

    // 任选 9 胆门槛:置信 ≥50 + 概率差 ≥22% + **市场隐含热门概率 ≥0.65**(bankerEligible,
    //   回测档内命中≥73% 才够格单选搏胆);避免把市场 coin-flip 场当胆。
    const isBanker = gap >= 0.22 && prediction.confidence >= 50
                     && prediction.risk !== "高" && singleCode !== "1"
                     && prediction.selectionTier?.bankerEligible === true;
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
      // 选择分层(市场隐含概率定档 + 回测实测命中率),供集中胆码/单选用
      tier: prediction.selectionTier?.label ?? null,
      tierBacktestHit: prediction.selectionTier?.backtestHit ?? null,
      marketFavProb: prediction.selectionTier?.marketFavProb ?? null,
      reason: `${prediction.selectionTier ? `${prediction.selectionTier.label}(市场热门${Math.round((prediction.selectionTier.marketFavProb ?? 0) * 100)}%·回测命中~${Math.round((prediction.selectionTier.backtestHit ?? 0) * 100)}%)；` : ""}${singleNote ? singleNote + "；" : ""}${coverageReason}；${prediction.rationale ?? ""}`
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
  // 最优票(2026-05-31):给定注数预算,在 9 腿上最优分配胆/双/全,最大化整票全中概率。
  //   回测证同预算下比朴素双弱腿全中率更高且更省(5.44%→5.79%/64注→54注)。预算可由 env 调。
  const ticketBudget = Number(process.env.RENXUAN9_BUDGET ?? 64);
  const optTicket = optimizeTicket(
    ranked.map(({ prediction }) => ({
      probs: [prediction.probabilities?.home, prediction.probabilities?.draw, prediction.probabilities?.away],
      codes: ["3", "1", "0"],
    })),
    { budget: ticketBudget }
  );
  const optimizedTicket = {
    budget: ticketBudget,
    cost: optTicket.cost,
    jointHitProb: optTicket.jointHitProb,
    allSingleHitProb: optTicket.baselineHitProb,
    legs: optTicket.legs.map((l, i) => ({
      match: picks[i]?.match ?? "",
      type: l.type,
      cover: l.codes.map(outcomeCodeToChinese).join("/"),
      coveredProb: l.coveredProb,
    })),
  };
  return {
    ok: true,
    needCorrect: 9,
    optimizedTicket,
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

// 大小球经验提示:历史同情境真实总进球分布 → 给 2.5 球盘口的大/小球倾向(只提示,不替用户决策)。
// 阈值留缓冲(≥58% 才标方向),样本不足(<30)只给均值不下结论。
function buildOverUnderHint(ou, n) {
  if (!ou || !Number.isFinite(ou.over25) || !Number.isFinite(n)) return null;
  const o25 = Math.round(ou.over25 * 100);
  const u25 = 100 - o25;
  const avg = ou.avgTotal != null ? ou.avgTotal.toFixed(2) : "?";
  if (n < 30) return `📊 历史同情境均总进球 ${avg}(样本${n}场偏少,大小球仅供参考)`;
  if (ou.over25 >= 0.58) return `📈 历史同情境大球(>2.5)${o25}%、均${avg}球(${n}场),偏大球`;
  if (ou.over25 <= 0.42) return `📉 历史同情境小球(<2.5)${u25}%、均${avg}球(${n}场),偏小球`;
  return `📊 历史同情境大球(>2.5)${o25}%、均${avg}球(${n}场),大小球均衡`;
}

// 赔率漂移经验提示:历史"该联赛+热门方+开→收漂移方向"的真实 WLD → 给"赔率变化→结果"的透明读数。
// side=home 时 wld.home 即热门(主队)兑现率;side=away 时热门兑现率 = wld.away。只提示不改方向。
function buildDriftHint(drift) {
  if (!drift || !drift.wld || !Number.isFinite(drift.n)) return null;
  const favRate = Math.round((drift.side === "away" ? drift.wld.away : drift.wld.home) * 100);
  const favLabel = drift.side === "away" ? "客队(热门)" : "主队(热门)";
  const move =
    drift.driftBand === "热门走强"
      ? "赔率收盘比开盘更看好热门(被加注)"
      : drift.driftBand === "热门走弱"
      ? "赔率收盘转冷、热门被抛"
      : "开→收盘口平稳";
  return `🔀 历史同情境(${move}):${favLabel}兑现 ${favRate}%(${drift.n}场)`;
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
