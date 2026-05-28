/**
 * 历史相似比赛 KNN 检索
 * ──────────────────────────────────────────────────
 * 给当前要预测的比赛,从历史 ledger / fixture-store 找 K 个特征最相似的比赛,
 * 用它们的实际结果分布作为预测的额外一票.
 *
 * 特征向量(欧氏距离):
 *   - Elo 差(主-客)
 *   - 赔率隐含概率差(主-客)
 *   - xG 差(若可用)
 *   - 主场指示(0/1)
 *   - 联赛 one-hot(简化:同/不同二值)
 *
 * 距离:加权欧氏距离,权重可调.
 *
 * 输出:K 个相似比赛的 outcome 分布,可加入 ensemble.
 */

const DEFAULT_K = 20;
const DEFAULT_WEIGHTS = {
  eloDiff: 1.0,
  oddsImpliedDiff: 1.5,    // 赔率最重要
  xgDiff: 0.8,
  sameLeague: 0.5,
  homeAdvantage: 0.2
};

/**
 * @param {Object} target  当前要预测的比赛特征
 * @param {Array}  history  历史 ledger 行(需有 features + actual)
 * @param {Object} opts
 *   k, weights, minHistorySamples
 */
export function findSimilarMatches(target, history, opts = {}) {
  const k = opts.k ?? DEFAULT_K;
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const minSamples = opts.minSamples ?? 30;

  if (!Array.isArray(history) || history.length < minSamples) {
    return { ok: false, reason: `insufficient-history:${history?.length ?? 0}/${minSamples}` };
  }

  const distances = history
    .filter((m) => m && Number.isFinite(extractActual(m)))
    .map((m) => ({
      match: m,
      distance: computeDistance(target, m, weights),
      actual: extractActual(m)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);

  if (!distances.length) {
    return { ok: false, reason: "no-comparable-matches" };
  }

  // 反距离加权(closer matches 权重大)
  const totalWeight = distances.reduce((s, d) => s + 1 / (d.distance + 0.001), 0);
  const probabilities = { home: 0, draw: 0, away: 0 };
  for (const d of distances) {
    const w = (1 / (d.distance + 0.001)) / totalWeight;
    if (d.actual === 3) probabilities.home += w;
    else if (d.actual === 1) probabilities.draw += w;
    else if (d.actual === 0) probabilities.away += w;
  }

  return {
    ok: true,
    k: distances.length,
    averageDistance: round(distances.reduce((s, d) => s + d.distance, 0) / distances.length),
    closestDistance: round(distances[0].distance),
    probabilities: {
      home: round(probabilities.home),
      draw: round(probabilities.draw),
      away: round(probabilities.away)
    },
    topMatches: distances.slice(0, 5).map((d) => ({
      home: d.match.home ?? d.match.match ?? "",
      away: d.match.away ?? "",
      date: d.match.date,
      actual: d.actual,
      distance: round(d.distance)
    }))
  };
}

function computeDistance(target, match, weights) {
  let d2 = 0;
  // Elo 差
  if (Number.isFinite(target.eloDiff) && Number.isFinite(match.eloDiff)) {
    d2 += weights.eloDiff * Math.pow((target.eloDiff - match.eloDiff) / 200, 2);  // 200 标准化 Elo 差
  }
  // 赔率隐含概率差
  if (Number.isFinite(target.oddsImpliedDiff) && Number.isFinite(match.oddsImpliedDiff)) {
    d2 += weights.oddsImpliedDiff * Math.pow(target.oddsImpliedDiff - match.oddsImpliedDiff, 2);
  }
  // xG 差
  if (Number.isFinite(target.xgDiff) && Number.isFinite(match.xgDiff)) {
    d2 += weights.xgDiff * Math.pow(target.xgDiff - match.xgDiff, 2);
  }
  // 联赛
  if (target.league && match.league) {
    const sameLeague = target.league === match.league ? 0 : 1;
    d2 += weights.sameLeague * sameLeague;
  }
  // 主场(都假设 home advantage,差异是主队相同与否,简化)
  return Math.sqrt(d2);
}

function extractActual(row) {
  if (Number.isFinite(row.actual)) return row.actual;
  const a = String(row.actual ?? "");
  if (["主胜", "胜", "home", "3"].includes(a)) return 3;
  if (["平局", "平", "draw", "1"].includes(a)) return 1;
  if (["客胜", "负", "away", "0"].includes(a)) return 0;
  return null;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
