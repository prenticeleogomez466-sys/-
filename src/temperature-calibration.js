/**
 * Temperature Scaling 校准(Guo et al. 2017)
 * ──────────────────────────────────────────────────
 * 借鉴 Guo et al. 2017 "On Calibration of Modern Neural Networks"
 * (>5000 citations).简单到 2 行代码就能做的 post-hoc calibration.
 *
 * 思想:
 *   - 模型输出 logits z = (z_h, z_d, z_a)(对应 home/draw/away)
 *   - probability p_i = exp(z_i) / sum(exp(z))
 *   - Temperature scaling:p_i = exp(z_i / T) / sum(exp(z / T))
 *   - 学一个温度 T 使 held-out 集的 NLL(交叉熵)最小
 *
 * 物理意义:
 *   - T > 1:模型过度自信(0.9 概率实际只 0.75),T 升高 → 软化分布
 *   - T < 1:模型欠自信(0.6 概率实际 0.75),T 降低 → 锐化分布
 *   - T = 1:已校准
 *
 * 优点(vs Isotonic):
 *   - 只学 1 个参数 → 不过拟合,小样本(<100)也能用
 *   - 不改变 ranking(argmax 不变)→ 保留模型准确率
 *   - 比 Platt scaling 更适合多分类
 *
 * 适用:足球预测有 3 类(主胜/平/客胜),完美适配 multiclass temperature scaling.
 */

/**
 * 从概率反推 logits(假设原始 softmax 输出)
 * 简化:取 log(p),后续乘 1/T 再 softmax
 */
function probsToLogits(probs) {
  return [Math.log(Math.max(probs.home ?? 1e-9, 1e-9)),
          Math.log(Math.max(probs.draw ?? 1e-9, 1e-9)),
          Math.log(Math.max(probs.away ?? 1e-9, 1e-9))];
}

function logitsWithTempToProbs(logits, T) {
  const scaled = logits.map((z) => z / Math.max(T, 1e-3));
  const maxL = Math.max(...scaled);
  const exps = scaled.map((z) => Math.exp(z - maxL));
  const sum = exps.reduce((a, b) => a + b, 0);
  return {
    home: exps[0] / sum,
    draw: exps[1] / sum,
    away: exps[2] / sum
  };
}

/**
 * NLL of held-out validation set under temperature T
 */
function nllAtTemperature(samples, T) {
  let nll = 0;
  for (const s of samples) {
    const logits = probsToLogits(s.probabilities);
    const calibrated = logitsWithTempToProbs(logits, T);
    const actualKey = s.actual === "3" ? "home" : s.actual === "1" ? "draw" : s.actual === "0" ? "away" : null;
    if (!actualKey) continue;
    const p = Math.max(calibrated[actualKey], 1e-12);
    nll += -Math.log(p);
  }
  return nll / samples.length;
}

/**
 * 学最优温度 T:用线搜索(0.1 ~ 5.0).
 * @param {Array} samples [{ probabilities: {home, draw, away}, actual: "3"|"1"|"0" }]
 * @param {Object} opts
 *   minSamples: 最少样本,默认 30
 * @returns {{ ok, temperature, nllAtT1, nllAtBestT }}
 */
export function fitTemperature(samples, opts = {}) {
  const minSamples = opts.minSamples ?? 30;
  const valid = (samples ?? []).filter((s) => s?.probabilities && s.actual != null);
  if (valid.length < minSamples) {
    return { ok: false, reason: `insufficient-samples:${valid.length}/${minSamples}`, temperature: 1 };
  }
  // 线搜 T ∈ [0.1, 5.0],步长 0.05
  let bestT = 1;
  let bestNLL = Infinity;
  for (let T = 0.1; T <= 5.0; T += 0.05) {
    const nll = nllAtTemperature(valid, T);
    if (nll < bestNLL) {
      bestNLL = nll;
      bestT = T;
    }
  }
  // 二阶细搜
  for (let T = bestT - 0.05; T <= bestT + 0.05; T += 0.005) {
    if (T <= 0) continue;
    const nll = nllAtTemperature(valid, T);
    if (nll < bestNLL) {
      bestNLL = nll;
      bestT = T;
    }
  }
  return {
    ok: true,
    temperature: round(bestT),
    nllAtT1: round(nllAtTemperature(valid, 1.0)),
    nllAtBestT: round(bestNLL),
    samples: valid.length,
    diagnosis: bestT > 1.1 ? "模型过度自信,需软化"
             : bestT < 0.9 ? "模型欠自信,需锐化"
             : "已基本校准"
  };
}

/**
 * 用学到的 T 校准新预测.
 */
export function applyTemperature(probs, T) {
  const logits = probsToLogits(probs);
  return logitsWithTempToProbs(logits, T);
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
