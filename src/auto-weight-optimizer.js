/**
 * Auto-Weight Optimizer:数据驱动学最优 ensemble 权重
 * ──────────────────────────────────────────────────
 * 当前 ratings-ensemble 的权重是手工配的(odds 0.20 / DC 0.25 / Pi 0.15 / ...).
 * 从历史 ledger 自动学:每个方法的 RPS 越低 → 权重越大.
 *
 * 三种学法:
 *   1. inverse-RPS(简单):weight_i ∝ 1 / RPS_i
 *   2. softmax(温度 T 控制锐化程度):weight_i = exp(-RPS_i/T) / sum
 *   3. coordinate descent(梯度精细优化):从均匀权重开始,逐 dim 小步搜
 *
 * 注:需要 ledger 中每个方法都有独立 probability 字段(本仓库已有 ensemble vs main 双列).
 */

const OUTCOMES = ["3", "1", "0"];

/**
 * RPS for a single sample.
 */
function rps(probs, actual) {
  const cumP = [probs["3"], probs["3"] + probs["1"]];
  const cumA = actual === "3" ? [1, 1] : actual === "1" ? [0, 1] : [0, 0];
  return 0.5 * ((cumP[0] - cumA[0]) ** 2 + (cumP[1] - cumA[1]) ** 2);
}

/**
 * 给一组方法各自的 prediction + ground truth,算每个方法的 mean RPS.
 *
 * @param {Object} methodPredictions  { methodName: [{ probabilities: {3,1,0}, actual: "3"|"1"|"0" }] }
 * @returns {Object} { methodName: meanRPS }
 */
export function computePerMethodRPS(methodPredictions) {
  const out = {};
  for (const [method, samples] of Object.entries(methodPredictions)) {
    const valid = samples.filter((s) => s.probabilities && s.actual != null);
    if (!valid.length) { out[method] = null; continue; }
    const total = valid.reduce((s, x) => s + rps(x.probabilities, String(x.actual)), 0);
    out[method] = total / valid.length;
  }
  return out;
}

/**
 * Inverse-RPS 加权.
 */
export function inverseRpsWeights(methodRps, opts = {}) {
  const eps = opts.eps ?? 0.01;
  const eligible = Object.entries(methodRps).filter(([, r]) => Number.isFinite(r));
  if (!eligible.length) return null;
  const inverses = eligible.map(([m, r]) => ({ method: m, inv: 1 / Math.max(eps, r) }));
  const total = inverses.reduce((s, x) => s + x.inv, 0);
  return Object.fromEntries(inverses.map((x) => [x.method, round(x.inv / total)]));
}

/**
 * Softmax-based 权重(温度 T 控制锐化:T 越小越极端).
 */
export function softmaxWeights(methodRps, opts = {}) {
  const T = opts.temperature ?? 0.05;
  const eligible = Object.entries(methodRps).filter(([, r]) => Number.isFinite(r));
  if (!eligible.length) return null;
  const minRps = Math.min(...eligible.map(([, r]) => r));
  const scores = eligible.map(([m, r]) => ({ method: m, exp: Math.exp(-(r - minRps) / T) }));
  const total = scores.reduce((s, x) => s + x.exp, 0);
  return Object.fromEntries(scores.map((x) => [x.method, round(x.exp / total)]));
}

/**
 * Coordinate descent 优化:每步在某个 method 的权重上做小步搜索,
 * 找出让 ensemble RPS 最小的权重分布.
 *
 * @param {Object} aligned  { methodA: [{prob, actual}], methodB: [...] }  所有方法的 prediction 必须按相同 sample 顺序对齐
 * @param {Object} opts
 *   initial: 初始权重(默认均匀)
 *   stepSize: 单步搜索步长(默认 0.05)
 *   iterations: 总轮次(默认 50)
 */
export function coordinateDescentWeights(aligned, opts = {}) {
  const methods = Object.keys(aligned);
  if (methods.length === 0) return null;
  const n = aligned[methods[0]]?.length ?? 0;
  if (n === 0) return null;

  // 初始均匀权重
  let weights = opts.initial ?? Object.fromEntries(methods.map((m) => [m, 1 / methods.length]));
  let bestRps = ensembleMeanRPS(weights, aligned, n);

  const step = opts.stepSize ?? 0.05;
  const iters = opts.iterations ?? 30;

  for (let iter = 0; iter < iters; iter++) {
    let improved = false;
    for (const m of methods) {
      for (const delta of [step, -step]) {
        const candidate = { ...weights, [m]: Math.max(0.01, weights[m] + delta) };
        // 归一化
        const sum = methods.reduce((s, k) => s + candidate[k], 0);
        for (const k of methods) candidate[k] = candidate[k] / sum;
        const newRps = ensembleMeanRPS(candidate, aligned, n);
        if (newRps < bestRps - 1e-5) {
          bestRps = newRps;
          weights = candidate;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  return {
    weights: Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, round(v)])),
    ensembleRps: round(bestRps),
    iterations: iters
  };
}

function ensembleMeanRPS(weights, aligned, n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const blended = { "3": 0, "1": 0, "0": 0 };
    let actual = null;
    for (const [m, samples] of Object.entries(aligned)) {
      const s = samples[i];
      if (!s?.probabilities) continue;
      actual = String(s.actual);
      blended["3"] += (weights[m] ?? 0) * (s.probabilities["3"] ?? s.probabilities.home ?? 0);
      blended["1"] += (weights[m] ?? 0) * (s.probabilities["1"] ?? s.probabilities.draw ?? 0);
      blended["0"] += (weights[m] ?? 0) * (s.probabilities["0"] ?? s.probabilities.away ?? 0);
    }
    if (actual == null) continue;
    total += rps(blended, actual);
  }
  return total / n;
}

/**
 * 综合接口:给历史 ledger,自动选最优权重.
 */
export function autoOptimizeWeights(methodPredictions, opts = {}) {
  const strategy = opts.strategy ?? "inverse-rps";
  const methodRps = computePerMethodRPS(methodPredictions);
  if (strategy === "inverse-rps") return { strategy, weights: inverseRpsWeights(methodRps), methodRps };
  if (strategy === "softmax") return { strategy, weights: softmaxWeights(methodRps, opts), methodRps };
  if (strategy === "coordinate-descent") {
    const cd = coordinateDescentWeights(methodPredictions, opts);
    return { strategy, weights: cd?.weights, methodRps, ensembleRps: cd?.ensembleRps };
  }
  return { strategy: "unknown", weights: null };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
