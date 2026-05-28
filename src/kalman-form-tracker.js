/**
 * Kalman Filter Form Tracker
 * ──────────────────────────────────────────────────
 * 球队 form 不是固定的,会随时间漂移(教练变更/球员伤病/赛季压力).
 * Kalman filter 给每个球队维护一个 "真实 form" 估计 + 不确定性,
 * 每场新比赛作为 noisy observation 更新.
 *
 * 状态方程: form_t = form_{t-1} + w_t,  w_t ~ N(0, Q)
 * 观测方程: result_t = form_t + v_t,    v_t ~ N(0, R)
 *
 * Q 大 → 假设 form 漂移快(后期赛季 / 转会后);
 * R 大 → 假设单场观测噪声大(普遍比赛波动大).
 *
 * 经验值:
 *   Q ≈ 0.02(每月几场比赛,form 缓变)
 *   R ≈ 0.3(单场进球数 vs 真实 form 偏离方差)
 */

const DEFAULT_Q = 0.02;
const DEFAULT_R = 0.3;
const INITIAL_VARIANCE = 1.0;

/**
 * 创建一个 form tracker.
 * @param {Object} opts  Q, R, initialForm, initialVariance
 */
export function createKalmanFormTracker(opts = {}) {
  const Q = opts.Q ?? DEFAULT_Q;
  const R = opts.R ?? DEFAULT_R;

  const teamStates = new Map();  // team → { form, variance, observations }

  function ensure(team) {
    if (!teamStates.has(team)) {
      teamStates.set(team, {
        form: opts.initialForm ?? 0,
        variance: opts.initialVariance ?? INITIAL_VARIANCE,
        observations: 0,
        history: []
      });
    }
    return teamStates.get(team);
  }

  return {
    /**
     * 更新一场比赛:把 (gf - ga) 或自定义 form-related observation 喂给 filter.
     */
    observe(team, observation, date = null) {
      const s = ensure(team);
      // Predict step:state stays, variance grows
      const predictedVar = s.variance + Q;
      // Update step:Kalman gain K = predictedVar / (predictedVar + R)
      const K = predictedVar / (predictedVar + R);
      const innovation = Number(observation) - s.form;
      s.form = s.form + K * innovation;
      s.variance = (1 - K) * predictedVar;
      s.observations++;
      s.history.push({ date, observation, form: s.form, variance: s.variance, K });
      return { form: round(s.form), variance: round(s.variance), kalmanGain: round(K) };
    },

    /**
     * 当前球队的 form + 不确定性区间.
     */
    getState(team) {
      const s = teamStates.get(team);
      if (!s) return null;
      const std = Math.sqrt(s.variance);
      return {
        form: round(s.form),
        variance: round(s.variance),
        std: round(std),
        ci90: { lower: round(s.form - 1.645 * std), upper: round(s.form + 1.645 * std) },
        observations: s.observations
      };
    },

    /**
     * 比较两队 form 差 + 联合不确定性.
     */
    compare(homeTeam, awayTeam) {
      const h = this.getState(homeTeam);
      const a = this.getState(awayTeam);
      if (!h || !a) return null;
      const gap = h.form - a.form;
      const combinedStd = Math.sqrt(h.variance + a.variance);
      return {
        formGap: round(gap),
        combinedStd: round(combinedStd),
        gapCI90: { lower: round(gap - 1.645 * combinedStd), upper: round(gap + 1.645 * combinedStd) },
        gapStatisticallySignificant: Math.abs(gap) > 1.645 * combinedStd
      };
    },

    /**
     * Batch update:消费一系列(按时间排序的)比赛.
     */
    feedMatches(matches) {
      const sorted = [...matches].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const m of sorted) {
        if (!m.home || !m.away) continue;
        const gf = Number(m.homeGoals);
        const ga = Number(m.awayGoals);
        if (!Number.isFinite(gf) || !Number.isFinite(ga)) continue;
        this.observe(m.home, gf - ga, m.date);
        this.observe(m.away, ga - gf, m.date);
      }
      return this.dumpAllStates();
    },

    dumpAllStates() {
      const out = {};
      for (const team of teamStates.keys()) out[team] = this.getState(team);
      return out;
    }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
