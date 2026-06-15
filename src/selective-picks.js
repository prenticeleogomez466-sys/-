/**
 * 选择性精选(2026-06-15 新功能:选择性=真 edge 的产品化)。
 * ────────────────────────────────────────────────────────────
 * 实证(feedback_hitrate_closed_loop):全覆盖 1X2 命中 ~55% 天花板,但只推高置信桶
 * (强热门 blend 命中 73-78%)→ 选择性推荐命中可上 60%+,代价是覆盖率↓。本模块把它产品化:
 * 从当日 picks 里筛 favorite 概率 ≥ 门槛的"精选",按概率降序 + 附桶级历史命中参考。
 * 只筛不改方向/概率;低于门槛的不是"弃赛"而是"不进精选"(用户仍可自行下注)。
 */
const BUCKETS = [
  { key: "65-100", lo: 0.65, hi: 1.01, refHit: "73-78%(强热门桶实证)" },
  { key: "55-65", lo: 0.55, hi: 0.65, refHit: "~50-60%" },
  { key: "45-55", lo: 0.45, hi: 0.55, refHit: "~45%(硬币档,慎)" },
  { key: "33-45", lo: 0, hi: 0.45, refHit: "<45%(低,不建议单押)" }
];

function bucketOf(p) {
  return BUCKETS.find((b) => p >= b.lo && p < b.hi) || BUCKETS[BUCKETS.length - 1];
}

/**
 * @param {Array<{match:string, favoriteProb:number, pick?:string, competition?:string}>} picks
 * @param {{minConfidence?:number, maxPicks?:number}} [opts]
 *   minConfidence favorite 概率门槛(默认 0.65=强热门桶)
 *   maxPicks      精选最多几注(默认 Infinity)
 * @returns {{selected:Array, coverage:{total:number, selected:number, rate:number|null}}}
 */
export function selectHighConfidence(picks, opts = {}) {
  const minConfidence = Number(opts.minConfidence ?? 0.65);
  const maxPicks = Number(opts.maxPicks ?? Infinity);
  const list = (Array.isArray(picks) ? picks : []).filter((p) => Number.isFinite(p.favoriteProb));
  const selected = list
    .filter((p) => p.favoriteProb >= minConfidence)
    .sort((a, b) => b.favoriteProb - a.favoriteProb)
    .slice(0, maxPicks)
    .map((p) => ({ ...p, bucket: bucketOf(p.favoriteProb).key, refHit: bucketOf(p.favoriteProb).refHit }));
  return {
    selected,
    coverage: { total: list.length, selected: selected.length, rate: list.length ? +(selected.length / list.length).toFixed(3) : null }
  };
}
