/**
 * 健康监控指标(2026-06-15 新功能:防脏防陈)——纯函数,供 audit-health-monitor 用。
 *  ① assessFreshness:各数据源最新文件距今多久、是否超阈值陈旧(审计发现 crawler 停滞 1d7h)。
 *  ② bucketReliability:各概率桶 favorite 预测 vs 实际命中 的 gap(把"55-65桶失准"这类
 *     此前靠人工偶然发现的校准漂移,变成可常驻监控的量化指标)。
 */

const DEFAULT_THRESHOLDS = { fixtures: 36, market: 48, advanced: 48, crawler: 96, "world-cup": 72 };

/**
 * @param {Array<{source:string, latestFile:string|null, mtimeMs:number|null}>} sources
 * @param {number} now epoch ms
 * @param {Object} [thresholds] 各源陈旧阈值(小时),覆盖默认
 * @returns {Array<{source, latestFile, ageHours, limitHours, stale, missing}>}
 */
export function assessFreshness(sources, now, thresholds = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  return (Array.isArray(sources) ? sources : []).map((s) => {
    const limit = limits[s.source] ?? 48;
    if (!s.mtimeMs) return { source: s.source, latestFile: s.latestFile ?? null, ageHours: null, limitHours: limit, stale: true, missing: true };
    const ageHours = Math.round(((now - s.mtimeMs) / 3600e3) * 10) / 10;
    return { source: s.source, latestFile: s.latestFile ?? null, ageHours, limitHours: limit, stale: ageHours > limit, missing: false };
  });
}

/**
 * 从 (predicted favorite 概率, 是否命中) 对算各桶 reliability gap。
 * @param {Array<{predicted:number, hit:0|1|boolean}>} pairs
 * @param {number} [minSamples] 报"系统性失准"的最小桶样本(默认 20,低于此只报样本不足)
 * @returns {Array<{bucket, samples, predicted, actual, gap, flagged}>}
 */
export function bucketReliability(pairs, minSamples = 20) {
  const defs = [["33-45", 0, 0.45], ["45-55", 0.45, 0.55], ["55-65", 0.55, 0.65], ["65-100", 0.65, 1.01]];
  return defs.map(([bucket, lo, hi]) => {
    const sub = (Array.isArray(pairs) ? pairs : []).filter((p) => Number.isFinite(p.predicted) && p.predicted >= lo && p.predicted < hi);
    if (!sub.length) return { bucket, samples: 0, predicted: null, actual: null, gap: null, flagged: false };
    const predicted = sub.reduce((s, p) => s + p.predicted, 0) / sub.length;
    const actual = sub.reduce((s, p) => s + (p.hit ? 1 : 0), 0) / sub.length;
    const gap = actual - predicted;
    return {
      bucket, samples: sub.length,
      predicted: +predicted.toFixed(4), actual: +actual.toFixed(4), gap: +gap.toFixed(4),
      // 仅样本足够才标记系统性失准(防薄样本噪声误报)
      flagged: sub.length >= minSamples && Math.abs(gap) > 0.12
    };
  });
}
