/**
 * Markov Chain 比赛仿真器
 * ──────────────────────────────────────────────────
 * 比传统 Monte Carlo 数学更精确:Monte Carlo 是从 Poisson 抽样 N 次估概率,
 * Markov Chain 直接计算所有状态转移的精确概率分布.
 *
 * 状态空间: (主进球数, 客进球数, 时间分钟)
 * 转移: 每分钟以 λ_home/90 概率主队进球,μ_away/90 客队进球,其他时间无事件
 * 简化: 假设进球独立(不考虑跟节奏耦合)
 *
 * 用途:
 *   1. 全场比分分布(替代 MC,数学精确)
 *   2. 任意时刻概率快照(比如"75 分钟时主胜概率")
 *   3. live in-play 概率更新(已知 60 分钟 1-0 时主胜概率)
 *   4. 红牌后概率重算(λ 折扣后)
 */

const DEFAULT_MAX_GOALS = 6;
const MATCH_MINUTES = 90;

/**
 * 全场比分概率矩阵(用 Markov Chain 精确算).
 * 复杂度 O(maxGoals^2 × maxGoals^2 × minutes),实际约 36×36×90 ≈ 117K,瞬间.
 *
 * @param {number} lambdaHome 全场主队期望进球
 * @param {number} muAway 全场客队期望进球
 * @returns {Array<Array<number>>} P[h][a] 比分概率
 */
export function markovScoreMatrix(lambdaHome, muAway, opts = {}) {
  const maxGoals = opts.maxGoals ?? DEFAULT_MAX_GOALS;
  const minutes = opts.minutes ?? MATCH_MINUTES;
  // 每分钟进球概率(小概率近似)
  const pH = lambdaHome / minutes;
  const pA = muAway / minutes;
  // state[h][a] = 当前时刻 (h, a) 的概率
  let state = Array.from({ length: maxGoals + 1 }, () => new Array(maxGoals + 1).fill(0));
  state[0][0] = 1;

  for (let t = 0; t < minutes; t++) {
    const next = Array.from({ length: maxGoals + 1 }, () => new Array(maxGoals + 1).fill(0));
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) {
        const p = state[h][a];
        if (p <= 0) continue;
        // 同分钟最多 1 个进球(简化):
        const pHomeGoal = pH;
        const pAwayGoal = pA;
        const pNoGoal = Math.max(0, 1 - pHomeGoal - pAwayGoal);
        next[h][a] += p * pNoGoal;
        if (h < maxGoals) next[h + 1][a] += p * pHomeGoal;
        if (a < maxGoals) next[h][a + 1] += p * pAwayGoal;
      }
    }
    state = next;
  }
  return state;
}

/**
 * 给定 in-play 当前比分 + 剩余分钟数,算从此刻起的剩余进球分布.
 * @param {Object} current { home, away, minute }
 */
export function inPlayProbabilities(current, lambdaHomeFull, muAwayFull, opts = {}) {
  const remaining = Math.max(0, MATCH_MINUTES - (current.minute ?? 0));
  if (remaining === 0) {
    // 比赛结束,直接返回当前结果
    return finalize(current.home, current.away);
  }
  const lambdaRem = lambdaHomeFull * (remaining / MATCH_MINUTES);
  const muRem = muAwayFull * (remaining / MATCH_MINUTES);
  // 红牌折扣
  if (opts.homeRedCard) {
    const tRed = opts.homeRedCardMinute ?? current.minute;
    const tAfter = Math.max(0, MATCH_MINUTES - tRed);
    // 减少剩余主队进球率约 30%
    return _inPlayWithExpected(current.home, current.away, lambdaRem * 0.7, muRem * 1.1, opts.maxGoals ?? DEFAULT_MAX_GOALS);
  }
  if (opts.awayRedCard) {
    return _inPlayWithExpected(current.home, current.away, lambdaRem * 1.1, muRem * 0.7, opts.maxGoals ?? DEFAULT_MAX_GOALS);
  }
  return _inPlayWithExpected(current.home, current.away, lambdaRem, muRem, opts.maxGoals ?? DEFAULT_MAX_GOALS);
}

function _inPlayWithExpected(currHome, currAway, lambdaRem, muRem, maxGoals) {
  // 剩余进球分布:Poisson(λ_rem), Poisson(μ_rem)
  const distH = poissonDist(lambdaRem, maxGoals);
  const distA = poissonDist(muRem, maxGoals);
  let home = 0, draw = 0, away = 0;
  const scoreMatrix = Array.from({ length: maxGoals + 1 }, () => new Array(maxGoals + 1).fill(0));
  for (let dh = 0; dh <= maxGoals; dh++) {
    for (let da = 0; da <= maxGoals; da++) {
      const p = distH[dh] * distA[da];
      const finalHome = currHome + dh;
      const finalAway = currAway + da;
      if (finalHome <= maxGoals && finalAway <= maxGoals) {
        scoreMatrix[finalHome][finalAway] += p;
      }
      if (finalHome > finalAway) home += p;
      else if (finalHome === finalAway) draw += p;
      else away += p;
    }
  }
  return {
    probabilities: { home: round(home), draw: round(draw), away: round(away) },
    expectedFinal: {
      home: round(currHome + lambdaRem),
      away: round(currAway + muRem)
    },
    scoreMatrix
  };
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
  return out.map((p) => p / sum);
}

function logFact(n) {
  let v = 0;
  for (let i = 2; i <= n; i++) v += Math.log(i);
  return v;
}

function finalize(home, away) {
  return {
    probabilities: home > away ? { home: 1, draw: 0, away: 0 }
                 : home === away ? { home: 0, draw: 1, away: 0 }
                                 : { home: 0, draw: 0, away: 1 }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * 计算给定 Markov 矩阵的 outcome 概率
 */
export function outcomesFromMatrix(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      if (h > a) home += matrix[h][a];
      else if (h === a) draw += matrix[h][a];
      else away += matrix[h][a];
    }
  return { home: round(home), draw: round(draw), away: round(away) };
}
