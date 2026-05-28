/**
 * Survival Analysis 进球时间分布
 * ──────────────────────────────────────────────────
 * 用指数分布(Poisson 过程的等价)建模进球时间间隔:
 *
 *   T_next_goal ~ Exponential(λ/90)
 *   λ = 全场期望进球率,所以每分钟 hazard rate = λ/90
 *
 * 衍生:
 *   - P(进球发生在 [t1, t2]):F(t2) - F(t1) = e^(-λt1/90) - e^(-λt2/90)
 *   - P(上半场无进球):e^(-λ × 45/90) = e^(-λ/2)
 *   - 中场净胜球分布(用 Markov 已实现,这里给独立的 in-play 增强)
 *
 * 应用:
 *   - 半全场预测精化(上半场 / 下半场分别 Poisson)
 *   - in-play "下个 N 分钟进球" 概率(给玩 in-play 大小球用)
 *   - 红牌后剩余时间进球率重算(λ 折扣后)
 */

/**
 * @param {number} lambda 全场期望进球(双方合计或单队均可)
 * @param {Object} opts
 */
export function nextGoalProbability(lambda, opts = {}) {
  const from = opts.fromMinute ?? 0;
  const to = opts.toMinute ?? 90;
  const remainingMinutes = 90 - from;
  if (lambda <= 0 || remainingMinutes <= 0) return { ok: true, probability: 0 };

  // Rate per minute = λ/90
  const rate = lambda / 90;
  // P(进球发生在 from..to)= 1 - e^(-rate * (to - from)) 假设条件:还没进球
  const windowMinutes = Math.min(to, 90) - from;
  const p = 1 - Math.exp(-rate * windowMinutes);
  return { ok: true, probability: round(p), rate: round(rate), windowMinutes };
}

/**
 * 上半场 + 下半场 + 全场进球期望(简单半分;Markov 已经更精细).
 */
export function halfTimeFullTimeExpected(lambda, opts = {}) {
  const firstHalfShare = opts.firstHalfShare ?? 0.46;  // 经验
  return {
    firstHalfLambda: round(lambda * firstHalfShare),
    secondHalfLambda: round(lambda * (1 - firstHalfShare)),
    pNoGoalFirstHalf: round(Math.exp(-lambda * firstHalfShare)),
    pNoGoalSecondHalf: round(Math.exp(-lambda * (1 - firstHalfShare))),
    pNoGoalFullTime: round(Math.exp(-lambda))
  };
}

/**
 * In-play 概率:给当前分钟和当前 lambda(可能因红牌折扣),返回"下 N 分钟出球"概率.
 */
export function inPlayNextNGoalProbability(currentMinute, remainingLambda, nMinutes = 10) {
  const totalRemaining = Math.max(0, 90 - currentMinute);
  if (totalRemaining <= 0) return { ok: true, probability: 0 };
  const window = Math.min(nMinutes, totalRemaining);
  const ratePerMinute = remainingLambda / totalRemaining;
  return {
    ok: true,
    probability: round(1 - Math.exp(-ratePerMinute * window)),
    windowMinutes: window,
    ratePerMinute: round(ratePerMinute)
  };
}

/**
 * 从历史比赛进球时间(秒序列)拟合参数估计 lambda.
 * 输入:[{ goalMinute: 23, fixtureId }, ...]
 */
export function fitExponentialFromGoalTimes(goalTimes) {
  if (!Array.isArray(goalTimes) || goalTimes.length === 0) return null;
  const minutes = goalTimes.map((g) => Number(g.goalMinute)).filter(Number.isFinite);
  if (!minutes.length) return null;
  // 平均每场进球数(给定 fixture 数)
  const fixtureIds = new Set(goalTimes.map((g) => g.fixtureId));
  const fixtureCount = Math.max(1, fixtureIds.size);
  const avgGoalsPerMatch = minutes.length / fixtureCount;
  return {
    samples: minutes.length,
    fixtures: fixtureCount,
    avgGoalsPerMatch: round(avgGoalsPerMatch),
    estimatedLambda: round(avgGoalsPerMatch),
    avgGoalMinute: round(minutes.reduce((s, v) => s + v, 0) / minutes.length)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
