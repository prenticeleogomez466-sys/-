/**
 * 赛程疲劳模型
 * ──────────────────────────────────────────────────
 * 球队连续比赛(休息天数少)→ 体能折扣 → form 下降.
 * 经验数据(英超 + 西甲):
 *   - 3 天间隔(周中欧战 + 周末联赛):form 折扣 ~5-8%
 *   - 5 天间隔:折扣 ~2-4%
 *   - 7 天间隔(标准):无折扣
 *   - 10+ 天间隔(国际比赛日后):略受益(球员休整)
 *
 * 进一步:
 *   - 客场旅途 + 短休息 = 复合折扣
 *   - 欧战次场(中场出战) > 国内比赛(局部疲劳)
 */

const FATIGUE_CURVE = [
  { days: 2, multiplier: 0.85 },  // 极度疲劳
  { days: 3, multiplier: 0.92 },
  { days: 4, multiplier: 0.96 },
  { days: 5, multiplier: 0.98 },
  { days: 6, multiplier: 0.99 },
  { days: 7, multiplier: 1.00 },
  { days: 10, multiplier: 1.01 }, // 略 fresh
  { days: 14, multiplier: 1.00 }  // 太长 form 不稳
];

/**
 * 给一个球队 + 上一场日期 + 本场日期,算疲劳系数.
 */
export function computeFatigueMultiplier(lastMatchDate, currentMatchDate, opts = {}) {
  if (!lastMatchDate || !currentMatchDate) return 1.0;
  const last = new Date(`${String(lastMatchDate).slice(0, 10)}T00:00:00Z`).getTime();
  const curr = new Date(`${String(currentMatchDate).slice(0, 10)}T00:00:00Z`).getTime();
  const days = Math.floor((curr - last) / 86400000);
  if (!Number.isFinite(days) || days < 0) return 1.0;
  // 找最近的 curve point
  let mult = 1.0;
  for (const point of FATIGUE_CURVE) {
    if (days <= point.days) { mult = point.multiplier; break; }
  }
  // 远端
  if (days > 14) mult = 0.97;  // 太久没比赛节奏不稳

  // 客场叠加 1% 折扣(旅途 + 适应)
  if (opts.isAway) mult *= 0.99;
  // 欧战中场再叠加 2%
  if (opts.fromEuropean) mult *= 0.98;
  return round(mult);
}

/**
 * 比较两队的疲劳:返回 home_mult / away_mult + 净优势.
 */
export function compareFatigue(homePrevDate, awayPrevDate, matchDate, opts = {}) {
  const homeMult = computeFatigueMultiplier(homePrevDate, matchDate, { isAway: false, ...opts.home });
  const awayMult = computeFatigueMultiplier(awayPrevDate, matchDate, { isAway: true, ...opts.away });
  const advantage = homeMult / awayMult;
  return {
    homeMultiplier: homeMult,
    awayMultiplier: awayMult,
    homeAdvantageFromFatigue: round(advantage),
    significant: Math.abs(1 - advantage) > 0.05
  };
}

/**
 * 应用疲劳调整到 prediction 概率.
 */
export function applyFatigueBias(probabilities, fatigueCompare) {
  if (!fatigueCompare || !fatigueCompare.significant) return probabilities;
  const homeBoost = fatigueCompare.homeAdvantageFromFatigue - 1;  // 正 = 主队优势
  const adjusted = {
    home: probabilities.home * (1 + homeBoost * 0.5),
    draw: probabilities.draw * (1 - Math.abs(homeBoost) * 0.1),
    away: probabilities.away * (1 - homeBoost * 0.5)
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
