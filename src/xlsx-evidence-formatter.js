/**
 * Xlsx Evidence Formatter
 * ──────────────────────────────────────────────────
 * 把 enrichment / evidence list 格式化成 xlsx 行可读字段.
 * 不直接写 xlsx(避免重复 xlsx-writer 依赖),只产字符串供 daily-report 用.
 */

const CONFIDENCE_EMOJI = {
  "strong-signal": "✅",
  "moderate-signal": "🟢",
  "weak-signal": "🟡",
  "mixed-against": "⚠",
  "neutral": "⚪"
};

const SOURCE_EMOJI = {
  "streak-home": "🔥",
  "streak-away": "🔥",
  "derby": "⚔",
  "referee": "👨‍⚖",
  "fatigue": "😴",
  "travel": "✈",
  "weather": "🌧",
  "manager": "👔",
  "standings-pressure": "📊",
  "big-game-form": "🏆",
  "line-movement": "📈"
};

/**
 * 格式化 enrichment 为 xlsx cell text.
 */
export function formatEnrichmentCell(enrichment) {
  if (!enrichment) return "";
  const emoji = CONFIDENCE_EMOJI[enrichment.confidence] ?? "⚪";
  const parts = [`${emoji} ${enrichment.confidence}`];
  if (enrichment.supportingFactors?.length) {
    parts.push(`✓ ${enrichment.supportingFactors.slice(0, 2).join(", ")}`);
  }
  if (enrichment.riskFactors?.length) {
    parts.push(`✗ ${enrichment.riskFactors.slice(0, 2).join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * 格式化 evidence list 为简短文本.
 */
export function formatEvidenceList(evidenceList, opts = {}) {
  if (!Array.isArray(evidenceList) || !evidenceList.length) return "";
  const max = opts.max ?? 5;
  return evidenceList.slice(0, max).map((ev) => {
    const emoji = SOURCE_EMOJI[ev.source] ?? "·";
    return `${emoji} ${ev.name}`;
  }).join("\n");
}

/**
 * 给一行 prediction 产可放 xlsx 多个单元格的数据.
 */
export function buildEnrichmentRow(prediction) {
  const ev = prediction.evidenceView;
  if (!ev) return null;
  return {
    evidenceCount: ev.evidenceCount,
    confidence: ev.enrichment?.confidence ?? "unknown",
    supportingFactors: ev.enrichment?.supportingFactors?.join("; ") ?? "",
    riskFactors: ev.enrichment?.riskFactors?.join("; ") ?? "",
    bayesianPosteriorHome: ev.bayesianPosterior?.home ?? null,
    bayesianPosteriorDraw: ev.bayesianPosterior?.draw ?? null,
    bayesianPosteriorAway: ev.bayesianPosterior?.away ?? null,
    finalProbHome: ev.finalRecommendedProbabilities?.home ?? null,
    finalProbDraw: ev.finalRecommendedProbabilities?.draw ?? null,
    finalProbAway: ev.finalRecommendedProbabilities?.away ?? null,
    formattedEnrichment: formatEnrichmentCell(ev.enrichment),
    formattedEvidence: formatEvidenceList(ev.evidenceList)
  };
}

/**
 * 给 xlsx-writer 用的 headers.
 */
export function evidenceColumnHeaders() {
  return [
    "Evidence数量",
    "confidence",
    "支持因素",
    "风险因素",
    "Bayes主胜概率",
    "Bayes平局概率",
    "Bayes客胜概率",
    "终主胜概率",
    "终平局概率",
    "终客胜概率",
    "Evidence解读",
    "Evidence清单"
  ];
}

/**
 * 把 enrichment row 转 xlsx 数组(按 headers 顺序).
 */
export function enrichmentRowToArray(enrichmentRow) {
  if (!enrichmentRow) return new Array(evidenceColumnHeaders().length).fill("");
  return [
    enrichmentRow.evidenceCount,
    enrichmentRow.confidence,
    enrichmentRow.supportingFactors,
    enrichmentRow.riskFactors,
    enrichmentRow.bayesianPosteriorHome,
    enrichmentRow.bayesianPosteriorDraw,
    enrichmentRow.bayesianPosteriorAway,
    enrichmentRow.finalProbHome,
    enrichmentRow.finalProbDraw,
    enrichmentRow.finalProbAway,
    enrichmentRow.formattedEnrichment,
    enrichmentRow.formattedEvidence
  ];
}
