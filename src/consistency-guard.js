/**
 * Consistency Guard
 * ──────────────────────────────────────────────────
 * 包装 consistency-derivation 提供"picks from score"高阶 API:
 *   给 score(锚点) + market snapshot → 自动产 wld / handicap / halfFull 全部一致.
 *
 * 用途:
 *   - 替代 prediction-engine 现有的 buildScorePicks / buildHalfFullPicks
 *     (那些没保证 handicap 一致)
 *   - daily-report 写 xlsx 时强制一致性
 */

import {
  parseScore,
  deriveWldFromScore,
  deriveHandicapFromScore,
  pickConsistentHalfFull,
  pickConsistentScore,
  verifyRecommendationConsistency
} from "./consistency-derivation.js";

/**
 * 给一个 score(锚点)+ market snapshot,产 4 个一致字段.
 *
 * @param {string} score "X-Y"
 * @param {Object} snapshot { halfFullOdds, handicapLine }
 * @returns {Object} { wld, handicap, halfFull, consistency }
 */
export function picksFromScore(score, snapshot = {}) {
  const s = parseScore(score);
  if (!s) return { ok: false, reason: "invalid-score" };

  const wld = deriveWldFromScore(score);
  const handicapLine = snapshot.handicapLine ?? snapshot.handicap?.line ?? 0;
  const handicap = deriveHandicapFromScore(score, handicapLine);

  let halfFull = null;
  let halfFullOdds = null;
  if (snapshot.halfFullOdds) {
    const hf = pickConsistentHalfFull(score, snapshot.halfFullOdds);
    halfFull = hf.label;
    halfFullOdds = hf.odds;
  }

  const errors = verifyRecommendationConsistency({
    score, wld, handicapDirection: handicap, handicapLine, halfFull
  });

  return {
    ok: errors.length === 0,
    score,
    wld,
    handicap: { line: handicapLine, direction: handicap },
    halfFull: halfFull ? { label: halfFull, odds: halfFullOdds } : null,
    consistencyErrors: errors,
    note: errors.length === 0
      ? "✅ 4 字段全一致"
      : `⚠ ${errors.length} 个不一致: ${errors.join("; ")}`
  };
}

/**
 * 反向:给 wld(锚点)+ market → 挑符合 wld 的最佳 score → 再走 picksFromScore.
 */
export function picksFromWld(wld, snapshot = {}) {
  if (!snapshot.allScoresOdds) return { ok: false, reason: "no-score-odds" };
  const sc = pickConsistentScore(snapshot.allScoresOdds, wld);
  if (!sc.score) return { ok: false, reason: "no-matching-score" };
  return picksFromScore(sc.score, snapshot);
}

/**
 * 检验一个完整 prediction 的内部一致性.
 */
export function auditPredictionConsistency(prediction) {
  if (!prediction?.scorePicks?.primary) return { ok: false, reason: "no-score-pick" };
  const errors = verifyRecommendationConsistency({
    score: prediction.scorePicks.primary,
    wld: prediction.pick?.label,
    handicapDirection: prediction.handicapPick?.direction,
    handicapLine: prediction.handicapPick?.line,
    halfFull: prediction.halfFullPicks?.primary
  });
  return {
    ok: errors.length === 0,
    errors,
    suggestions: errors.length > 0
      ? ["建议:用 picksFromScore() 重新生成,以比分作为锚点"]
      : []
  };
}

/**
 * 批量审查 + 重新计算.
 */
export function reconcileBatch(predictions, snapshotProvider) {
  if (!Array.isArray(predictions)) return [];
  return predictions.map((p) => {
    const audit = auditPredictionConsistency(p);
    if (audit.ok) return { ...p, consistency: { ok: true } };
    const snap = typeof snapshotProvider === "function" ? snapshotProvider(p) : {};
    if (!p.scorePicks?.primary || !snap) {
      return { ...p, consistency: audit };
    }
    const fixed = picksFromScore(p.scorePicks.primary, snap);
    return {
      ...p,
      consistency: audit,
      reconciled: fixed
    };
  });
}
