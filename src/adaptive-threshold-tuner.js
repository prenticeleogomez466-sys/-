/**
 * Adaptive Threshold Tuner
 * ──────────────────────────────────────────────────
 * 根据 ledger 历史表现自动调阈值:
 *   - valueBet 阈值(目前固定 EV > 5%)
 *   - strong-value 阈值(目前固定 EV > 15%)
 *   - 串关最小 EV 阈值
 *   - 凯利分数(默认 0.25,可自适应)
 *
 * 算法:
 *   - 给一组阈值候选 [0.03, 0.05, 0.08, 0.10, 0.12]
 *   - 在 ledger 上模拟 "如果阈值是 X,只投通过的票" 的 ROI
 *   - 找 ROI 最高的阈值
 */

const DEFAULT_EV_CANDIDATES = [-0.02, 0, 0.02, 0.05, 0.08, 0.10, 0.12, 0.15];
const DEFAULT_KELLY_CANDIDATES = [0.10, 0.15, 0.20, 0.25, 0.33, 0.50];

/**
 * @param {Array} ledgerRows  必须有 ev, hit, primaryOdds (or modelProb)
 * @returns {{ bestEvThreshold, bestKellyFraction, summary }}
 */
export function tuneThresholds(ledgerRows, opts = {}) {
  const candidatesEv = opts.evCandidates ?? DEFAULT_EV_CANDIDATES;
  const minSamples = opts.minSamples ?? 30;
  const settled = (ledgerRows ?? []).filter((r) => (r.hit === true || r.hit === false) && Number.isFinite(Number(r.ev)));
  if (settled.length < minSamples) {
    return { ok: false, reason: `insufficient-settled:${settled.length}/${minSamples}` };
  }

  // 模拟每个阈值的 ROI
  const evResults = candidatesEv.map((threshold) => {
    const filtered = settled.filter((r) => Number(r.ev) >= threshold);
    if (!filtered.length) {
      return { threshold, count: 0, roi: -Infinity, hitRate: null, avgEvAtPick: null };
    }
    const stake = 1;
    let totalProfit = 0;
    let totalStake = 0;
    let wins = 0;
    for (const r of filtered) {
      const odds = Number(r.primaryOdds ?? 2.0);
      if (r.hit) {
        totalProfit += stake * (odds - 1);
        wins++;
      } else {
        totalProfit -= stake;
      }
      totalStake += stake;
    }
    return {
      threshold,
      count: filtered.length,
      hitRate: round(wins / filtered.length),
      roi: round(totalProfit / totalStake),
      avgEvAtPick: round(filtered.reduce((s, r) => s + Number(r.ev), 0) / filtered.length)
    };
  });

  const best = evResults
    .filter((r) => Number.isFinite(r.roi) && r.count >= 5)
    .sort((a, b) => {
      const roiDiff = b.roi - a.roi;
      if (Math.abs(roiDiff) > 0.005) return roiDiff;
      // ROI 平局 → 选阈值更高的(更保守,样本数差不多时)
      return b.threshold - a.threshold;
    })[0];

  // 凯利分数:用最佳 EV 阈值下的子集再调
  let bestKelly = null;
  if (best) {
    const winRate = best.hitRate;
    const avgOddsApprox = 1 + best.avgEvAtPick / winRate;
    const kellyResults = DEFAULT_KELLY_CANDIDATES.map((k) => {
      const b = avgOddsApprox - 1;
      const fullKelly = (winRate * b - (1 - winRate)) / Math.max(0.01, b);
      const stake = Math.max(0, fullKelly * k);
      // 长期增长率近似:winRate × log(1+b×stake) + (1-winRate) × log(1-stake)
      const growth = winRate * Math.log(1 + b * stake) + (1 - winRate) * Math.log(Math.max(0.001, 1 - stake));
      return { kellyFraction: k, stake: round(stake), growthRate: round(growth) };
    });
    bestKelly = kellyResults.sort((a, b) => b.growthRate - a.growthRate)[0];
  }

  return {
    ok: true,
    samples: settled.length,
    evCandidatesTested: candidatesEv,
    evResults,
    bestEvThreshold: best?.threshold ?? null,
    bestEvRoi: best?.roi ?? null,
    bestKellyFraction: bestKelly?.kellyFraction ?? null,
    recommendation: best ? `推荐 valueBet 阈值 EV >= ${best.threshold},历史 ROI ${(best.roi*100).toFixed(1)}%` : "样本不足"
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
