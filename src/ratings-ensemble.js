/**
 * 评级 ensemble:把多种球队评级方法的预测加权融合
 * ──────────────────────────────────────────────────
 * 当前接入:
 *   - ClubElo / Elo 评级(advanced-data-runner 已用)
 *   - Pi-ratings(主客分维度,2026-05-28 加)
 *   - Massey 评级(基于进球差,2026-05-28 加)
 *   - Colley 评级(基于胜平负,2026-05-28 加)
 *   - Dixon-Coles 比分矩阵(prediction-engine 已用)
 *   - Bivariate Poisson(2026-05-28 加,作为 DC 对照)
 *
 * 设计原则:
 *   1. 每个评级方法独立给出 { home, draw, away } 预测,然后加权平均
 *   2. 权重可调(默认等权);或通过历史 backtest 表现自适应
 *   3. 任何方法缺数据/失败,自动降权 0
 *   4. 最终输出归一化概率
 *
 * 用法:
 *   const ensemble = buildEnsemblePrediction({
 *     elo: { home: 0.55, draw: 0.25, away: 0.20 },
 *     pi: { home: 0.52, draw: 0.27, away: 0.21 },
 *     massey: { home: 0.50, draw: 0.30, away: 0.20 },
 *     colley: { home: 0.48, draw: 0.30, away: 0.22 },
 *     dixonColes: { home: 0.53, draw: 0.26, away: 0.21 },
 *     bivariatePoisson: { home: 0.51, draw: 0.28, away: 0.21 }
 *   }, { weights: { elo: 0.15, pi: 0.20, massey: 0.15, colley: 0.10, dixonColes: 0.30, bivariatePoisson: 0.10 } });
 *
 *   ensemble: { probabilities: {...}, source: "ensemble", contributions: {...} }
 */

const DEFAULT_WEIGHTS = {
  odds: 0.20,               // 赔率隐含(市场共识)是 ensemble 一票
  elo: 0.12,
  pi: 0.15,
  massey: 0.10,
  colley: 0.08,
  dixonColes: 0.25,         // DC 权重最高,因为它的输出最完整(比分矩阵)
  bivariatePoisson: 0.10
};

const OUTCOMES = ["home", "draw", "away"];

export function buildEnsemblePrediction(predictions, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };

  // 过滤掉 null / 不完整的预测
  const valid = {};
  for (const [method, pred] of Object.entries(predictions)) {
    if (!pred) continue;
    const probs = OUTCOMES.map((k) => Number(pred[k]));
    if (!probs.every(Number.isFinite)) continue;
    const total = probs.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    valid[method] = { home: probs[0] / total, draw: probs[1] / total, away: probs[2] / total };
  }

  if (!Object.keys(valid).length) {
    return { ok: false, reason: "no-valid-predictions", probabilities: { home: 1/3, draw: 1/3, away: 1/3 } };
  }

  // 计算加权平均(归一化使用到的方法的权重)
  let totalWeight = 0;
  const sum = { home: 0, draw: 0, away: 0 };
  const contributions = {};
  for (const method of Object.keys(valid)) {
    const w = Number(weights[method] ?? 0);
    if (w <= 0) continue;
    totalWeight += w;
    for (const k of OUTCOMES) sum[k] += w * valid[method][k];
    contributions[method] = { weight: w, prediction: valid[method] };
  }
  if (totalWeight === 0) {
    // fallback: 等权
    const n = Object.keys(valid).length;
    for (const method of Object.keys(valid)) {
      totalWeight += 1;
      for (const k of OUTCOMES) sum[k] += valid[method][k];
      contributions[method] = { weight: 1, prediction: valid[method] };
    }
  }
  const probabilities = {
    home: round(sum.home / totalWeight),
    draw: round(sum.draw / totalWeight),
    away: round(sum.away / totalWeight)
  };
  // 重新归一化(防 round 误差)
  const t = probabilities.home + probabilities.draw + probabilities.away;
  if (t > 0) {
    probabilities.home = round(probabilities.home / t);
    probabilities.draw = round(probabilities.draw / t);
    probabilities.away = round(1 - probabilities.home - probabilities.draw);
  }

  return {
    ok: true,
    source: "ensemble(" + Object.keys(contributions).join("+") + ")",
    probabilities,
    contributions,
    totalWeight,
    weights
  };
}

/**
 * 从历史 backtest 数据自动调权:用 RPS 反向加权(RPS 越低权重越大).
 * @param {Array} backtestPerMethod  [{method, rps, samples}, ...]
 * @returns {Object} weights
 */
export function adaptiveWeightsFromBacktest(backtestPerMethod) {
  if (!Array.isArray(backtestPerMethod) || backtestPerMethod.length === 0) {
    return { ...DEFAULT_WEIGHTS };
  }
  const eligible = backtestPerMethod.filter((m) => Number.isFinite(m.rps) && m.samples >= 10);
  if (!eligible.length) return { ...DEFAULT_WEIGHTS };
  // Inverse RPS:越低权重越大
  const inverses = eligible.map((m) => ({ method: m.method, inv: 1 / Math.max(0.01, m.rps) }));
  const total = inverses.reduce((s, x) => s + x.inv, 0);
  const weights = {};
  for (const x of inverses) weights[x.method] = round(x.inv / total);
  return weights;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
