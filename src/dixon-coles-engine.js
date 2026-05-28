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
 *   opts.homeAdvantage 主场优势初始值（默认 1.28）
 *   opts.decayDays 时间衰减半衰期天数（默认 180）
 * @returns {Object} fitted 对象，传给 predictFromFitted
 */
export function fitFromFixtureStore(opts = {}) {
  const maxDates = opts.maxDates ?? 120;
  const minMatches = opts.minMatches ?? 60;
  const homeAdvantage = opts.homeAdvantage ?? 1.28;
  const dates = listFixtureDates().slice(0, maxDates);
  const matches = [];
  for (const date of dates) {
    const { fixtures } = loadFixtures(date);
    for (const f of fixtures) {
      if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
      matches.push({
        home: canonicalName(f.homeTeam),
        away: canonicalName(f.awayTeam),
        homeGoals: f.result.home,
        awayGoals: f.result.away,
        date: f.date,
        daysAgo: daysBetween(f.date, dates[0]),
      });
    }
  }
  // 冷启动兜底:样本不足时退回联赛先验,而不是直接 unusable
  // 这样 predictFromFitted 仍能输出合理的"中性主场略优"概率,
  // blendWithOdds 会按联赛权重把它与赔率融合,而不是完全跳过 DC 贡献。
  if (matches.length < minMatches) {
    return coldStartFit(matches, minMatches, homeAdvantage);
  }
  const fitted = fit(matches, {
    iterations: opts.iterations ?? 80,
    homeAdvantage,
    decayHalfLife: opts.decayDays ?? 180,
  });
  fitted.usable = true;
  fitted.coldStart = false;
  fitted.matches = matches.length;
  fitted.fittedAt = new Date().toISOString();
  return fitted;
}

/**
 * 冷启动模式拟合:
 *   - 样本 0 场:完全用联赛先验(baseRate=1.35, 主场=1.28, 球队全部中性 1.0)
 *   - 样本 1~minMatches-1 场:用 Bayesian shrinkage 把观测进球率与先验混合,
 *     主场优势保留默认值;不学习球队个体强度(避免少样本过拟合)。
 * predictFromFitted 在 fitted.teams[name] 缺失时会退回中性 1.0,
 * 所以这里只需提供 baseRate / homeAdvantage / rho 三个全局参数。
 */
function coldStartFit(matches, minMatches, homeAdvantage) {
  const PRIOR_GOALS_PER_TEAM = 1.35;
  const PRIOR_WEIGHT_MATCHES = Math.max(0, minMatches - matches.length);
  let baseRate = PRIOR_GOALS_PER_TEAM;
  if (matches.length > 0) {
    const observedGoals = matches.reduce((sum, m) => sum + m.homeGoals + m.awayGoals, 0);
    const observedHalfWeight = matches.length;
    baseRate =
      (PRIOR_GOALS_PER_TEAM * 2 * PRIOR_WEIGHT_MATCHES + observedGoals) /
      (2 * (PRIOR_WEIGHT_MATCHES + observedHalfWeight));
  }
  return {
    usable: true,
    coldStart: true,
    reason: `cold-start: ${matches.length}/${minMatches} 历史样本,使用联赛先验(baseRate=${round(baseRate)}, 主场=${homeAdvantage})`,
    teams: {},
    baseRate,
    homeAdvantage,
    rho: -0.08,
    matches: matches.length,
    fittedAt: new Date().toISOString(),
  };
}

/**
 * 用拟合参数预测一场比赛。
 * 输出格式与 probabilitiesFromOdds 完全一致：{ home, draw, away }
 * @param {Object} fitted  fitFromFixtureStore() 的返回值
 * @param {Object} fixture 来自 fixture-store 的 fixture 对象
 * @returns {Object|null} 预测结果，或 null（球队不在训练集中）
 */
export function predictFromFitted(fitted, fixture) {
  if (!fitted?.usable) return null;
  const home = canonicalName(fixture.homeTeam);
  const away = canonicalName(fixture.awayTeam);
  // 冷启动 / 球队不在训练集时,退回中性强度(1.0),仍可输出基于
  // baseRate + 主场优势的概率,而不是 return null 让上游降级到 odds-only。
  const th = fitted.teams[home] ?? { attack: 1, defense: 1, coldStart: true };
  const ta = fitted.teams[away] ?? { attack: 1, defense: 1, coldStart: true };
  const teamColdStart = Boolean(th.coldStart || ta.coldStart || fitted.coldStart);

  const { matrix, lambda, mu } = scoreMatrix({
    attackHome: th.attack,
    defenseHome: th.defense,
    attackAway: ta.attack,
    defenseAway: ta.defense,
    homeAdv: fitted.homeAdvantage,
    baseRate: fitted.baseRate,
    rho: fitted.rho ?? -0.08,
    tauModel: fitted.tauModel ?? (process.env.DC_TAU_MODEL ?? "dixon-coles"),
  });

  const probs = outcomeProbs(matrix);
  return {
    source: teamColdStart ? "dixon-coles:cold-start" : "dixon-coles",
    coldStart: teamColdStart,
    probabilities: probs,
    expectedGoals: { home: round(lambda), away: round(mu) },
    topScores: topScorelines(matrix, 6),
    overUnder: overUnderProbs(matrix, 2.5),
    teamStrength: {
      home: { attack: round(th.attack), defense: round(th.defense), coldStart: Boolean(th.coldStart) },
      away: { attack: round(ta.attack), defense: round(ta.defense), coldStart: Boolean(ta.coldStart) },
    },
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
  // 冷启动模式 DC 信号噪声大,把融合权重打三折,让赔率仍占主导。
  // 一旦样本积累通过 minMatches 门槛,coldStart=false,会自动恢复完整权重。
  if (dcResult.coldStart) w *= 0.3;
  w = clamp(w, 0, 0.6);
  const dc = dcResult.probabilities;
  const blended = {};
  for (const key of OUTCOMES) {
    blended[key] = (1 - w) * (oddsProbabilities[key] ?? 1 / 3) + w * (dc[key] ?? 1 / 3);
  }
  return {
    probabilities: normalizeProbabilities(blended),
    blendSource: `odds(${round(1 - w)})+dixon-coles${dcResult.coldStart ? ":cold-start" : ""}(${round(w)})`,
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

export function scoreMatrix(p) {
  const lambda = p.baseRate * p.attackHome * p.defenseAway * p.homeAdv;
  const mu = p.baseRate * p.attackAway * p.defenseHome;
  const rho = p.rho ?? -0.08;
  const tauFn = p.tauModel === "extended" ? extendedTau : tau;
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      const prob = poissonPmf(h, lambda) * poissonPmf(a, mu) * tauFn(h, a, lambda, mu, rho);
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
  for (const m of matches) {
    const w = timeWeight(m.daysAgo, halfLife);
    totalGoals += (m.homeGoals + m.awayGoals) * w;
    totalWeightedMatches += w;
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

  return { teams, baseRate, homeAdvantage, rho: -0.08 };
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
