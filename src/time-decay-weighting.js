/**
 * Time-Decay Weighting
 * ──────────────────────────────────────────────────
 * 指数衰减给近期比赛更高权重 — 球队战力随时间变化,远期数据需衰减.
 *
 * 模型:
 *   weight(t) = 2^(-Δt / halfLife)
 * 其中 Δt 是离当前的天数,halfLife 默认 90 天(Dixon-Coles 原文).
 *
 * 用途:
 *   - 加权计算 form / xG / ppg
 *   - 加权拟合 Dixon-Coles parameters
 *   - 加权计算 Elo 调整
 */

const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * @param {Date|string|number} matchDate
 * @param {Date|string|number} referenceDate 当前日期(默认 now)
 * @param {number} halfLife 半衰期天数
 */
export function timeWeight(matchDate, referenceDate = Date.now(), halfLife = DEFAULT_HALF_LIFE_DAYS) {
  const t = parseDate(matchDate);
  const ref = parseDate(referenceDate);
  if (!t || !ref) return 1;
  const days = Math.max(0, (ref - t) / (1000 * 60 * 60 * 24));
  return Math.pow(2, -days / halfLife);
}

/**
 * 给一组带 date 的 matches,产权重数组.
 */
export function computeWeights(matches, opts = {}) {
  const referenceDate = opts.referenceDate ?? Date.now();
  const halfLife = opts.halfLife ?? DEFAULT_HALF_LIFE_DAYS;
  return matches.map((m) => timeWeight(m.date ?? m.kickoff ?? m.matchDate, referenceDate, halfLife));
}

/**
 * 加权平均(任意数值字段).
 */
export function weightedAverage(matches, fieldOrFn, opts = {}) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const weights = computeWeights(matches, opts);
  const getter = typeof fieldOrFn === "function" ? fieldOrFn : (m) => Number(m[fieldOrFn]);
  let wSum = 0, vwSum = 0;
  for (let i = 0; i < matches.length; i++) {
    const v = getter(matches[i]);
    if (!Number.isFinite(v)) continue;
    wSum += weights[i];
    vwSum += v * weights[i];
  }
  return wSum > 0 ? round(vwSum / wSum) : null;
}

/**
 * 加权 form / PPG.
 */
export function weightedPpg(matches, opts = {}) {
  return weightedAverage(matches, (m) => {
    if (m.result === "W" || m.won === "W") return 3;
    if (m.result === "D" || m.won === "D") return 1;
    return 0;
  }, opts);
}

/**
 * 加权 xG-for / xG-against.
 */
export function weightedXg(matches, opts = {}) {
  return {
    xgFor: weightedAverage(matches, "xgFor", opts),
    xgAgainst: weightedAverage(matches, "xgAgainst", opts),
    halfLife: opts.halfLife ?? DEFAULT_HALF_LIFE_DAYS,
    sampleSize: matches.length
  };
}

/**
 * 加权 Elo 增量(老比赛的 Elo 变动权重低).
 */
export function effectiveSampleSize(matches, opts = {}) {
  const weights = computeWeights(matches, opts);
  const sum = weights.reduce((s, w) => s + w, 0);
  const sumSq = weights.reduce((s, w) => s + w * w, 0);
  if (sumSq === 0) return 0;
  return round(sum * sum / sumSq);
}

function parseDate(d) {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "number") return d;
  if (typeof d === "string") {
    const t = Date.parse(d);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
