/**
 * Adversarial Validation(分布偏移检测)
 * ──────────────────────────────────────────────────
 * Kaggle 竞赛常用技术:用一个分类器学"这个样本来自训练集还是测试集",
 * 如果分类器 AUC 接近 0.5 → 训练 vs 测试同分布(安全);
 * 如果分类器 AUC > 0.7 → 存在分布偏移(模型在新环境可能过拟合).
 *
 * 应用到足球:
 *   - 训练样本(历史 ledger)的特征分布
 *   - 当前 fixtures 的特征分布
 *   - 比较二者,判断模型是否能 generalize
 *
 * 简化版实现(不用真分类器,用统计距离):
 *   - 对每个特征算 KL 散度 + 均值/std 差异
 *   - 综合打分:偏移程度
 */

/**
 * 特征级分布偏移检测.
 *
 * @param {Array} trainSamples [{ feature1, feature2, ... }]
 * @param {Array} testSamples 同结构
 * @param {Array} [featureNames] 要比较的特征,默认 trainSamples[0] 的全部数字字段
 * @returns {Object}
 */
export function detectDistributionShift(trainSamples, testSamples, featureNames = null) {
  if (!Array.isArray(trainSamples) || !Array.isArray(testSamples)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (trainSamples.length < 5 || testSamples.length < 1) {
    return { ok: false, reason: "insufficient-samples", trainSize: trainSamples.length, testSize: testSamples.length };
  }

  const features = featureNames ?? Object.keys(trainSamples[0] ?? {}).filter((k) =>
    Number.isFinite(Number(trainSamples[0][k]))
  );

  const shifts = features.map((feat) => {
    const trainVals = trainSamples.map((s) => Number(s[feat])).filter(Number.isFinite);
    const testVals = testSamples.map((s) => Number(s[feat])).filter(Number.isFinite);
    if (!trainVals.length || !testVals.length) return null;
    return analyzeFeatureShift(feat, trainVals, testVals);
  }).filter(Boolean);

  shifts.sort((a, b) => b.shiftScore - a.shiftScore);

  const overallScore = shifts.reduce((s, x) => s + x.shiftScore, 0) / Math.max(1, shifts.length);
  return {
    ok: true,
    trainSize: trainSamples.length,
    testSize: testSamples.length,
    overallShiftScore: round(overallScore),
    severity: classifySeverity(overallScore),
    shifts,
    mostShifted: shifts.slice(0, 5),
    recommendation: buildShiftRecommendation(overallScore, shifts)
  };
}

function analyzeFeatureShift(name, trainVals, testVals) {
  const trainMean = mean(trainVals);
  const testMean = mean(testVals);
  const trainStd = std(trainVals, trainMean);
  const testStd = std(testVals, testMean);
  // 标准化均值差
  const pooledStd = (trainStd + testStd) / 2 || 1e-9;
  const cohenD = Math.abs((trainMean - testMean) / pooledStd);
  // 简单的 KL-like 差异:用直方图对比
  const klApprox = histogramKL(trainVals, testVals);
  const shiftScore = round(0.5 * cohenD + 0.5 * klApprox);
  return {
    feature: name,
    trainMean: round(trainMean),
    testMean: round(testMean),
    trainStd: round(trainStd),
    testStd: round(testStd),
    cohenD: round(cohenD),
    klApprox: round(klApprox),
    shiftScore,
    severity: classifySeverity(shiftScore)
  };
}

function histogramKL(a, b, bins = 10) {
  const allVals = [...a, ...b];
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  if (maxV === minV) return 0;
  const bin = (v) => Math.min(bins - 1, Math.floor((v - minV) / (maxV - minV) * bins));
  const histA = new Array(bins).fill(0);
  const histB = new Array(bins).fill(0);
  for (const v of a) histA[bin(v)]++;
  for (const v of b) histB[bin(v)]++;
  const pA = histA.map((c) => (c + 1) / (a.length + bins));  // Laplace smoothing
  const pB = histB.map((c) => (c + 1) / (b.length + bins));
  let kl = 0;
  for (let i = 0; i < bins; i++) {
    kl += pA[i] * Math.log(pA[i] / pB[i]);
  }
  return Math.abs(kl);
}

function classifySeverity(score) {
  if (score < 0.15) return "无显著偏移";
  if (score < 0.35) return "轻度偏移";
  if (score < 0.6) return "中度偏移";
  return "重度偏移";
}

function buildShiftRecommendation(overall, shifts) {
  if (overall < 0.15) return "🟢 训练/测试同分布,模型 generalize 安全";
  if (overall < 0.35) return "🟠 轻度偏移,关注但暂不重训";
  if (overall < 0.6) return "🟠 中度偏移,建议在重大决策前用最新数据校准";
  const top3 = shifts.slice(0, 3).map((s) => s.feature).join(", ");
  return `🔴 重度偏移,${top3} 等特征分布与训练差异大,模型预测可能失真`;
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr, m = null) {
  const mu = m ?? mean(arr);
  const variance = arr.reduce((s, v) => s + Math.pow(v - mu, 2), 0) / Math.max(1, arr.length - 1);
  return Math.sqrt(variance);
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
