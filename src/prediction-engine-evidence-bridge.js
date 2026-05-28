/**
 * Prediction Engine Evidence Bridge
 * ──────────────────────────────────────────────────
 * Wrapper:不修改 prediction-engine.js 主路径,提供 wrapPredictionWithEvidence()
 * 在调用方层面把 evidence-collector + bayesian update + enrichment 拼起来.
 *
 * 用法:
 *   const predictions = recommendFixtures(date).predictions;
 *   const enriched = predictions.map((p) =>
 *     wrapPredictionWithEvidence(p, context)
 *   );
 *
 * prediction.evidenceView 会出现新字段:
 *   - bayesianPosterior(用所有 evidence 累加后的概率)
 *   - evidenceList(LR 数组)
 *   - enrichment(top supporting / opposing / confidence label)
 *   - finalRecommendedProbabilities(综合主路径 + bayesian 后的概率)
 */

import { collectAllEvidence, applyAllEvidenceToProbabilities } from "./evidence-collector.js";
import { enrichRecommendation } from "./recommendation-enrichment.js";

const DEFAULT_POSTERIOR_BLEND = 0.4;  // 40% bayesian + 60% main

/**
 * @param {Object} prediction 已经走完主路径的 prediction(含 pick, probabilities, ...)
 * @param {Object} context  evidence-collector 需要的上下文
 * @param {Object} opts  posteriorBlend
 */
export function wrapPredictionWithEvidence(prediction, context = {}, opts = {}) {
  if (!prediction) return null;
  const blend = opts.posteriorBlend ?? DEFAULT_POSTERIOR_BLEND;
  const evidence = collectAllEvidence(context);

  let bayesian = null;
  let finalProbs = prediction.probabilities;
  if (evidence.length > 0 && prediction.probabilities) {
    const r = applyAllEvidenceToProbabilities(prediction.probabilities, context);
    bayesian = r;
    finalProbs = blendProbabilities(prediction.probabilities, r.posterior, blend);
  }

  const enrichment = enrichRecommendation(prediction, evidence);

  return {
    ...prediction,
    evidenceView: {
      evidenceCount: evidence.length,
      evidenceList: evidence,
      bayesianPosterior: bayesian?.posterior ?? null,
      finalRecommendedProbabilities: finalProbs,
      enrichment,
      blendFactor: blend,
      narrative: enrichment?.interpretation ?? null
    }
  };
}

function blendProbabilities(main, posterior, alpha) {
  const out = {
    home: (1 - alpha) * main.home + alpha * posterior.home,
    draw: (1 - alpha) * main.draw + alpha * posterior.draw,
    away: (1 - alpha) * main.away + alpha * posterior.away
  };
  const sum = out.home + out.draw + out.away;
  if (sum > 0) {
    out.home /= sum; out.draw /= sum; out.away /= sum;
  }
  return {
    home: round(out.home),
    draw: round(out.draw),
    away: round(out.away)
  };
}

/**
 * Batch helper: 给一组 predictions + contextProvider(fn(prediction)→context).
 */
export function wrapAllWithEvidence(predictions, contextProvider, opts = {}) {
  if (!Array.isArray(predictions)) return [];
  return predictions.map((p) => {
    const ctx = typeof contextProvider === "function" ? contextProvider(p) : {};
    return wrapPredictionWithEvidence(p, ctx, opts);
  });
}

/**
 * 比较主路径 pick 跟 bayesian posterior argmax 是否一致(分歧检测).
 */
export function detectEvidenceDisagreement(prediction) {
  if (!prediction?.evidenceView?.bayesianPosterior || !prediction?.probabilities) return null;
  const mainArgmax = pickArgmax(prediction.probabilities);
  const bayesArgmax = pickArgmax(prediction.evidenceView.bayesianPosterior);
  return {
    agree: mainArgmax === bayesArgmax,
    mainArgmax,
    bayesArgmax,
    delta: {
      home: round(prediction.evidenceView.bayesianPosterior.home - prediction.probabilities.home),
      draw: round(prediction.evidenceView.bayesianPosterior.draw - prediction.probabilities.draw),
      away: round(prediction.evidenceView.bayesianPosterior.away - prediction.probabilities.away)
    },
    narrative: mainArgmax === bayesArgmax
      ? `✅ 主路径 + bayesian evidence 共识 ${mainArgmax}`
      : `⚠ 主路径 ${mainArgmax} vs evidence ${bayesArgmax} 分歧`
  };
}

function pickArgmax(probs) {
  return ["home", "draw", "away"].reduce((a, b) => (probs[a] ?? 0) >= (probs[b] ?? 0) ? a : b);
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
