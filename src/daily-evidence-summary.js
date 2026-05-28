/**
 * Daily Evidence Summary
 * ──────────────────────────────────────────────────
 * 给一组 daily predictions(带 evidenceView)聚合产出"今日 evidence 总览":
 *   - 多少场 strong-signal
 *   - 最常见 evidence type
 *   - 主路径 vs bayesian 分歧场次列表
 *   - 推荐 top picks
 */

import { detectEvidenceDisagreement } from "./prediction-engine-evidence-bridge.js";

/**
 * @param {Array} predictions  每个 prediction.evidenceView 已经计算
 */
export function summarizeDailyEvidence(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) {
    return { ok: false, reason: "no-predictions" };
  }
  const enrichments = predictions.map((p) => p.evidenceView).filter(Boolean);
  if (!enrichments.length) return { ok: false, reason: "no-evidence-views" };

  // Confidence 分布
  const confidenceDist = enrichments.reduce((acc, e) => {
    const k = e.enrichment?.confidence ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  // 最常见 evidence sources
  const sourceCounts = new Map();
  let totalEvidence = 0;
  for (const ev of enrichments) {
    for (const e of ev.evidenceList ?? []) {
      sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
      totalEvidence++;
    }
  }
  const topSources = [...sourceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([source, count]) => ({ source, count, share: round(count / totalEvidence) }));

  // 分歧场次
  const disagreements = predictions
    .map((p) => ({ p, disagreement: detectEvidenceDisagreement(p) }))
    .filter((x) => x.disagreement && !x.disagreement.agree)
    .map((x) => ({
      fixture: x.p.fixture ?? null,
      mainArgmax: x.disagreement.mainArgmax,
      bayesArgmax: x.disagreement.bayesArgmax,
      delta: x.disagreement.delta,
      narrative: x.disagreement.narrative
    }));

  // Strong-signal picks
  const strongPicks = predictions
    .filter((p) => p.evidenceView?.enrichment?.confidence === "strong-signal")
    .map((p) => ({
      fixture: p.fixture ?? null,
      pick: p.pick?.label ?? p.pick?.outcome,
      enrichment: p.evidenceView.enrichment
    }));

  return {
    ok: true,
    totalPredictions: predictions.length,
    withEvidence: enrichments.length,
    confidenceDistribution: confidenceDist,
    topEvidenceSources: topSources,
    totalEvidenceItems: totalEvidence,
    avgEvidencePerPrediction: round(totalEvidence / enrichments.length),
    mainVsBayesDisagreements: disagreements,
    disagreementRate: round(disagreements.length / predictions.length),
    strongSignalPicks: strongPicks,
    strongSignalCount: strongPicks.length,
    narrative: buildOverallNarrative(predictions.length, strongPicks.length, disagreements.length)
  };
}

function buildOverallNarrative(total, strongCount, disagreementCount) {
  const parts = [];
  if (strongCount >= 3) parts.push(`今日 ${strongCount} 场 strong-signal,evidence 支持强`);
  else if (strongCount >= 1) parts.push(`今日 ${strongCount} 场 strong-signal`);
  else parts.push("今日无 strong-signal 推荐");

  if (disagreementCount >= 2) parts.push(`${disagreementCount} 场 evidence 与主模型分歧,谨慎对待`);
  else if (disagreementCount === 1) parts.push("1 场 evidence/main 分歧");
  return parts.join(",");
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
