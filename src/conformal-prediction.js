/**
 * Conformal Prediction(分位数 conformal)
 * ──────────────────────────────────────────────────
 * 2024-2025 ML 主流方法之一. 思想:
 *   1. 从校准集(历史 predictions + actuals)计算非一致性分数(non-conformity score)
 *   2. 拿到 90%/95% 分位数作为 prediction interval 宽度
 *   3. 新预测 P 时,输出 [P - q, P + q] 作为有覆盖保证的置信区间
 *
 * 用法:
 *   const cp = buildConformalCalibrator(historicalRows);
 *   cp.predictionInterval(0.55);  // → { lower: 0.42, upper: 0.68, alpha: 0.1 }
 *
 * 关键性质(分布无关):若历史校准集 ≥30,覆盖率 ≥ 1-α(理论保证).
 *
 * 应用:让每个 prediction 输出"主胜概率 55% (90% 置信区间 42%-68%)",
 * 用户能直观看到模型的不确定性.
 */

const DEFAULT_ALPHA = 0.1;   // 90% 置信
const MIN_CALIBRATION_SAMPLES = 30;

/**
 * 从历史 ledger 行构建 conformal 校准器.
 * @param {Array} rows  每行需有 favoriteProbability(模型给的)和 hit(0/1).
 * @param {Object} opts
 *   alpha: 显著性水平(默认 0.1 → 90% 区间)
 * @returns {Object|null}
 */
export function buildConformalCalibrator(rows, opts = {}) {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const samples = (rows ?? [])
    .map((r) => {
      const p = Number(r.favoriteProbability);
      const hit = Number(r.hit);
      if (!Number.isFinite(p) || !Number.isFinite(hit)) return null;
      // 非一致性分数:|predicted - actual_0/1|
      return Math.abs(p - hit);
    })
    .filter(Number.isFinite);
  if (samples.length < (opts.minSamples ?? MIN_CALIBRATION_SAMPLES)) {
    return { ok: false, reason: `insufficient-samples:${samples.length}` };
  }
  samples.sort((a, b) => a - b);
  const quantileIndex = Math.ceil((samples.length + 1) * (1 - alpha)) - 1;
  const q = samples[Math.min(samples.length - 1, Math.max(0, quantileIndex))];

  return {
    ok: true,
    alpha,
    samples: samples.length,
    quantile: round(q),
    /**
     * 给一个新预测 p,返回 (1-alpha) 置信区间.
     */
    predictionInterval(p) {
      const lower = Math.max(0, Math.min(1, p - q));
      const upper = Math.max(0, Math.min(1, p + q));
      return {
        point: round(p),
        lower: round(lower),
        upper: round(upper),
        alpha,
        width: round(upper - lower)
      };
    },
    /**
     * 对一组 outcome 概率(home/draw/away)分别加区间
     */
    predictionIntervalsAll(probs) {
      return {
        home: this.predictionInterval(probs.home ?? 0),
        draw: this.predictionInterval(probs.draw ?? 0),
        away: this.predictionInterval(probs.away ?? 0)
      };
    }
  };
}

/**
 * Mondrian conformal: 按 prob bucket 分别校准(因为 55% 预测的可靠性 ≠ 80% 预测的可靠性)
 */
export function buildBucketedConformalCalibrator(rows, opts = {}) {
  const buckets = ["33-45", "45-55", "55-65", "65-100"];
  const bucketRows = Object.fromEntries(buckets.map((b) => [b, []]));
  for (const r of rows ?? []) {
    const p = Number(r.favoriteProbability);
    if (!Number.isFinite(p)) continue;
    const bucket = p < 0.45 ? "33-45" : p < 0.55 ? "45-55" : p < 0.65 ? "55-65" : "65-100";
    bucketRows[bucket].push(r);
  }
  const calibrators = {};
  for (const b of buckets) {
    const cal = buildConformalCalibrator(bucketRows[b], { ...opts, minSamples: opts.minBucketSamples ?? 10 });
    if (cal.ok) calibrators[b] = cal;
  }
  return {
    ok: Object.keys(calibrators).length > 0,
    calibrators,
    predictionInterval(p) {
      const bucket = p < 0.45 ? "33-45" : p < 0.55 ? "45-55" : p < 0.65 ? "55-65" : "65-100";
      const cal = calibrators[bucket];
      if (cal) return { ...cal.predictionInterval(p), bucket };
      // Fall back to global if bucket has insufficient data
      const global = buildConformalCalibrator(rows ?? [], opts);
      if (global.ok) return { ...global.predictionInterval(p), bucket: "global-fallback" };
      return null;
    }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
