/**
 * 组合级凯利/相关性闸(2026-06-15 新功能:资金管理真缺口)。
 * ────────────────────────────────────────────────────────────
 * 逐注 stake 各自看似合理,但同一场比赛的多玩法注(胜平负+让球+比分)由同一赛果驱动、
 * 高度相关——逐注下注 = 同一风险被重复放大。本模块把"同场跨玩法"视为一个相关簇,
 * 对每场总暴露设上限,超限按比例缩放;全天总暴露另设上限。纯保护真钱,不改概率/方向。
 *
 * 铁律对齐:只降额不抬注(feedback_confidence_not_autosuppress——给提示/降额,不替用户弃赛,
 *   缩放后仍 >0,用户可自行决定);缺 stake 的注不参与缩放(标缺不兜底)。
 */

/**
 * @param {Array<{id?:string, match:string, market?:string, stakeUnits:number}>} picks
 * @param {{perMatchCap?:number, totalCap?:number}} [opts]
 *   perMatchCap 单场跨玩法总注上限(单位,默认 2.0)
 *   totalCap    全天总注上限(单位,默认 10.0)
 * @returns {{picks:Array, totalBefore:number, totalAfter:number, warnings:string[]}}
 */
export function assessPortfolioRisk(picks, opts = {}) {
  const perMatchCap = Number(opts.perMatchCap ?? 2.0);
  const totalCap = Number(opts.totalCap ?? 10.0);
  const list = (Array.isArray(picks) ? picks : []).map((p) => ({ ...p, stakeUnits: Number(p.stakeUnits) || 0 }));
  const warnings = [];

  // ① 单场相关簇:同 match 总暴露超 perMatchCap → 按比例缩放该场所有注
  const byMatch = new Map();
  for (const p of list) byMatch.set(p.match, (byMatch.get(p.match) || 0) + p.stakeUnits);
  const matchScale = new Map();
  for (const [match, sum] of byMatch) {
    if (sum > perMatchCap && sum > 0) {
      matchScale.set(match, perMatchCap / sum);
      warnings.push(`同场相关簇「${match}」总注 ${sum.toFixed(2)}U > ${perMatchCap}U 上限 → 缩放 ${(perMatchCap / sum * 100).toFixed(0)}%`);
    }
  }
  for (const p of list) {
    const s = matchScale.get(p.match);
    if (s) { p.adjustedStake = +(p.stakeUnits * s).toFixed(3); p.capped = "per-match"; }
    else { p.adjustedStake = p.stakeUnits; p.capped = null; }
  }

  // ② 全天总暴露超 totalCap → 全局再缩放
  const totalBefore = +list.reduce((s, p) => s + p.stakeUnits, 0).toFixed(3);
  let totalMid = list.reduce((s, p) => s + p.adjustedStake, 0);
  if (totalMid > totalCap && totalMid > 0) {
    const g = totalCap / totalMid;
    for (const p of list) {
      p.adjustedStake = +(p.adjustedStake * g).toFixed(3);
      p.capped = p.capped ? `${p.capped}+total` : "total";
    }
    warnings.push(`全天总注 ${totalMid.toFixed(2)}U > ${totalCap}U 上限 → 全局缩放 ${(g * 100).toFixed(0)}%`);
    totalMid = list.reduce((s, p) => s + p.adjustedStake, 0);
  }

  return { picks: list, totalBefore, totalAfter: +totalMid.toFixed(3), warnings };
}
