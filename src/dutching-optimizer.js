/**
 * Dutching / Kelly 组合仓位优化
 * ──────────────────────────────────────────────────
 * 给定一组互斥 outcome(如让 0 主胜/平/客胜),各有 probability + odds,
 * 用凯利准则算每个 outcome 的最优配仓比例.
 *
 * Dutching:对**多个互斥** outcome 同时下注,使无论哪个中都获得相同回报(保险风格).
 * Kelly :对**单个** outcome 最大化对数期望增长.
 * 这里:支持两种模式 + arbitrage 提示.
 */

/**
 * 单 outcome 凯利仓位
 *   f = (b*p - q) / b   其中 b = odds - 1,p = win prob,q = 1-p
 *   返回最优 fraction(0-1),负值 → 不下
 */
export function kellyFraction(probability, odds, opts = {}) {
  const p = Number(probability);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || p <= 0 || o <= 1) return 0;
  const b = o - 1;
  const q = 1 - p;
  const f = (b * p - q) / b;
  const fraction = opts.kellyFraction ?? 0.25;  // 1/4 Kelly 默认
  return Math.max(0, f * fraction);
}

/**
 * Dutching:输入互斥 outcomes(概率 + 赔率),返回各 outcome 的下注比例
 * 这样无论哪个中都得到相同回报.
 *
 *   保险 dutching: stake_i / odds_i = const → stake_i 与 1/odds_i 同步
 *
 * @param {Array} outcomes [{ label, probability, odds }]
 * @returns {{ ok, stakes, totalStake, expectedReturn, evPerUnit, recommendation }}
 */
export function dutchingStakes(outcomes, opts = {}) {
  const valid = outcomes.filter((o) => Number.isFinite(o.odds) && o.odds > 1);
  if (!valid.length) return { ok: false, reason: "no-valid-outcomes" };

  // 隐含概率:sum(1/odds);若 < 1 = arbitrage 机会
  const impliedSum = valid.reduce((s, o) => s + 1 / o.odds, 0);
  const isArbitrage = impliedSum < 1;

  // dutching stakes:stake_i = unitReturn / odds_i,使每个 outcome 中后回报相同
  // 总仓 = unitReturn × sum(1/odds_i) = unitReturn × impliedSum
  // 通常设 unitReturn = 100(单位 100 元保证回报)
  const unitReturn = opts.unitReturn ?? 100;
  const stakes = valid.map((o) => ({
    label: o.label,
    probability: o.probability,
    odds: o.odds,
    stake: round(unitReturn / o.odds),
    payoutIfWin: round(unitReturn)
  }));
  const totalStake = round(stakes.reduce((s, x) => s + x.stake, 0));
  const profitIfAnyWin = round(unitReturn - totalStake);

  // 期望值:sum(p_i × odds_i × stake_i) - totalStake
  // 但 stake_i = unitReturn / odds_i,所以 p_i × odds_i × stake_i = p_i × unitReturn
  // EV = unitReturn × sum(p_i) - totalStake
  const totalProb = valid.reduce((s, o) => s + (o.probability ?? 0), 0);
  const expectedReturn = round(unitReturn * totalProb);
  const ev = round(expectedReturn - totalStake);

  let recommendation;
  if (isArbitrage) recommendation = "🟢 套利(arbitrage)机会 — 总隐含概率 < 1,无论结果都赢";
  else if (ev > 0) recommendation = "🟢 期望盈利 — dutching 后正 EV";
  else if (ev > -totalStake * 0.05) recommendation = "🟠 期望接近 0 — dutching 用作保险可考虑";
  else recommendation = "🔴 期望明显亏 — vig 太高,不建议 dutching";

  return {
    ok: true,
    stakes, totalStake, profitIfAnyWin,
    impliedSum: round(impliedSum),
    isArbitrage,
    totalProb: round(totalProb),
    expectedReturn,
    ev,
    recommendation
  };
}

/**
 * 多腿凯利组合(串关):给定 N 腿,联合概率 ∏p, 联合赔率 ∏o,
 * 凯利公式给最优组合仓位.
 */
export function kellyCombo(legs, opts = {}) {
  if (!Array.isArray(legs) || !legs.length) return { ok: false, reason: "empty-legs" };
  const valid = legs.filter((l) => Number.isFinite(l.probability) && Number.isFinite(l.odds) && l.odds > 1);
  if (valid.length !== legs.length) return { ok: false, reason: "invalid-legs" };
  let combinedOdds = 1;
  let combinedProb = 1;
  for (const l of valid) {
    combinedOdds *= l.odds;
    combinedProb *= l.probability;
  }
  const f = kellyFraction(combinedProb, combinedOdds, opts);
  return {
    ok: true,
    legs: valid.length,
    combinedOdds: round(combinedOdds),
    combinedProbability: round(combinedProb),
    combinedEv: round(combinedProb * combinedOdds - 1),
    fullKelly: kellyFraction(combinedProb, combinedOdds, { kellyFraction: 1 }),
    halfKelly: kellyFraction(combinedProb, combinedOdds, { kellyFraction: 0.5 }),
    quarterKelly: f,
    recommendation: f > 0.02 ? "可下" : f > 0 ? "微仓位" : "凯利公式建议不下(负 EV 或 EV 太薄)"
  };
}

/**
 * Arbitrage 探测:多个市场源给的赔率,sum(1/odds_best) < 1 时存在套利
 */
export function detectArbitrage(outcomesByMarket) {
  const bestOdds = {};
  for (const market of outcomesByMarket) {
    for (const [outcome, odds] of Object.entries(market.odds ?? {})) {
      if (!Number.isFinite(odds) || odds <= 1) continue;
      if (!bestOdds[outcome] || odds > bestOdds[outcome].odds) {
        bestOdds[outcome] = { odds, source: market.source };
      }
    }
  }
  const impliedSum = Object.values(bestOdds).reduce((s, x) => s + 1 / x.odds, 0);
  return {
    bestOdds,
    impliedSum: round(impliedSum),
    isArbitrage: impliedSum < 1,
    arbitrageProfit: impliedSum < 1 ? round((1 - impliedSum) * 100) + "% per unit" : null
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
