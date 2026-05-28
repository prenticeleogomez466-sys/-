/**
 * 线性逻辑回归 stacker(B 档 #3)
 * ──────────────────────────────────────────────────
 * 思路同 XGBoost stacking,但用纯 JS 多分类逻辑回归实现,零外部依赖。
 *
 * 学界共识(2024-2025 综述):
 *   XGBoost 在足球预测上的优势主要来自非线性组合特征。
 *   但对于"少量手工设计的强特征"(赔率隐含 / Dixon-Coles / Elo / xG / form),
 *   逻辑回归 stacker 的表现差距只有 1-2 个百分点 RPS,而工程复杂度低一个量级,
 *   且模型可解释(查看每个特征的权重就知道模型在依赖什么)。
 *
 * 接口:
 *   trainLinearStacker(samples, opts) -> { weights, intercept, classes, history }
 *   predictWithStacker(model, features) -> { home, draw, away }
 *
 * 训练样本 shape:
 *   { features: { oddsHome, oddsDraw, oddsAway, dcHome, dcDraw, dcAway, ... }, label: "home" | "draw" | "away" }
 *
 * 模型可序列化为 JSON 落盘(D:\football-model-data\stacker-model.json),
 * 后续 prediction-engine 加载时直接用 JSON 推理,不需要训练框架。
 */

const CLASSES = ["home", "draw", "away"];

/**
 * 训练多分类逻辑回归(softmax + 交叉熵)。
 *
 * @param {Array} samples  [{ features: {...}, label: "home"|"draw"|"away" }]
 * @param {Object} opts
 *   opts.featureKeys 显式指定特征列;否则从第一个样本推断
 *   opts.learningRate 学习率,默认 0.05
 *   opts.epochs       迭代次数,默认 200
 *   opts.l2           L2 正则系数,默认 0.001
 *   opts.minSamples   最少样本量,低于此训练失败,默认 50
 * @returns {Object|null}  { weights, intercept, featureKeys, classes, history } 或 null
 */
export function trainLinearStacker(samples, opts = {}) {
  const minSamples = opts.minSamples ?? 50;
  if (!Array.isArray(samples) || samples.length < minSamples) {
    return { ok: false, reason: `insufficient-samples:${samples?.length ?? 0}/${minSamples}` };
  }
  const featureKeys = opts.featureKeys ?? Object.keys(samples[0]?.features ?? {});
  if (featureKeys.length === 0) return { ok: false, reason: "no-features" };

  const X = samples.map((s) => featureKeys.map((k) => Number(s.features?.[k] ?? 0)));
  const y = samples.map((s) => CLASSES.indexOf(s.label));
  if (y.some((idx) => idx < 0)) return { ok: false, reason: "invalid-label" };

  const lr = opts.learningRate ?? 0.05;
  const epochs = opts.epochs ?? 200;
  const l2 = opts.l2 ?? 0.001;

  // 标准化特征(Z-score),让 SGD 收敛更快更稳定
  const { mean, std } = featureStats(X);
  const Xn = X.map((row) => row.map((v, j) => (v - mean[j]) / (std[j] || 1)));

  // 初始化:weights[k][j],intercept[k]
  const k = CLASSES.length;
  const d = featureKeys.length;
  const weights = Array.from({ length: k }, () => new Array(d).fill(0));
  const intercept = new Array(k).fill(0);

  const history = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    let loss = 0;
    const gradW = Array.from({ length: k }, () => new Array(d).fill(0));
    const gradB = new Array(k).fill(0);
    for (let i = 0; i < Xn.length; i++) {
      const logits = computeLogits(Xn[i], weights, intercept);
      const probs = softmax(logits);
      const trueIdx = y[i];
      loss += -Math.log(Math.max(probs[trueIdx], 1e-12));
      for (let kk = 0; kk < k; kk++) {
        const err = probs[kk] - (kk === trueIdx ? 1 : 0);
        for (let j = 0; j < d; j++) gradW[kk][j] += err * Xn[i][j];
        gradB[kk] += err;
      }
    }
    for (let kk = 0; kk < k; kk++) {
      for (let j = 0; j < d; j++) {
        weights[kk][j] -= lr * (gradW[kk][j] / Xn.length + l2 * weights[kk][j]);
      }
      intercept[kk] -= lr * (gradB[kk] / Xn.length);
    }
    if (epoch % 20 === 0 || epoch === epochs - 1) history.push({ epoch, loss: round(loss / Xn.length, 6) });
  }

  return {
    ok: true,
    weights,
    intercept,
    featureKeys,
    classes: CLASSES,
    featureMean: mean,
    featureStd: std,
    samples: samples.length,
    history,
    generatedAt: new Date().toISOString()
  };
}

/**
 * 用训练好的 stacker 推理一场比赛。
 * @param {Object} model trainLinearStacker 返回的对象
 * @param {Object} features  对应 featureKeys 的特征字典
 * @returns {Object|null} { home, draw, away } 概率,或 null
 */
export function predictWithStacker(model, features) {
  if (!model?.ok || !model.weights) return null;
  const x = model.featureKeys.map((k, j) => {
    const v = Number(features?.[k] ?? 0);
    return (v - model.featureMean[j]) / (model.featureStd[j] || 1);
  });
  const logits = computeLogits(x, model.weights, model.intercept);
  const probs = softmax(logits);
  return {
    home: round(probs[0]),
    draw: round(probs[1]),
    away: round(probs[2]),
    source: `linear-stacker(${model.featureKeys.length}feat,${model.samples}samples)`
  };
}

/**
 * 从历史 ledger 行收集训练样本。
 * 期望 row 形如 daily-report.js 写入的 ledger row:
 *   { probabilityHome/Draw/Away, baseProbabilityHome/Draw/Away, actual: "主胜"|"平局"|"客胜", ... }
 * 只收 settled rows。
 */
export function buildStackerSamplesFromLedger(rows) {
  const samples = [];
  for (const row of rows) {
    const label = actualToLabel(row.actual);
    if (!label) continue;
    const features = {
      oddsHome: Number(row.baseProbabilityHome ?? 0),
      oddsDraw: Number(row.baseProbabilityDraw ?? 0),
      oddsAway: Number(row.baseProbabilityAway ?? 0),
      modelHome: Number(row.probabilityHome ?? 0),
      modelDraw: Number(row.probabilityDraw ?? 0),
      modelAway: Number(row.probabilityAway ?? 0),
      mcHome: Number(row.monteCarloHome ?? 0),
      mcDraw: Number(row.monteCarloDraw ?? 0),
      mcAway: Number(row.monteCarloAway ?? 0),
      confidence: Number(row.confidence ?? 0) / 100
    };
    // 跳过特征里有 NaN / 0 不合理的样本
    if (!Object.values(features).every(Number.isFinite)) continue;
    if (features.oddsHome === 0 && features.oddsDraw === 0 && features.oddsAway === 0) continue;
    samples.push({ features, label });
  }
  return samples;
}

function actualToLabel(value) {
  const v = String(value ?? "").trim();
  if (["3", "主胜", "胜", "home"].includes(v)) return "home";
  if (["1", "平局", "平", "draw"].includes(v)) return "draw";
  if (["0", "客胜", "负", "away"].includes(v)) return "away";
  return null;
}

function computeLogits(x, weights, intercept) {
  const logits = new Array(weights.length).fill(0);
  for (let kk = 0; kk < weights.length; kk++) {
    let z = intercept[kk];
    for (let j = 0; j < x.length; j++) z += weights[kk][j] * x[j];
    logits[kk] = z;
  }
  return logits;
}

function softmax(logits) {
  const maxL = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxL));
  const sum = exps.reduce((acc, v) => acc + v, 0);
  return exps.map((v) => v / sum);
}

function featureStats(X) {
  const n = X.length;
  const d = X[0].length;
  const mean = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / Math.max(1, n - 1));
  return { mean, std };
}

function round(v, decimals = 4) {
  const m = Math.pow(10, decimals);
  return Math.round((v + Number.EPSILON) * m) / m;
}
