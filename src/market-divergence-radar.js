/**
 * 模型↔市场分歧雷达(2026-06-15 新功能:零成本高价值复核清单)。
 * ────────────────────────────────────────────────────────────
 * 每场算模型概率与市场隐含概率的总分歧度(Σ|model−market|),按分歧降序——
 * 高分歧场=要么有 value、要么模型错,置顶供人工复核。
 * 实证背书(reference_signal_backtest_findings):分歧越大市场越对 → 默认作风险旗标,
 * 不自动反向下注(只标注,守 feedback_confidence_not_autosuppress)。
 */
const OUTCOMES = ["home", "draw", "away"];

function argmaxKey(p) {
  return OUTCOMES.reduce((b, k) => ((p?.[k] ?? -1) > (p?.[b] ?? -1) ? k : b), "home");
}

/**
 * @param {Array<{match:string, competition?:string, modelProbs:{home,draw,away}, marketProbs:{home,draw,away}|null}>} rows
 * @param {{threshold?:number}} [opts] threshold 标记高分歧的阈值(Σ绝对差,默认 0.25)
 * @returns {Array<{match, competition, divergence, modelPick, marketPick, agree, flagged, hasMarket}>}
 *   按 divergence 降序;无市场隐含的场 hasMarket:false 排末尾(分歧不可判)。
 */
export function rankByDivergence(rows, opts = {}) {
  const threshold = Number(opts.threshold ?? 0.25);
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const hasMarket = r.marketProbs && OUTCOMES.every((k) => Number.isFinite(r.marketProbs[k]));
    if (!hasMarket) {
      return { match: r.match, competition: r.competition ?? null, divergence: null, modelPick: argmaxKey(r.modelProbs), marketPick: null, agree: null, flagged: false, hasMarket: false };
    }
    const divergence = +OUTCOMES.reduce((s, k) => s + Math.abs((r.modelProbs?.[k] ?? 0) - r.marketProbs[k]), 0).toFixed(4);
    const modelPick = argmaxKey(r.modelProbs);
    const marketPick = argmaxKey(r.marketProbs);
    return { match: r.match, competition: r.competition ?? null, divergence, modelPick, marketPick, agree: modelPick === marketPick, flagged: divergence > threshold, hasMarket: true };
  });
  // 有市场的按分歧降序在前,无市场的排末尾
  return out.sort((a, b) => {
    if (a.hasMarket !== b.hasMarket) return a.hasMarket ? -1 : 1;
    return (b.divergence ?? 0) - (a.divergence ?? 0);
  });
}
