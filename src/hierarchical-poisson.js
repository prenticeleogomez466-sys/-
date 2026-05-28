/**
 * 简化版 Hierarchical Poisson(借鉴 penaltyblog)
 * ──────────────────────────────────────────────────
 * 完整版的 Hierarchical Bayesian Poisson 需要 MCMC(几千次采样,纯 JS 慢),
 * 这里做的是「2 层 EM-like shrinkage」简化:
 *
 *   1. 把样本按联赛分组(英超 / 西甲 / 解放者杯 / 国际赛 / 杯赛 / 中超...)
 *   2. 每个联赛独立估自己的 baseRate(联赛级进球率)和 homeAdvantage
 *   3. 全局 hyper-prior:跨联赛的 baseRate 均值和方差
 *   4. 低样本联赛(<minLeagueSamples)用 Bayesian shrinkage 把估计往全局均值收缩
 *
 * 物理意义:
 *   - 英超有 380 场/赛季,baseRate 估计很准 → 收缩弱
 *   - 国际友谊赛全年 ~50 场 → 收缩强,往全局 1.35 收
 *   - 解放者杯 ~60 场 → 中等收缩
 *
 * 用法:
 *   const profile = fitHierarchicalPoisson(matches);
 *   profile.getLeagueParams("英超");
 *   profile.predictGoals("英超", { homeAttack, homeDefense, awayAttack, awayDefense });
 */

const PRIOR_BASE_RATE = 1.35;
const PRIOR_HOME_ADV = 1.28;
const PRIOR_WEIGHT_MATCHES = 60;  // 等价于"虚拟样本数"

export function fitHierarchicalPoisson(matches, opts = {}) {
  const minLeagueSamples = opts.minLeagueSamples ?? 20;

  if (!Array.isArray(matches) || matches.length === 0) {
    return { ok: false, reason: "no-matches", leagues: {}, global: { baseRate: PRIOR_BASE_RATE, homeAdvantage: PRIOR_HOME_ADV } };
  }

  // 按联赛聚合
  const byLeague = new Map();
  for (const m of matches) {
    if (!Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
    const league = m.league ?? "unknown";
    if (!byLeague.has(league)) byLeague.set(league, []);
    byLeague.get(league).push(m);
  }

  // 估全局参数(用所有比赛)
  const all = matches.filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals));
  const globalHome = all.reduce((s, m) => s + m.homeGoals, 0) / Math.max(1, all.length);
  const globalAway = all.reduce((s, m) => s + m.awayGoals, 0) / Math.max(1, all.length);
  const globalBaseRate = (globalHome + globalAway) / 2;
  const globalHomeAdv = globalHome / Math.max(0.01, globalAway);

  // 每联赛单独估,加 shrinkage
  const leagueParams = {};
  for (const [league, leagueMatches] of byLeague.entries()) {
    const n = leagueMatches.length;
    const home = leagueMatches.reduce((s, m) => s + m.homeGoals, 0) / Math.max(1, n);
    const away = leagueMatches.reduce((s, m) => s + m.awayGoals, 0) / Math.max(1, n);
    const rawBase = (home + away) / 2;
    const rawAdv = home / Math.max(0.01, away);

    // Bayesian shrinkage: shrinkFactor = n / (n + prior_weight)
    const shrinkFactor = n / (n + PRIOR_WEIGHT_MATCHES);
    const shrunkBase = shrinkFactor * rawBase + (1 - shrinkFactor) * globalBaseRate;
    const shrunkAdv = shrinkFactor * rawAdv + (1 - shrinkFactor) * globalHomeAdv;

    leagueParams[league] = {
      samples: n,
      reliable: n >= minLeagueSamples,
      rawBaseRate: round(rawBase),
      rawHomeAdvantage: round(rawAdv),
      baseRate: round(shrunkBase),
      homeAdvantage: round(shrunkAdv),
      shrinkFactor: round(shrinkFactor)
    };
  }

  return {
    ok: true,
    samples: all.length,
    leagues: leagueParams,
    global: {
      baseRate: round(globalBaseRate),
      homeAdvantage: round(globalHomeAdv),
      samples: all.length
    },
    getLeagueParams(league) {
      const p = leagueParams[league];
      if (p) return p;
      // 未知联赛 → 全局先验
      return {
        samples: 0,
        reliable: false,
        baseRate: round(globalBaseRate),
        homeAdvantage: round(globalHomeAdv),
        shrinkFactor: 0,
        fromGlobal: true
      };
    },
    /**
     * 给定球队 attack/defense 系数和联赛,返回 λ_home / λ_away
     */
    predictGoals(league, params) {
      const lp = this.getLeagueParams(league);
      const ah = Number(params.homeAttack ?? 1);
      const dh = Number(params.homeDefense ?? 1);
      const aa = Number(params.awayAttack ?? 1);
      const da = Number(params.awayDefense ?? 1);
      const lambdaH = lp.baseRate * ah * da * lp.homeAdvantage;
      const lambdaA = lp.baseRate * aa * dh;
      return {
        league,
        leagueParams: lp,
        lambdaHome: round(lambdaH),
        lambdaAway: round(lambdaA),
        expectedGoals: round(lambdaH + lambdaA)
      };
    }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
