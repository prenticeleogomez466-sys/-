/**
 * Variable Selection / Feature Pruning
 * ──────────────────────────────────────────────────
 * 从大量特征自动选 top-K 最有预测力的,避免维度灾难和过拟合.
 * 三种方法:
 *   1. Mutual Information(信息论,直接)
 *   2. Recursive Feature Elimination(贪心,baseline)
 *   3. Correlation filter(简单,快速)
 *
 * 用途:form-momentum 30+ features 选 top-10 给 stacker / KNN.
 */

/**
 * 互信息(连续特征 vs 离散标签).
 * 简化版:用直方图 bins 估算 H(X), H(Y), H(X,Y).
 */
export function mutualInformation(featureValues, labels, bins = 10) {
  if (!Array.isArray(featureValues) || !Array.isArray(labels) || featureValues.length !== labels.length) return null;
  const n = featureValues.length;
  if (n < 5) return null;

  // 离散化 feature
  const valid = featureValues.map((v, i) => ({ v: Number(v), l: labels[i] })).filter((x) => Number.isFinite(x.v));
  if (!valid.length) return 0;
  const vMin = Math.min(...valid.map((x) => x.v));
  const vMax = Math.max(...valid.map((x) => x.v));
  if (vMax === vMin) return 0;
  const binWidth = (vMax - vMin) / bins;
  const binOf = (v) => Math.min(bins - 1, Math.floor((v - vMin) / binWidth));

  // 联合频次
  const joint = new Map();
  const marginalX = new Map();
  const marginalY = new Map();
  for (const { v, l } of valid) {
    const b = binOf(v);
    joint.set(`${b}_${l}`, (joint.get(`${b}_${l}`) || 0) + 1);
    marginalX.set(b, (marginalX.get(b) || 0) + 1);
    marginalY.set(l, (marginalY.get(l) || 0) + 1);
  }

  const N = valid.length;
  let mi = 0;
  for (const [key, count] of joint.entries()) {
    const [b, l] = key.split("_");
    const pxy = count / N;
    const px = marginalX.get(Number(b)) / N;
    const py = marginalY.get(l) / N;
    if (pxy > 0 && px > 0 && py > 0) {
      mi += pxy * Math.log(pxy / (px * py));
    }
  }
  return mi;
}

/**
 * 给一组 samples [{ features: {...}, label: "home"|"draw"|"away" }],
 * 计算每个 feature 的 mutual information,排序返回 top-K.
 */
export function selectTopKFeatures(samples, k = 10) {
  if (!Array.isArray(samples) || samples.length < 5) {
    return { ok: false, reason: "insufficient-samples" };
  }
  const featureNames = Object.keys(samples[0]?.features ?? {});
  if (!featureNames.length) return { ok: false, reason: "no-features" };

  const labels = samples.map((s) => s.label);
  const scores = featureNames.map((name) => {
    const values = samples.map((s) => s.features[name]);
    const mi = mutualInformation(values, labels);
    return { feature: name, mi: round(mi ?? 0) };
  }).sort((a, b) => b.mi - a.mi);

  return {
    ok: true,
    allFeatures: scores,
    top: scores.slice(0, k),
    droppedCount: Math.max(0, scores.length - k)
  };
}

/**
 * Correlation filter: 移除高度共线(|corr| > threshold)的冗余特征.
 */
export function removeCollinearFeatures(samples, threshold = 0.9) {
  const featureNames = Object.keys(samples[0]?.features ?? {});
  const valueMap = Object.fromEntries(featureNames.map((f) => [f, samples.map((s) => Number(s.features[f])).filter(Number.isFinite)]));

  const toRemove = new Set();
  for (let i = 0; i < featureNames.length; i++) {
    if (toRemove.has(featureNames[i])) continue;
    for (let j = i + 1; j < featureNames.length; j++) {
      if (toRemove.has(featureNames[j])) continue;
      const corr = pearsonCorrelation(valueMap[featureNames[i]], valueMap[featureNames[j]]);
      if (Math.abs(corr) >= threshold) {
        // 移除排序靠后的(由调用方决定保留哪个,默认后者)
        toRemove.add(featureNames[j]);
      }
    }
  }
  return {
    kept: featureNames.filter((f) => !toRemove.has(f)),
    removed: [...toRemove]
  };
}

function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
