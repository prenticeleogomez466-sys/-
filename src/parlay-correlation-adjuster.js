/**
 * Parlay Correlation Adjuster
 * ──────────────────────────────────────────────────
 * 串关 EV 计算假设各场独立:joint_prob = ∏ p_i.
 * 实际同联赛/同时段/同球队类型的比赛存在相关性:
 *   - 同联赛多场都"大盘"或都"小盘" 倾向
 *   - 同球队周中-周末连场,form 延续
 *   - 同 sharp 信号:steam move 通常多场同向
 *
 * 修正:
 *   joint = ∏ p_i × (1 + Σ ρ_ij)
 *   其中 ρ_ij 是腿 i 和 j 的相关性 [-1, 1].
 *
 * 经验 ρ:
 *   同联赛 + 同 outcome 类型(都主胜):ρ = +0.05
 *   同联赛 + 反 outcome(主+客):ρ = -0.03
 *   同球队相邻场:ρ = +0.10(form 延续)
 *   同周末同时间:ρ = +0.02(联赛节奏共振)
 */

/**
 * @param {Array} legs [{ fixtureId, league, kickoffDate, outcome, probability, homeTeam, awayTeam }]
 * @returns {{ jointProbabilityIndependent, jointProbabilityCorrelated, adjustmentPct, correlations }}
 */
export function adjustParlayForCorrelation(legs) {
  if (!Array.isArray(legs) || legs.length < 2) {
    return { ok: false, reason: "need-2+-legs" };
  }
  const valid = legs.filter((l) => Number.isFinite(Number(l.probability)));
  if (valid.length < 2) return { ok: false, reason: "no-valid-probs" };

  // 独立联合概率
  const independent = valid.reduce((s, l) => s * Number(l.probability), 1);

  // 计算 pairwise correlations
  const correlations = [];
  let totalAdjustment = 0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const rho = pairwiseCorrelation(valid[i], valid[j]);
      if (rho !== 0) {
        correlations.push({
          legA: valid[i].fixtureId,
          legB: valid[j].fixtureId,
          rho: round(rho),
          reason: rho > 0 ? "positive correlation" : "negative correlation"
        });
        totalAdjustment += rho;
      }
    }
  }

  // 简化的修正:joint × (1 + total_adjustment * dampening)
  // dampening = 0.5(避免过度修正)
  const dampening = 0.5;
  const corrected = independent * (1 + totalAdjustment * dampening);
  // Clamp
  const clamped = Math.max(0, Math.min(1, corrected));

  return {
    ok: true,
    legs: valid.length,
    jointProbabilityIndependent: round(independent),
    jointProbabilityCorrelated: round(clamped),
    adjustmentPct: round((clamped - independent) / Math.max(0.001, independent)),
    totalCorrelationSum: round(totalAdjustment),
    correlations,
    narrative: buildCorrelationNarrative(totalAdjustment, correlations.length)
  };
}

function pairwiseCorrelation(legA, legB) {
  let rho = 0;
  const sameLeague = legA.league && legB.league && legA.league === legB.league;
  const sameDay = sameDateApprox(legA.kickoffDate, legB.kickoffDate);
  const sameTeam = legA.homeTeam === legB.homeTeam || legA.homeTeam === legB.awayTeam ||
                   legA.awayTeam === legB.homeTeam || legA.awayTeam === legB.awayTeam;
  const sameOutcomeType = legA.outcome === legB.outcome;

  if (sameLeague && sameOutcomeType) rho += 0.05;
  if (sameLeague && !sameOutcomeType) rho -= 0.03;
  if (sameTeam) rho += 0.10;
  if (sameDay) rho += 0.02;
  return rho;
}

function sameDateApprox(d1, d2) {
  if (!d1 || !d2) return false;
  const s1 = String(d1).slice(0, 10);
  const s2 = String(d2).slice(0, 10);
  return s1 === s2;
}

function buildCorrelationNarrative(totalAdjustment, count) {
  if (count === 0) return "腿间相互独立,串关概率按独立计算";
  if (totalAdjustment > 0.05) return `${count} 对腿正相关,串关命中概率被低估,实际略高于独立估计`;
  if (totalAdjustment < -0.05) return `${count} 对腿负相关,串关命中概率被高估,实际略低于独立估计`;
  return `${count} 对腿存在弱相关,影响在 ±5% 内`;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
