/**
 * K-fold 时间序列 Cross Validation
 * ──────────────────────────────────────────────────
 * 把 ledger 按时间切 K 折,每折用前面训练 + 后面评估,识别"模型对最近样本过拟合".
 *
 * 时间序列 CV 区别于普通 CV:
 *   - 不能随机洗牌(信息泄露)
 *   - 用 expanding window(前 i 折训练 → 第 i+1 折评估)
 *
 * 用途:
 *   1. 比较多个模型的 out-of-sample 表现
 *   2. 识别 stacker 过拟合(in-sample 高 / out-of-sample 暴跌)
 *   3. 选最优超参(K-fold mean RPS 最小)
 */

/**
 * @param {Array} rows  按时间升序的 ledger rows
 * @param {Function} trainEvalFn  (trainRows, evalRows) → { metric: number }
 * @param {Object} opts
 *   folds: K-fold 数,默认 5
 *   minTrainSize: 第一个 fold 最小训练集,默认 30
 */
export function crossValidate(rows, trainEvalFn, opts = {}) {
  const folds = opts.folds ?? 5;
  const minTrainSize = opts.minTrainSize ?? 30;
  if (!Array.isArray(rows) || rows.length < minTrainSize + folds) {
    return { ok: false, reason: `insufficient-rows:${rows?.length ?? 0}` };
  }

  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const evalSize = Math.floor((sorted.length - minTrainSize) / folds);
  if (evalSize < 1) return { ok: false, reason: "insufficient-eval-size-per-fold" };

  const foldResults = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd = minTrainSize + f * evalSize;
    const evalEnd = trainEnd + evalSize;
    const trainRows = sorted.slice(0, trainEnd);
    const evalRows = sorted.slice(trainEnd, evalEnd);
    if (!evalRows.length) break;
    let metrics;
    try {
      metrics = trainEvalFn(trainRows, evalRows);
    } catch (error) {
      metrics = { error: error.message };
    }
    foldResults.push({
      fold: f + 1,
      trainSize: trainRows.length,
      evalSize: evalRows.length,
      evalDateRange: [evalRows[0]?.date, evalRows[evalRows.length - 1]?.date],
      metrics
    });
  }

  // 聚合 metrics(对每个数字字段取均值 + std)
  const aggregated = aggregateFoldMetrics(foldResults);
  return {
    ok: true,
    folds: foldResults.length,
    foldResults,
    aggregated,
    overfittingSignal: detectOverfitting(foldResults)
  };
}

function aggregateFoldMetrics(folds) {
  const keys = new Set();
  for (const f of folds) {
    if (f.metrics && !f.metrics.error) {
      for (const k of Object.keys(f.metrics)) {
        if (Number.isFinite(f.metrics[k])) keys.add(k);
      }
    }
  }
  const out = {};
  for (const k of keys) {
    const values = folds.map((f) => Number(f.metrics?.[k])).filter(Number.isFinite);
    if (!values.length) continue;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / Math.max(1, values.length - 1);
    out[k] = {
      mean: round(mean),
      std: round(Math.sqrt(variance)),
      values: values.map(round),
      stability: variance < (Math.abs(mean) * 0.1) ? "稳定" : variance < (Math.abs(mean) * 0.3) ? "中等" : "不稳定"
    };
  }
  return out;
}

function detectOverfitting(folds) {
  // 简单启发:第一个 fold 的 metric 跟最后一个 fold 是否显著恶化
  if (folds.length < 3) return null;
  const first = folds[0].metrics;
  const last = folds[folds.length - 1].metrics;
  if (!first || !last) return null;
  const rpsKey = "rps" in first ? "rps" : null;
  if (!rpsKey) return null;
  const firstRps = first[rpsKey];
  const lastRps = last[rpsKey];
  if (!Number.isFinite(firstRps) || !Number.isFinite(lastRps)) return null;
  if (lastRps > firstRps * 1.2) {
    return { detected: true, signal: `最后 fold RPS(${round(lastRps)}) 显著高于第一 fold RPS(${round(firstRps)})`, severity: "possible-overfitting" };
  }
  return { detected: false, signal: "fold 间 RPS 稳定" };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
