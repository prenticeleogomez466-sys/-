/**
 * Calibration Trainer(W 档 — 数据驱动校准,取代 cold-start 硬编码先验)
 * ────────────────────────────────────────────────────────────
 * 此前 backtest-calibration-profile.json 只能由 daily-recap ledger 产出,
 * 但 ledger 长期只有个位数结算样本(usable:false),生产环境 calibration
 * 实际一直退回 cold-start favorite-longshot 硬编码收缩。这里改用 football-data
 * 五大联赛历史跑 leak-safe walk-forward,把"模型预测的 favorite 概率 → 真实命中"
 * 这条关系**学出来**,产出可用 isotonic profile。
 *
 * 关键设计 —— 两张独立 isotonic map(因两条路径失准方向相反):
 *   isotonicMap        —— 纯 Dixon-Coles 路径(无赔率)。回测显示 65%+ 强热门
 *                          系统性过度自信(预测 0.75 / 实际 0.67),要往下拉。
 *   isotonicMapMarket  —— blend(赔率+DC)路径。市场赔率已含全部公开信息、近完美
 *                          校准,这张映射近恒等,只做最小修正,避免误伤。
 * calibrateProbabilities 按 context.hasMarketPrior 选用对应映射。
 *
 * 防泄漏:每个测试日只用严格早于该日的比赛拟合 DC;refit 按周节流(DC 参数日际
 * 变化极小),拟合永远基于 refit 当日之前的数据,应用到 >= 该日的比赛 —— 不偷看未来。
 */

import { fitFromMatches, predictFromFitted, blendWithOdds } from "./dixon-coles-engine.js";
import { loadFootballDataMatches } from "./footballdata-loader.js";
import { canonicalTeamName } from "./team-aliases.js";
import { buildIsotonicMap } from "./model-calibration.js";

const OUTCOMES = ["home", "draw", "away"];
const BUCKET_KEYS = ["33-45", "45-55", "55-65", "65-100"];

function actualOutcome(hg, ag) {
  if (hg > ag) return "home";
  if (hg < ag) return "away";
  return "draw";
}

function favoriteOf(probs) {
  const key = OUTCOMES.reduce((best, o) => (probs[o] > probs[best] ? o : best), "home");
  return { key, probability: probs[key] };
}

function bucketOf(p) {
  if (p < 0.45) return "33-45";
  if (p < 0.55) return "45-55";
  if (p < 0.65) return "55-65";
  return "65-100";
}

function avg(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v) {
  return Math.round((v + Number.EPSILON) * 10000) / 10000;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(b - a) / 86400000;
}

function ruleFrom(rows, maxShift) {
  if (!rows.length) return { samples: 0, predictedHitRate: null, actualHitRate: null, adjustment: 0 };
  const pred = avg(rows.map((r) => r.predicted));
  const act = avg(rows.map((r) => r.hit));
  return {
    samples: rows.length,
    predictedHitRate: round(pred),
    actualHitRate: round(act),
    adjustment: round(clamp((act - pred) * 0.5, -maxShift, maxShift))
  };
}

function buildRulesFromPairs(pairs, maxShift, minIsotonicSamples) {
  const reliability = {};
  const buckets = {};
  for (const bk of BUCKET_KEYS) {
    const sub = pairs.filter((p) => p.bucket === bk);
    buckets[bk] = ruleFrom(sub, maxShift);
    const predicted = sub.length ? round(avg(sub.map((p) => p.predicted))) : null;
    const actual = sub.length ? round(avg(sub.map((p) => p.hit))) : null;
    reliability[bk] = { samples: sub.length, predicted, actual, gap: sub.length ? round(actual - predicted) : null };
  }
  return {
    global: ruleFrom(pairs, maxShift),
    buckets,
    reliability,
    isotonicMap: pairs.length >= minIsotonicSamples
      ? buildIsotonicMap(pairs.map((p) => ({ predicted: p.predicted, actual: p.hit })))
      : null
  };
}

/**
 * 跑 walk-forward,收集 favorite (predicted, hit) 对,训练 calibration profile。
 * @param {Object} opts
 *   refitEvery       DC 重拟合节流天数(default 7)
 *   minTrainMatches  开始测试前的最小训练样本(default 400)
 *   maxTrainMatches  每次拟合最多用最近多少场(控速,default 2000)
 *   maxShift         bucket/global 调整封顶(default 0.06)
 *   minSamples       profile usable 门槛(default 200)
 *   minBucketSamples 分桶规则生效门槛(default 30)
 *   minIsotonicSamples isotonic map 训练门槛(default 200)
 *   startDate        只用此日期之后的赛果当测试集(可选,加速)
 *   leagues/seasons/fetch 透传 football-data 加载器
 * @returns {Promise<{ok, profile?, loaded?, reason?}>}
 */
export async function trainCalibrationProfile(opts = {}) {
  const refitEvery = opts.refitEvery ?? 7;
  const minTrainMatches = opts.minTrainMatches ?? 400;
  const maxTrainMatches = opts.maxTrainMatches ?? 2000;
  const maxShift = opts.maxShift ?? 0.06;
  const minSamples = opts.minSamples ?? 200;
  const minBucketSamples = opts.minBucketSamples ?? 30;
  const minIsotonicSamples = opts.minIsotonicSamples ?? 200;

  const loaded = await loadFootballDataMatches({ leagues: opts.leagues, seasons: opts.seasons, fetch: opts.fetch });
  if (!loaded.ok) return { ok: false, reason: "football-data 加载失败(网络?)" };

  const matches = loaded.matches.map((m) => ({
    ...m,
    homeCanon: canonicalTeamName(m.home),
    awayCanon: canonicalTeamName(m.away)
  }));

  let dates = [...new Set(matches.map((m) => m.date))].sort();
  if (opts.startDate) dates = dates.filter((d) => d >= opts.startDate);

  const dcPairs = [];
  const marketPairs = [];
  let fit = null;
  let lastFitDate = null;
  let usedDates = 0;
  let skipped = 0;

  for (const date of dates) {
    const prior = matches.filter((m) => m.date < date);
    if (prior.length < minTrainMatches) { skipped++; continue; }
    if (!fit || daysBetween(lastFitDate, date) >= refitEvery) {
      const train = prior.slice(-maxTrainMatches);
      const f = fitFromMatches(train, { referenceDate: date });
      if (f?.usable) { fit = f; lastFitDate = date; }
    }
    if (!fit) { skipped++; continue; }
    usedDates++;
    const day = matches.filter((m) => m.date === date);
    for (const m of day) {
      const a = actualOutcome(m.homeGoals, m.awayGoals);
      const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
      if (!pred?.probabilities) continue;
      const dcFav = favoriteOf(pred.probabilities);
      dcPairs.push({ predicted: dcFav.probability, hit: dcFav.key === a ? 1 : 0, bucket: bucketOf(dcFav.probability) });
      if (m.odds) {
        const blended = blendWithOdds(m.odds, pred, { competition: m.league });
        const bp = blended.probabilities ?? m.odds;
        const bf = favoriteOf(bp);
        marketPairs.push({ predicted: bf.probability, hit: bf.key === a ? 1 : 0, bucket: bucketOf(bf.probability) });
      }
    }
  }

  const dcRules = buildRulesFromPairs(dcPairs, maxShift, minIsotonicSamples);
  const marketRules = buildRulesFromPairs(marketPairs, maxShift, minIsotonicSamples);

  const profile = {
    source: "football-data-walkforward",
    usable: dcPairs.length >= minSamples,
    reason: dcPairs.length >= minSamples ? "ok" : "insufficient-walkforward-samples",
    samples: dcPairs.length,
    minSamples,
    minBucketSamples,
    maxShift,
    global: dcRules.global,
    buckets: dcRules.buckets,
    isotonicMap: dcRules.isotonicMap,
    isotonicMapMarket: marketRules.isotonicMap,
    reliability: dcRules.reliability,
    marketReliability: marketRules.reliability,
    meta: {
      testDatesUsed: usedDates,
      skippedDates: skipped,
      dcSamples: dcPairs.length,
      marketSamples: marketPairs.length,
      refitEvery,
      minTrainMatches,
      maxTrainMatches,
      leagues: loaded.byLeague
    }
  };

  return { ok: true, profile, loaded: { matches: matches.length, withOdds: loaded.withOdds } };
}
