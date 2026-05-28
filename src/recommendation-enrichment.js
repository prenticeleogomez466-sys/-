/**
 * Recommendation Enrichment
 * ──────────────────────────────────────────────────
 * 给 prediction 加可读的 evidence 注释,xlsx 行级展示给用户.
 *
 * 输出:
 *   - top-3 个最影响的 evidence 名 + 简短描述
 *   - 整体推荐"确信度"标签(strong-signal / mixed / weak)
 *   - 主要风险因素
 */

/**
 * @param {Object} prediction 包含 pick, probabilities, ensembleView, etc.
 * @param {Object} evidence  collectAllEvidence 输出
 * @returns {Object}  enrichment 字段
 */
export function enrichRecommendation(prediction, evidenceList = []) {
  if (!prediction) return null;
  const pick = prediction.pick ?? prediction.bestPick ?? null;
  if (!pick) return null;

  // 1. 找出对推荐方向最有帮助 + 最反对的 evidence
  const supporting = [];
  const opposing = [];
  for (const ev of evidenceList) {
    const lrForPick = ev.ratio?.[outcomeKey(pick)];
    if (!Number.isFinite(lrForPick)) continue;
    if (lrForPick >= 1.05) supporting.push({ ...ev, impact: lrForPick - 1 });
    else if (lrForPick <= 0.95) opposing.push({ ...ev, impact: 1 - lrForPick });
  }
  supporting.sort((a, b) => b.impact - a.impact);
  opposing.sort((a, b) => b.impact - a.impact);

  // 2. 信号强度标签
  const supportSum = supporting.reduce((s, e) => s + e.impact, 0);
  const opposeSum = opposing.reduce((s, e) => s + e.impact, 0);
  let confidence;
  if (supportSum > 0.3 && opposeSum < 0.1) confidence = "strong-signal";
  else if (supportSum > 0.15 && opposeSum < 0.2) confidence = "moderate-signal";
  else if (supportSum > 0.05 && opposeSum < 0.3) confidence = "weak-signal";
  else if (opposeSum > supportSum) confidence = "mixed-against";
  else confidence = "neutral";

  // 3. 主要风险
  const risks = opposing.slice(0, 2).map((e) => `${e.name} (反向影响 ${(e.impact*100).toFixed(0)}%)`);

  // 4. 主要支持因素
  const supports = supporting.slice(0, 3).map((e) => `${e.name} (+${(e.impact*100).toFixed(0)}%)`);

  return {
    pick: pickLabel(pick),
    confidence,
    supportingFactors: supports,
    riskFactors: risks,
    evidenceCount: evidenceList.length,
    netImpact: supportSum - opposeSum,
    interpretation: buildInterpretation(confidence, supports, risks)
  };
}

function outcomeKey(pick) {
  if (typeof pick === "string") return pick;
  if (pick.code === "3" || pick.outcome === "home") return "home";
  if (pick.code === "1" || pick.outcome === "draw") return "draw";
  if (pick.code === "0" || pick.outcome === "away") return "away";
  return "home";
}

function pickLabel(pick) {
  if (typeof pick === "string") return pick;
  return pick.label ?? pick.outcome ?? pick.code ?? "?";
}

function buildInterpretation(confidence, supports, risks) {
  const parts = [];
  if (confidence === "strong-signal") parts.push("✅ 多重 evidence 强力支持");
  else if (confidence === "moderate-signal") parts.push("🟢 evidence 支持中等强度");
  else if (confidence === "weak-signal") parts.push("🟡 evidence 支持有限");
  else if (confidence === "mixed-against") parts.push("⚠ evidence 净反对");
  else parts.push("⚪ evidence 中性");

  if (supports.length) parts.push(`主要支持: ${supports.slice(0, 2).join("; ")}`);
  if (risks.length) parts.push(`主要风险: ${risks.join("; ")}`);
  return parts.join(" | ");
}

/**
 * Batch:给多场 prediction 加 enrichment.
 */
export function enrichAllRecommendations(predictions, contextProvider) {
  return predictions.map((pred) => {
    const context = typeof contextProvider === "function" ? contextProvider(pred) : {};
    const evidence = context.evidence ?? [];
    return {
      ...pred,
      enrichment: enrichRecommendation(pred, evidence)
    };
  });
}
