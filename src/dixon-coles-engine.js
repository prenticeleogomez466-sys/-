/**
 * Dixon-Coles 独立概率引擎
 * ──────────────────────────────────────────────────
 * 修复缺口一：预测基底过度依赖赔率
 *
 * 当前 prediction-engine.js 的概率起点是 probabilitiesFromOdds()，
 * 模型上限被锁死在"比市场稍好一点"。
 *
 * 本模块从 fixture-store 的历史进球数据独立估计每队攻防力，
 * 产出完全不依赖赔率的概率。与赔率概率并列后，
 * 可用已有的 model-calibration 框架做融合。
 *
 * 接口设计完全匹配 prediction-engine.js 的数据结构：
 *   - 读取 fixture-store 的历史 fixtures（含 result）
 *   - 输出 { home, draw, away } 概率，与 probabilitiesFromOdds 格式一致
 *   - 输出完整比分矩阵，可替代/补充 monte-carlo-simulator
 *
 * 用法（在 prediction-engine.js 中）：
 *   import { fitFromFixtureStore, predictFromFitted } from "./dixon-coles-engine.js";
 *   const fitted = fitFromFixtureStore();  // 启动时调一次
 *   const dcProbs = predictFromFitted(fitted, fixture);
 */

import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { canonicalTeamName as canonicalTeamNameFromTable } from "./team-aliases.js";
import { annotateRegressedGoals } from "./shot-based-xg.js";

const MAX_GOALS = 8;
const OUTCOMES = ["home", "draw", "away"];

// ───── 公开 API ─────

/**
 * 从 fixture-store 的历史数据拟合 Dixon-Coles 模型参数。
 * 启动时调用一次，或每天 daily-evolution 开始时刷新。
 * @param {Object} opts
 *   opts.maxDates  最多回溯多少个比赛日（默认 120）
 *   opts.minMatches 最少需要多少场有赛果的比赛（默认 60）
 *   opts.iterations 迭代次数（默认 80）
 *   opts.homeAdvantage 主场优势初始值（默认 1.22，2026-06-05 由 1.24 再下调:backtest:homeadv 实证最优=1.22,主胜校准 gap 0.6pp→0.1pp,LogLoss/命中差在噪声内;主场优势持续下降趋势）
 *   opts.decayDays 时间衰减半衰期天数（默认 180。2026-05-31 在 51k 场扫 90/180/365/730:365 纯DC略优 RPS-0.0009但触发冷启动校准过度收缩守护回归,marginal 不值得→保留 180,见 sweep-dc-halflife.mjs）
 * @returns {Object} fitted 对象，传给 predictFromFitted
 */
export function fitFromFixtureStore(opts = {}) {
  // maxDates 默认 120→700(2026-06-01 回测调优):13.4 万库下 walk-forward(testDates40/1444场)实测
  //   窗口 120 命中 45.08%/Brier 0.6401 → 700 命中 48.56%/Brier 0.6217(+3.5pp/−0.018,单调改善);
  //   700≈1200≈2000(180天衰减令更老数据贡献≈0,故 700 即效率甜点,生产显式 2000 不变且实测等价)。
  //   修裸调隐患:render-recommendation-html 等裸调原走 120 弱窗 → 现自动享 700。
  const maxDates = opts.maxDates ?? 700;
  const minMatches = opts.minMatches ?? 60;
  const homeAdvantage = opts.homeAdvantage ?? 1.22;
  // beforeDate(可选):只用严格早于该日期的赛果拟合 —— 给 walk-forward 回测防数据泄漏用。
  const beforeDate = opts.beforeDate ?? null;
  const allDates = listFixtureDates();
  const dates = (beforeDate ? allDates.filter((d) => d < beforeDate) : allDates).slice(0, maxDates);
  const rawMatches = [];
  for (const date of dates) {
    const { fixtures } = loadFixtures(date);
    for (const f of fixtures) {
      if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
      rawMatches.push({
        home: canonicalName(f.homeTeam),
        away: canonicalName(f.awayTeam),
        homeGoals: f.result.home,
        awayGoals: f.result.away,
        date: f.date,
        league: f.competition ?? f.league ?? null, // per-league fit 路由用
      });
    }
  }
  // 时间衰减参考点:walk-forward 用预测日;否则用**最新有赛果**的日期。
  // 2026-05-31 修生产级 bug:旧式 referenceDate=dates[0](store 最新日期),而 store 含未来赛程
  //   (上市待赛的竞彩/14场,甚至 2099-12-31 占位)→ 基准被顶到未来 → 全部真实比赛 daysAgo 巨大、
  //   时间权重衰减≈0 → fit 不更新 → 球队系数全退回中性 1.0 → 生产 DC 球队层长期空转。
  //   prediction-engine 裸调 fitFromFixtureStore()(无 beforeDate)正中此坑;回测传 beforeDate 故未暴露。
  const referenceDate = beforeDate ?? rawMatches.reduce((mx, m) => (m.date > mx ? m.date : mx), "0000-00-00");
  const matches = rawMatches.map((m) => ({ ...m, daysAgo: daysBetween(m.date, referenceDate) }));
  // 2026-05-31 用户铁律「删掉所有兜底」:样本不足不再退回联赛先验凑一个"中性主场略优"的温吞 DC。
  //   直接 usable:false → predictFromFitted 返回 null → 该场无 DC 贡献;若同时无真实赔率,
  //   prediction-engine 标 unpredictable(不推荐)。要么真实强烈,要么不给,绝不凑数。
  if (matches.length < minMatches) {
    return { usable: false, coldStart: false, reason: `样本不足(${matches.length}/${minMatches}),不兜底凑数`, teams: {}, matches: matches.length, fittedAt: new Date().toISOString() };
  }
  const fitOpts = {
    iterations: opts.iterations ?? 80,
    homeAdvantage,
    decayDays: opts.decayDays ?? 180,
    shrinkageK: opts.shrinkageK ?? 2, // 经验贝叶斯收缩默认 K=2(backtest:shrinkage 实证:赛季初小样本 LogLoss +0.71%、全样本/命中率不劣化、只动低出场队)
    eloPriors: opts.eloPriors ?? null, // 可选 ClubElo 跨联赛先验作收缩锚(轮15-17,默认 null=收缩向 1.0)
    minLeagueMatches: opts.minLeagueMatches ?? 80,
    minMatches,
  };
  // per-league fit:walk-forward 回测(ALL_LEAGUES 32719场)证明与全局**无差异**
  //   (命中 48.48%↔48.51%、RPS 0.4244↔0.4245),全局拟合里球队 attack/defense 已吸收联赛进球差异。
  //   故默认走全局(简单);opts.perLeague===true 才用分联赛(函数 fitPerLeague 保留备用)。
  if (opts.perLeague === true) {
    const pl = fitPerLeague(matches, fitOpts);
    pl.fittedAt = new Date().toISOString();
    return pl;
  }
  const fitted = fit(matches, { ...fitOpts, decayHalfLife: fitOpts.decayDays });
  fitted.usable = true;
  fitted.coldStart = false;
  fitted.matches = matches.length;
  fitted.fittedAt = new Date().toISOString();
  return fitted;
}

/**
 * 从内存里的比赛数组拟合(给 walk-forward 回测 / football-data 等外部源用),
 * 与 fitFromFixtureStore 共用同一套冷启动兜底 + fit 逻辑。
 * @param {Array<{home,away,homeGoals,awayGoals,date}>} rawMatches
 * @param {{minMatches?,homeAdvantage?,referenceDate?,iterations?,decayDays?}} opts
 */
export function fitFromMatches(rawMatches = [], opts = {}) {
  const minMatches = opts.minMatches ?? 60;
  const homeAdvantage = opts.homeAdvantage ?? 1.22;
  const referenceDate = opts.referenceDate ?? rawMatches.reduce((mx, m) => (m.date > mx ? m.date : mx), "0000-00-00");
  // shot-regressed(分析师 P0):有 shots/SOT 时,把高方差的实际进球向射门期望回归去噪后再拟合,
  // 攻防强度更接近"潜在实力"而非"运气实现值"。转化率从训练切片自校准(walk-forward 不泄漏)。
  let source = rawMatches;
  let shotConversion = null;
  let shotApplied = 0;
  if (opts.goalSignal === "shot-regressed") {
    const annotated = annotateRegressedGoals(rawMatches, { weight: opts.shotWeight ?? 0.5 });
    if (annotated.applied > 0) {
      source = annotated.matches;
      shotConversion = annotated.conversion;
      shotApplied = annotated.applied;
    }
  }
  const matches = [];
  for (const m of source) {
    if (!Number.isFinite(Number(m.homeGoals)) || !Number.isFinite(Number(m.awayGoals))) continue;
    matches.push({
      home: canonicalName(m.home),
      away: canonicalName(m.away),
      homeGoals: Number(m.homeGoals),
      awayGoals: Number(m.awayGoals),
      date: m.date,
      daysAgo: daysBetween(m.date, referenceDate),
    });
  }
  if (matches.length < minMatches) {
    return { usable: false, coldStart: false, reason: `样本不足(${matches.length}/${minMatches}),不兜底凑数`, teams: {}, matches: matches.length, fittedAt: new Date().toISOString() };
  }
  const fitted = fit(matches, {
    iterations: opts.iterations ?? 80,
    homeAdvantage,
    decayHalfLife: opts.decayDays ?? 180,
    shrinkageK: opts.shrinkageK ?? 2, // 经验贝叶斯收缩默认 K=2(backtest:shrinkage 实证:赛季初小样本 LogLoss +0.71%、全样本/命中率不劣化、只动低出场队)
    eloPriors: opts.eloPriors ?? null, // 可选 ClubElo 跨联赛先验作收缩锚(轮15-17,默认 null=收缩向 1.0)
  });
  fitted.usable = true;
  fitted.coldStart = false;
  fitted.matches = matches.length;
  fitted.goalSignal = shotConversion ? "shot-regressed" : "actual";
  fitted.shotConversion = shotConversion;
  fitted.shotApplied = shotApplied;
  fitted.fittedAt = new Date().toISOString();
  return fitted;
}

// coldStartFit 已删除(2026-05-31 用户铁律「删掉所有兜底」):样本不足不再凑联赛先验/中性球队系数,
//   fitFromFixtureStore / fitFromMatches 的调用点改为直接返回 usable:false。

/**
 * 用拟合参数预测一场比赛。
 * 输出格式与 probabilitiesFromOdds 完全一致：{ home, draw, away }
 * @param {Object} fitted  fitFromFixtureStore() 的返回值
 * @param {Object} fixture 来自 fixture-store 的 fixture 对象
 * @returns {Object|null} 预测结果，或 null（球队不在训练集中）
 */
export function predictFromFitted(fitted, fixture, marketHints = null) {
  if (!fitted?.usable) return null;
  // per-league 路由(2026-05-31):按联赛分开拟合时,把该场路由到所属联赛的子模型
  //   (子模型与普通 fitted 同形 → 递归复用下面全部预测逻辑)。解决"20+异质联赛混在
  //   单一全局DC+强收缩→同联赛内队伍系数被冲平、各场预测雷同"的根因。
  if (fitted.perLeague) {
    const sub = resolvePerLeagueModel(fitted, fixture);
    return sub ? predictFromFitted(sub, fixture, marketHints) : null;
  }
  const home = canonicalName(fixture.homeTeam);
  const away = canonicalName(fixture.awayTeam);
  const th = fitted.teams[home];
  const ta = fitted.teams[away];

  // 用户硬性规则(2026-05-29):**删除冷启动 fallback**。
  // 之前没有训练数据时退回 attack=defense=1 + baseRate=1.3 → 所有场 λ ≈ 1.3 同质化,
  // 比分永远 2-1/1-0,模型推荐套路化"敷衍"。
  //
  // 现在:
  //   - 球队在训练集 → 用真 attack/defense 算 λ(正常路径)
  //   - 球队不在训练集 但 有亚盘/大小球 → 用市场推断 λ(λH = (total - line)/2, μA = (total + line)/2)
  //   - 都没有 → return null,上游降级到 odds-only / 不出推荐
  let attackHome, attackAway, defenseHome, defenseAway, baseRate, homeAdv;
  let marketDerivedLambda = null;
  let trainedTeams = Boolean(th && ta);
  if (trainedTeams) {
    attackHome = th.attack;       defenseHome = th.defense;
    attackAway = ta.attack;       defenseAway = ta.defense;
    baseRate = fitted.baseRate;
    homeAdv = fitted.homeAdvantage;
  } else if (marketHints) {
    const asianLine = Number(marketHints.asianLine);
    const totalGoals = Number(marketHints.overUnderLine ?? 2.55);
    if (Number.isFinite(asianLine) && Number.isFinite(totalGoals) && totalGoals > 0.5) {
      const lambdaH = Math.max(0.3, (totalGoals - asianLine) / 2);
      const muA = Math.max(0.3, (totalGoals + asianLine) / 2);
      // 2026-05-30 修复严重 bug:scoreMatrix 里 lambda = baseRate·attackHome·defenseAway,
      //   而 attackHome=defenseAway=ratio ⇒ lambda = baseRate·ratio²(ratio 被平方)。
      //   旧式 baseRate=(lambdaH+muA)/2、ratio=√(lambdaH/muA) 会让 lambda 远大于意图的 lambdaH
      //   (赫尔辛基 意图 2.27 → 实际 4.5),比分被灌成 4-0/5-0 全程领先。
      //   正确分解:baseRate=√(lambdaH·muA)、ratio=(lambdaH/muA)^¼,使
      //   lambda = baseRate·ratio² = lambdaH、mu = baseRate/ratio² = muA(数学严格还原)。
      const ratio = Math.pow(lambdaH / Math.max(0.01, muA), 0.25);
      baseRate = Math.sqrt(lambdaH * muA);
      attackHome = ratio;       defenseAway = ratio;
      attackAway = 1 / ratio;   defenseHome = 1 / ratio;
      homeAdv = 1;
      marketDerivedLambda = { home: lambdaH, away: muA };
    } else {
      return null;  // 无市场线索 → 拒绝出"假" DC 结果
    }
  } else {
    return null;
  }

  const { matrix, lambda, mu } = scoreMatrix({
    attackHome,
    defenseHome,
    attackAway,
    defenseAway,
    homeAdv,
    baseRate,
    rho: fitted.rho ?? -0.08,
    tauModel: fitted.tauModel ?? (process.env.DC_TAU_MODEL ?? "dixon-coles"),
  });

  const probs = outcomeProbs(matrix);
  return {
    source: marketDerivedLambda ? "dixon-coles:market-derived" : "dixon-coles",
    marketDerivedLambda: marketDerivedLambda ?? null,
    probabilities: probs,
    expectedGoals: { home: round(lambda), away: round(mu) },
    topScores: topScorelines(matrix, 6),
    overUnder: overUnderProbs(matrix, 2.5),
    matrix,
    teamStrength: trainedTeams ? {
      home: { attack: round(th.attack), defense: round(th.defense) },
      away: { attack: round(ta.attack), defense: round(ta.defense) },
    } : null,
  };
}

/**
 * 融合赔率概率与 Dixon-Coles 概率。
 * 设计为直接替换 prediction-engine.js 中 baseProbabilities 的取值逻辑。
 *
 * 命中率增益 · 第 3 层升级：
 *   dcWeight 不再固定 0.35，而是按联赛动态决定。
 *   - 五大联赛：赔率高度有效，dcWeight 偏低（市场已充分定价）
 *   - 冷门/低级别联赛：赔率定价不充分，dcWeight 偏高（独立模型更有价值）
 *   - 进一步可由 signal-weights-profile 的复盘表现微调
 *
 * @param {Object} oddsProbabilities  从赔率反推的 { home, draw, away }
 * @param {Object|null} dcResult      predictFromFitted() 的结果
 * @param {Object} opts
 *   opts.dcWeight    显式指定权重（给定则忽略动态计算）
 *   opts.competition 联赛名，用于动态权重
 *   opts.weightProfile signal-weights-profile，可选，按复盘表现微调
 * @returns {{probabilities, blendSource, dcWeight, dcResult}}
 */
export function blendWithOdds(oddsProbabilities, dcResult, opts = {}) {
  if (!dcResult) {
    return {
      probabilities: oddsProbabilities,
      blendSource: "odds-only",
      dcWeight: 0,
      dcResult: null,
    };
  }
  let w = opts.dcWeight != null ? opts.dcWeight : resolveDcWeight(opts.competition, opts.weightProfile);
  // 2026-05-31 删冷启动三折:DC 现在要么是真实拟合(usable)要么 null,不再有 coldStart 噪声档需要打折。
  w = clamp(w, 0, 0.6);
  const dc = dcResult.probabilities;
  // DC 方向与市场背离时压权贴市场(2026-06-07):记忆 reference_signal_backtest_findings 已证"分歧越大市场越对";
  //   今天国际赛实证——DC 无拟合数据时方向反(希腊赔率主胜→DC算客胜、克罗地亚主胜算5%),把市场 sharp 预测拉偏甚至反转。
  //   DC argmax≠市场 argmax → DC 对该场不可信 → w 压到 0.05 信市场。普适(不止国际赛),正常同向场权重不变。
  const _am = (p) => [["home", p.home ?? 0], ["draw", p.draw ?? 0], ["away", p.away ?? 0]].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const _diverged = _am(dc) !== _am(oddsProbabilities);
  if (_diverged) w = Math.min(w, 0.05);
  const blended = {};
  for (const key of OUTCOMES) {
    blended[key] = (1 - w) * (oddsProbabilities[key] ?? 1 / 3) + w * (dc[key] ?? 1 / 3);
  }
  return {
    probabilities: normalizeProbabilities(blended),
    blendSource: `odds(${round(1 - w)})+dixon-coles(${round(w)})`,
    dcWeight: round(w),
    dcResult,
  };
}

/**
 * 按联赛决定 Dixon-Coles 的融合权重。
 * 核心逻辑：赔率市场越成熟有效，独立模型权重越低。
 */
export function resolveDcWeight(competition, weightProfile) {
  const name = String(competition ?? "");
  let base;
  // 顶级联赛：赔率市场高度有效，独立模型权重低
  if (/英超|西甲|意甲|德甲|法甲|欧冠|英冠/.test(name)) {
    base = 0.22;
  // 次级成熟联赛：中等权重
  } else if (/荷甲|葡超|英甲|西乙|意乙|德乙|苏超|比甲|美职/.test(name)) {
    base = 0.34;
  // 冷门 / 低级别联赛：赔率定价不充分，独立模型更有价值
  } else if (/芬超|瑞典超|挪超|爱超|冰岛|韩K|日职|澳超|巴西|阿根廷/.test(name)) {
    base = 0.45;
  } else {
    // 未识别联赛：保守中位
    base = 0.35;
  }
  // 若复盘 profile 表明 Dixon-Coles 整体表现好/差，按其缩放因子微调
  const dcScale = weightProfile?.signals?.dixonColes?.scale;
  if (Number.isFinite(dcScale)) {
    base = clamp(base * dcScale, 0.1, 0.6);
  }
  return base;
}

// ───── Dixon-Coles 核心 ─────

// λ 物理上限:单队 90 分钟期望进球极少 > 4.5;小样本/回填国家队(德国打鱼腩)的 attack 会被
// 严重高估,不 clamp 会算出 λ≈12 → DC 矩阵峰值飙到 8-0 的失真比分(2026-05-30 修,根因来自
// 用户反馈"比分不准")。下限 0.15 防全 0 概率。clamp 只影响极端值,正常场次 λ∈[0.5,3] 不受影响。
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 4.5;
function clampLambda(value) {
  if (!Number.isFinite(value)) return 1.3;
  return Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, value));
}

export function scoreMatrix(p) {
  const lambda = clampLambda(p.baseRate * p.attackHome * p.defenseAway * p.homeAdv);
  const mu = clampLambda(p.baseRate * p.attackAway * p.defenseHome);
  const rho = p.rho ?? -0.08;
  const tauFn = p.tauModel === "extended" ? extendedTau : tau;
  // nbSize 有限正数 → 边缘用负二项(过离散,仅软赛事/国家队开);否则泊松(默认,俱乐部不变)。
  const nbSize = Number(p.nbSize);
  const pmf = (Number.isFinite(nbSize) && nbSize > 0) ? (k, lam) => nbPmf(k, lam, nbSize) : poissonPmf;
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const prob = pmf(h, lambda) * pmf(a, mu) * tauFn(h, a, lambda, mu, rho);
      matrix[h][a] = Math.max(prob, 0);
      total += matrix[h][a];
    }
  }
  if (total > 0) for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) matrix[h][a] /= total;
  return { matrix, lambda, mu };
}

// 原始 Dixon-Coles tau:仅对 (0,0), (0,1), (1,0), (1,1) 做修正,
// 把双低比分概率往 0-0/1-1 推。其他比分 tau = 1。
function tau(hg, ag, lambda, mu, rho) {
  if (hg === 0 && ag === 0) return 1 - lambda * mu * rho;
  if (hg === 0 && ag === 1) return 1 + lambda * rho;
  if (hg === 1 && ag === 0) return 1 + mu * rho;
  if (hg === 1 && ag === 1) return 1 - rho;
  return 1;
}

// 扩展 tau (Mar-Co / Sarmanov / Michels 2025 风格):
// 把 rho 影响延伸到 (0..2) × (0..2) 范围 9 个点,同时对高比分 (3+ vs 3+) 做反向微调。
// 数学动机:Michels 2025 证明 tau 不只能往低比分推,也能反向。这条对 Over/Under 玩法尤其有用 ─
// 当 rho < 0,模型本身偏向防守平局型;扩展 tau 让 (2,1)/(1,2) 也享受概率提升,
// 减弱"所有进球场都往 1-1 跑"的偏差。
function extendedTau(hg, ag, lambda, mu, rho) {
  // 原 4 点保持兼容
  if (hg === 0 && ag === 0) return 1 - lambda * mu * rho;
  if (hg === 0 && ag === 1) return 1 + lambda * rho;
  if (hg === 1 && ag === 0) return 1 + mu * rho;
  if (hg === 1 && ag === 1) return 1 - rho;
  // 新增 5 点(对称 + 折扣 0.5):(2,0)/(0,2)/(2,1)/(1,2)/(2,2)
  if (hg === 2 && ag === 0) return 1 + 0.5 * mu * rho;
  if (hg === 0 && ag === 2) return 1 + 0.5 * lambda * rho;
  if (hg === 2 && ag === 1) return 1 + 0.3 * rho;
  if (hg === 1 && ag === 2) return 1 + 0.3 * rho;
  if (hg === 2 && ag === 2) return 1 - 0.3 * rho;
  // 高比分 (3+, 3+):反向微调,补偿低比分增强后总和上偏
  if (hg >= 3 && ag >= 3) return 1 + 0.1 * rho;
  return 1;
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k));
}
// lgamma(Lanczos)— 供负二项 Γ(k+r) 用。
const _lgC = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = _lgC[0]; for (let i = 1; i < 9; i++) x += _lgC[i] / (z + i);
  const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
// 负二项 pmf:mean=mu, size=r(过离散 var=mu+mu²/r);r 非正/∞ 退化泊松。
// 国际/友谊赛进球过离散(49k leak-safe:r≈8 holdout 精确比分 logloss −0.03,与 DC τ 正交叠加),
// 仅软赛事/国家队路径开启(俱乐部 DC 自拟合参数,不开)。
export function nbPmf(k, mu, r) {
  if (!(r > 0) || !Number.isFinite(r)) return poissonPmf(k, mu);
  if (mu <= 0) return k === 0 ? 1 : 0;
  return Math.exp(lgamma(k + r) - lgamma(r) - logFactorial(k) + r * Math.log(r / (r + mu)) + k * Math.log(mu / (r + mu)));
}

const _lfCache = [0, 0];
function logFactorial(n) {
  if (n < _lfCache.length) return _lfCache[n];
  let v = _lfCache[_lfCache.length - 1];
  for (let i = _lfCache.length; i <= n; i++) { v += Math.log(i); _lfCache[i] = v; }
  return _lfCache[n];
}

function fit(matches, opts) {
  const iterations = opts.iterations;
  const homeAdvantage = opts.homeAdvantage;
  const halfLife = opts.decayHalfLife ?? 180;

  const teams = {};
  const ensure = (name) => { if (!teams[name]) teams[name] = { attack: 1, defense: 1 }; };
  matches.forEach((m) => { ensure(m.home); ensure(m.away); });

  let totalGoals = 0, totalWeightedMatches = 0;
  const appear = {}; // 每队加权出场数(= 有效样本量),供经验贝叶斯收缩用
  for (const m of matches) {
    const w = timeWeight(m.daysAgo, halfLife);
    totalGoals += (m.homeGoals + m.awayGoals) * w;
    totalWeightedMatches += w;
    appear[m.home] = (appear[m.home] ?? 0) + w;
    appear[m.away] = (appear[m.away] ?? 0) + w;
  }
  const baseRate = totalWeightedMatches > 0 ? totalGoals / (2 * totalWeightedMatches) : 1.35;

  for (let it = 0; it < iterations; it++) {
    const adjA = {}, adjD = {};
    for (const name of Object.keys(teams)) {
      adjA[name] = { actual: 0, expected: 0 };
      adjD[name] = { actual: 0, expected: 0 };
    }
    for (const m of matches) {
      const w = timeWeight(m.daysAgo, halfLife);
      const th = teams[m.home], ta = teams[m.away];
      const expH = baseRate * th.attack * ta.defense * homeAdvantage;
      const expA = baseRate * ta.attack * th.defense;
      adjA[m.home].actual += m.homeGoals * w; adjA[m.home].expected += expH * w;
      adjA[m.away].actual += m.awayGoals * w; adjA[m.away].expected += expA * w;
      adjD[m.away].actual += m.homeGoals * w; adjD[m.away].expected += expH * w;
      adjD[m.home].actual += m.awayGoals * w; adjD[m.home].expected += expA * w;
    }
    for (const name of Object.keys(teams)) {
      if (adjA[name].expected > 0) teams[name].attack *= damp(adjA[name].actual / adjA[name].expected);
      if (adjD[name].expected > 0) teams[name].defense *= damp(adjD[name].actual / adjD[name].expected);
    }
  }

  // 经验贝叶斯收缩(可选,opts.shrinkageK):低出场数球队的 attack/defense 向联赛均值 1.0
  // 收缩,强度随有效样本数 n 递减(shrink = n/(n+K))。升班马/赛季初样本少 → 估计噪声大,
  // 收缩防过拟合。K=0 关闭(默认,向后兼容)。2503.19095 警示收缩非灵丹 → 由 backtest:shrinkage 定 K。
  const K = opts.shrinkageK ?? 0;
  if (K > 0) {
    // 收缩锚:默认中性 1.0;若提供 opts.eloPriors[name]={attack,defense}(ClubElo 跨联赛先验,
    // 轮15-16),低出场队收缩向 Elo 先验而非 1.0 —— 升班马按真实弱实力而非平均队(轮8+Elo 协同)。
    // 无该队 Elo 先验(亚洲队/对不上名)则退回 1.0,向后兼容。eloPriors 缺省 → 全部 1.0=轮8 行为。
    const priors = opts.eloPriors ?? null;
    for (const name of Object.keys(teams)) {
      const n = appear[name] ?? 0;
      const shrink = n / (n + K);
      const prior = priors?.[name];
      const aAnchor = Number.isFinite(prior?.attack) ? prior.attack : 1;
      const dAnchor = Number.isFinite(prior?.defense) ? prior.defense : 1;
      teams[name].attack = aAnchor + (teams[name].attack - aAnchor) * shrink;
      teams[name].defense = dAnchor + (teams[name].defense - dAnchor) * shrink;
    }
  }

  return { teams, baseRate, homeAdvantage, rho: -0.08 };
}

/**
 * 按联赛分开拟合 DC(2026-05-31,per-league fit)。
 * 根因:单一全局 DC 把 20+ 异质联赛混拟合 + 跨联赛归一化 → 同联赛内队伍强弱被冲平
 *   (瑞超各场 DC 恒出主44/平25/客30)。每联赛独立拟合:① 各自 baseRate(联赛进球水平),
 *   ② attack/defense 相对**本联赛均值**归一(强弱浮现),③ 各自主场优势。
 * 样本不足联赛(< minLeagueMatches)不单独建模,其球队走全局兜底模型。
 * 返回对象带 perLeague:true,predictFromFitted 自动路由到所属联赛子模型。
 *
 * @param {Array<{home,away,homeGoals,awayGoals,daysAgo,league}>} matches  需含 league 字段
 */
export function fitPerLeague(matches, opts = {}) {
  const minLeagueMatches = opts.minLeagueMatches ?? 80;
  const minMatches = opts.minMatches ?? 60;
  const homeAdvantage = opts.homeAdvantage ?? 1.22;
  const fitOpts = {
    iterations: opts.iterations ?? 80,
    homeAdvantage,
    decayHalfLife: opts.decayDays ?? 180,
    shrinkageK: opts.shrinkageK ?? 2,
    eloPriors: opts.eloPriors ?? null,
  };

  // 规范化队名(与 fitFromMatches 一致;fit() 不自带规范化,漏了会导致子模型按原名建键、
  //   而 predictFromFitted 按 canonicalName 查 → 对不上恒 null)。
  const canon = matches.map((m) => ({ ...m, home: canonicalName(m.home), away: canonicalName(m.away) }));

  const byLeague = new Map();
  for (const m of canon) {
    const lg = m.league || "unknown";
    if (!byLeague.has(lg)) byLeague.set(lg, []);
    byLeague.get(lg).push(m);
  }

  const leagues = {};
  const teamLeague = {};
  for (const [lg, ms] of byLeague) {
    if (ms.length < minLeagueMatches) continue;
    const sub = fit(ms, fitOpts);
    sub.usable = true;
    sub.coldStart = false;
    sub.league = lg;
    sub.matches = ms.length;
    leagues[lg] = sub;
    for (const m of ms) { teamLeague[m.home] = lg; teamLeague[m.away] = lg; }
  }

  // 全局层:覆盖样本不足联赛 / 跨联赛(国际赛)/ 队名只在某场出现的场。
  // 2026-05-31 删兜底:全局样本不足不再凑冷启动联赛先验,直接 usable:false(该 perLeague 拟合整体降级,
  //   predictFromFitted 对应场返回 null → 无 DC 贡献,无赔率则上游标 unpredictable)。
  const global = canon.length >= minMatches
    ? Object.assign(fit(canon, fitOpts), { usable: true, coldStart: false, matches: canon.length })
    : { usable: false, coldStart: false, reason: `样本不足(${canon.length}/${minMatches}),不兜底凑数`, teams: {}, baseRate: undefined, matches: canon.length };

  return {
    usable: true,
    perLeague: true,
    leagues,
    teamLeague,
    global,
    // 向后兼容的扁平视图(部分调用方直接读 .teams/.baseRate)→ 用全局兜底值
    teams: global.teams ?? {},
    baseRate: global.baseRate,
    homeAdvantage,
    rho: -0.08,
    matches: matches.length,
    leagueCount: Object.keys(leagues).length,
    fittedAt: new Date().toISOString(),
  };
}

// 把一场比赛路由到所属联赛子模型;无法定位则回退全局兜底模型。
function resolvePerLeagueModel(fitted, fixture) {
  const home = canonicalName(fixture.homeTeam);
  const away = canonicalName(fixture.awayTeam);
  // 1) 优先按 fixture.competition 命中联赛子模型(两队都在该子模型里)
  const comp = fixture.competition ?? fixture.league;
  if (comp && fitted.leagues[comp]?.teams?.[home] && fitted.leagues[comp]?.teams?.[away]) {
    return fitted.leagues[comp];
  }
  // 2) 按 team→league 映射:两队同属一个有子模型的联赛
  const lgH = fitted.teamLeague[home];
  const lgA = fitted.teamLeague[away];
  if (lgH && lgH === lgA && fitted.leagues[lgH]) return fitted.leagues[lgH];
  // 3) 回退全局兜底(国际赛/跨联赛/样本不足联赛)
  return fitted.global?.usable ? fitted.global : null;
}

function timeWeight(daysAgo, halfLife) {
  if (!Number.isFinite(daysAgo) || daysAgo < 0) return 1;
  return Math.pow(0.5, daysAgo / halfLife);
}

function damp(ratio, factor = 0.5) {
  if (!isFinite(ratio) || ratio <= 0) return 1;
  return 1 + (ratio - 1) * factor;
}

// ───── 派生函数 ─────

function outcomeProbs(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      if (h > a) home += matrix[h][a];
      else if (h === a) draw += matrix[h][a];
      else away += matrix[h][a];
    }
  return { home: round(home), draw: round(draw), away: round(away) };
}

function overUnderProbs(matrix, line) {
  let over = 0, under = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      if (h + a > line) over += matrix[h][a]; else under += matrix[h][a];
    }
  return { line, over: round(over), under: round(under) };
}

function topScorelines(matrix, n) {
  const flat = [];
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++)
      flat.push({ score: `${h}-${a}`, probability: matrix[h][a] });
  return flat.sort((x, y) => y.probability - x.probability).slice(0, n)
    .map((s) => ({ score: s.score, probability: round(s.probability) }));
}

// ───── 工具函数 ─────

function canonicalName(value) {
  // \u590d\u7528 team-aliases \u7684\u5f52\u4e00\u5316:\u540c\u6e90\u961f\u540d(\u4e2d\u82f1\u6587/\u5199\u6cd5\u4e0d\u540c)\u80fd\u5339\u914d\u5230\u540c\u4e00\u4e2a key,
  // \u8fd9\u6837 Dixon-Coles \u62df\u5408\u65f6\u4e0d\u4f1a\u628a"\u62dc\u4ec1"\u548c"Bayern Munich"\u5f53\u6210\u4e24\u652f\u4e0d\u540c\u7403\u961f\u3002
  return canonicalTeamNameFromTable(value);
}

function normalizeProbabilities(values) {
  const total = OUTCOMES.reduce((sum, key) => sum + (values[key] ?? 0), 0);
  if (!Number.isFinite(total) || total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  const home = round(values.home / total), draw = round(values.draw / total);
  return { home, draw, away: round(1 - home - draw) };
}

function daysBetween(dateStr, refStr) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  const r = new Date(`${refStr}T00:00:00+08:00`);
  return Math.max(0, Math.round((r - d) / 86400000));
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round((v + Number.EPSILON) * 10000) / 10000; }
