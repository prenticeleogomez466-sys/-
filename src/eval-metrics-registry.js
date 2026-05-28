/**
 * 评测指标注册表(借鉴 OpenCompass metric registry 思想)
 * ──────────────────────────────────────────────────
 * OpenCompass 是上海 AI Lab 的 LLM 评测框架,它的核心设计是:
 *   - 每个 metric 是独立类/函数,通过 registry 注册
 *   - 评测时按 metric.name 查找,统一接口 (predictions, actuals) → score
 *   - 多模型 leaderboard 通过 metric × model 矩阵展示
 *
 * 这里把同思想搬到足球预测:
 *   - 所有概率评测指标(Brier / Log Loss / RPS / Hit Rate / EV)统一接口
 *   - registry 模式,新增指标只需 register 一次
 *   - buildLeaderboard 算多模型(main, ensemble, odds, dc...) × 多 metric
 */

const REGISTRY = new Map();

/**
 * 注册一个评测 metric.
 * @param {string} name 唯一名字
 * @param {Object} config
 *   - direction: "lower-is-better" | "higher-is-better"
 *   - fn(probabilities, actual) → number  其中 probabilities 是 {3,1,0}, actual 是 "3"|"1"|"0"
 *   - aggregator: "mean" | "sum"(默认 mean)
 *   - description: 中文说明
 */
export function registerMetric(name, config) {
  REGISTRY.set(name, {
    name,
    direction: config.direction ?? "lower-is-better",
    fn: config.fn,
    aggregator: config.aggregator ?? "mean",
    description: config.description ?? ""
  });
}

export function getMetric(name) {
  return REGISTRY.get(name);
}

export function listMetrics() {
  return [...REGISTRY.keys()];
}

/**
 * 计算一组样本上某 metric 的总值.
 * @param {string} metricName
 * @param {Array} samples [{ probabilities, actual }]
 */
export function computeMetric(metricName, samples) {
  const metric = getMetric(metricName);
  if (!metric) return null;
  const valid = samples.filter((s) => s.probabilities && s.actual);
  if (!valid.length) return null;
  const values = valid.map((s) => metric.fn(s.probabilities, s.actual));
  if (metric.aggregator === "sum") return values.reduce((a, b) => a + b, 0);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * 多模型 leaderboard:对每个 (method × metric) 算一个分数.
 * @param {Object} methodSamples  { methodName: [{ probabilities, actual }] }
 * @param {Array}  [metricNames]  默认全部已注册的
 * @returns {Object}  { metrics, leaderboard, ranking }
 */
export function buildLeaderboard(methodSamples, metricNames = null) {
  const metrics = metricNames ?? listMetrics();
  const board = {};
  for (const [method, samples] of Object.entries(methodSamples)) {
    board[method] = {};
    for (const mName of metrics) {
      const score = computeMetric(mName, samples);
      const m = getMetric(mName);
      board[method][mName] = score != null ? round(score) : null;
    }
  }
  // 排名:对每个 metric,按 direction 排序
  const ranking = {};
  for (const mName of metrics) {
    const m = getMetric(mName);
    if (!m) continue;
    const entries = Object.entries(board)
      .filter(([_, scores]) => Number.isFinite(scores[mName]))
      .map(([method, scores]) => ({ method, score: scores[mName] }));
    entries.sort((a, b) => m.direction === "higher-is-better" ? b.score - a.score : a.score - b.score);
    ranking[mName] = entries.map((e, i) => ({ rank: i + 1, ...e }));
  }
  return { metrics, leaderboard: board, ranking };
}

// ───── 注册内置指标 ─────

registerMetric("brier", {
  direction: "lower-is-better",
  description: "Brier Score: 概率与实际结果(one-hot)的平方差均值,越低越好",
  fn: (probs, actual) => {
    const target = { "3": [1, 0, 0], "1": [0, 1, 0], "0": [0, 0, 1] }[actual];
    if (!target) return 0;
    const p = [probs["3"], probs["1"], probs["0"]];
    return (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2;
  }
});

registerMetric("logLoss", {
  direction: "lower-is-better",
  description: "Log Loss(交叉熵): -log P(actual),越低越好",
  fn: (probs, actual) => {
    const p = Number(probs[actual]);
    return -Math.log(Math.max(p, 1e-12));
  }
});

registerMetric("rps", {
  direction: "lower-is-better",
  description: "Ranked Probability Score: 考虑 outcome 顺序的概率距离,越低越好",
  fn: (probs, actual) => {
    // outcome ordering: home(3) → draw(1) → away(0)
    const cumP = [probs["3"], probs["3"] + probs["1"], probs["3"] + probs["1"] + probs["0"]];
    const cumA = actual === "3" ? [1, 1, 1] : actual === "1" ? [0, 1, 1] : [0, 0, 1];
    return 0.5 * ((cumP[0] - cumA[0]) ** 2 + (cumP[1] - cumA[1]) ** 2);
  }
});

registerMetric("hitRate", {
  direction: "higher-is-better",
  description: "Hit Rate: 模型 top-1 outcome 跟实际一致的比例",
  fn: (probs, actual) => {
    const top = ["3", "1", "0"].sort((a, b) => Number(probs[b]) - Number(probs[a]))[0];
    return top === actual ? 1 : 0;
  }
});

registerMetric("expectedValue", {
  direction: "higher-is-better",
  description: "Average EV at favorite odds (when supplied via samples[i].oddsForFavorite)",
  fn: (probs, actual, sample) => {
    // 注意:这个 metric 需要 sample 提供 favoriteOdds,否则 return 0
    if (!sample?.favoriteOdds) return 0;
    const top = ["3", "1", "0"].sort((a, b) => Number(probs[b]) - Number(probs[a]))[0];
    if (top !== actual) return -1;
    return sample.favoriteOdds - 1;
  }
});

function round(v) {
  return Math.round(v * 10000) / 10000;
}
