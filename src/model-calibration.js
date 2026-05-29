import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const profilePath = join(exportDir, "backtest-calibration-profile.json");

const OUTCOME_KEYS = ["home", "draw", "away"];

export function loadCalibrationProfile(path = profilePath) {
  if (!existsSync(path)) return emptyProfile("missing-profile");
  try {
    const profile = JSON.parse(readFileSync(path, "utf8"));
    return normalizeProfile(profile);
  } catch (error) {
    return emptyProfile(`invalid-profile:${error.message}`);
  }
}

export function calibrateProbabilities(probabilities, profile = emptyProfile(), context = {}) {
  const normalized = normalizeProbabilities(probabilities);
  const favorite = favoriteOutcome(normalized);
  const bucket = probabilityBucket(favorite.probability);
  if (!profile.usable) {
    // 冷启动:profile 不可用时,套一层"favorite-longshot bias"先验。
    // 学术与博彩历史一致表明:赔率市场对高概率主队普遍高估 2~5 个点,
    // 对长程冷门低估同等程度。这里对 ≥0.65 的强主队累进收缩,是已知行为的
    // 最小修正。一旦 calibration profile 通过 backtest 训练出来,这条先验会被覆盖。
    //
    // 闸门(2026-05-29,赔率版 walk-forward 验证):当 prior 已由市场赔率混合得出
    // (hasMarketPrior),其 65%+ 桶已近完美校准(实测 gap -0.001),再套 cold-start
    // 收缩会过度收缩(→ +0.042 反向偏差)。收缩只应在**无赔率**的弱 prior 上生效。
    if (context.hasMarketPrior) {
      return { probabilities: normalized, calibration: { applied: false, reason: "market-prior-already-calibrated", bucket, scope: "skip-cold-start" } };
    }
    return applyColdStartCalibration(normalized, favorite, bucket, profile.reason);
  }
  // 优先级 0(新增 2026-05-28):isotonic regression 映射
  // 学术界对 calibration 的标准做法。从 (predicted, actual) 对学单调非递减映射,
  // 比 "bucket shift" 精度高。仅在样本 ≥30(buildIsotonicMap 时已经检查)时启用。
  if (profile.isotonicMap?.knots?.length) {
    const isotonicTarget = applyIsotonicMap(profile.isotonicMap, favorite.probability);
    if (Number.isFinite(isotonicTarget)) {
      const clamped = clamp(
        isotonicTarget,
        Math.max(1 / 3, favorite.probability - profile.maxShift * 1.5),
        Math.min(0.85, favorite.probability + profile.maxShift * 1.5)
      );
      const calibrated = moveFavoriteProbability(normalized, favorite.key, clamped);
      return {
        probabilities: calibrated,
        calibration: {
          applied: true,
          source: "isotonic-regression",
          scope: "isotonic",
          bucket,
          samples: profile.isotonicMap.samples,
          adjustment: round(clamped - favorite.probability),
          context: {
            marketType: context.fixture?.marketType ?? "",
            competition: context.fixture?.competition ?? ""
          }
        }
      };
    }
  }
  const competition = context.fixture?.competition ?? "";
  const competitionRule = profile.byCompetition?.[competition];
  const bucketRule = profile.buckets?.[bucket];
  // 优先级：联赛专属规则（样本足够）> 概率分桶规则 > 全局规则
  let rule = profile.global;
  let ruleScope = "global";
  if (bucketRule?.samples >= profile.minBucketSamples) {
    rule = bucketRule;
    ruleScope = `bucket:${bucket}`;
  }
  if (competitionRule?.samples >= profile.minBucketSamples) {
    rule = competitionRule;
    ruleScope = `competition:${competition}`;
  }
  if (!rule || rule.samples < profile.minSamples) {
    return applyColdStartCalibration(normalized, favorite, bucket, "insufficient-calibration-samples");
  }
  const targetFavorite = clamp(
    favorite.probability + rule.adjustment,
    Math.max(1 / 3, favorite.probability - profile.maxShift),
    Math.min(0.82, favorite.probability + profile.maxShift)
  );
  const calibrated = moveFavoriteProbability(normalized, favorite.key, targetFavorite);
  return {
    probabilities: calibrated,
    calibration: {
      applied: true,
      source: profile.source,
      bucket,
      scope: ruleScope,
      samples: rule.samples,
      predictedHitRate: round(rule.predictedHitRate),
      actualHitRate: round(rule.actualHitRate),
      adjustment: round(targetFavorite - favorite.probability),
      context: {
        marketType: context.fixture?.marketType ?? "",
        competition: context.fixture?.competition ?? ""
      }
    }
  };
}

export function buildCalibrationProfileFromRows(rows, options = {}) {
  const settled = rows.map(toCalibrationRow).filter(Boolean);
  const minSamples = Number(options.minSamples ?? 20);
  const minBucketSamples = Number(options.minBucketSamples ?? 8);
  const maxShift = Number(options.maxShift ?? 0.055);
  const global = buildRule(settled, maxShift);
  const buckets = Object.fromEntries(["33-45", "45-55", "55-65", "65-100"].map((bucket) => [bucket, buildRule(settled.filter((row) => row.bucket === bucket), maxShift)]));
  // 新增:Isotonic regression 映射(2026-05-28 B 档 #1)
  // 在样本足够时(≥30)从 (predicted_probability, hit:0/1) 学一个单调非递减映射,
  // 比 "bucket shift adjustment" 更精细。calibrateProbabilities 会优先用 isotonic,
  // 失败时回退到 bucket/global rules,再回退到 cold-start prior。
  const isotonicMap = settled.length >= Number(options.minIsotonicSamples ?? 30)
    ? buildIsotonicMap(settled.map((row) => ({ predicted: row.favorite.probability, actual: row.hit ? 1 : 0 })))
    : null;
  return normalizeProfile({
    source: "daily-recap-ledger",
    generatedAt: new Date().toISOString(),
    usable: settled.length >= minSamples,
    reason: settled.length >= minSamples ? "ok" : "insufficient-settled-samples",
    samples: settled.length,
    minSamples,
    minBucketSamples,
    maxShift,
    global,
    buckets,
    isotonicMap,
    byRisk: groupRules(settled, (row) => row.risk || "unknown", maxShift),
    byMarketType: groupRules(settled, (row) => row.marketType || "unknown", maxShift),
    byCompetition: groupRules(settled, (row) => row.competition || "unknown", maxShift)
  });
}

// Isotonic regression via Pool Adjacent Violators (PAV).
// 输入:[{ predicted: 0.x, actual: 0|1 }, ...]  (任意顺序)
// 输出:{ knots: [{ predicted, calibrated }, ...] } — 单调非递减的分段常数映射
// 复杂度 O(n log n) 排序 + O(n) PAV 合并。
export function buildIsotonicMap(observations) {
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const sorted = observations
    .filter((row) => Number.isFinite(row.predicted) && Number.isFinite(row.actual))
    .map((row) => ({ predicted: row.predicted, actual: row.actual }))
    .sort((a, b) => a.predicted - b.predicted);
  if (sorted.length < 2) return null;
  // 初始化每个点为单独 block (weight=1, mean=actual)
  const blocks = sorted.map((row) => ({
    minPredicted: row.predicted,
    maxPredicted: row.predicted,
    weight: 1,
    mean: row.actual
  }));
  // PAV: 从左到右合并违反单调性的相邻 block
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].mean > blocks[i + 1].mean) {
      const merged = {
        minPredicted: blocks[i].minPredicted,
        maxPredicted: blocks[i + 1].maxPredicted,
        weight: blocks[i].weight + blocks[i + 1].weight,
        mean: (blocks[i].mean * blocks[i].weight + blocks[i + 1].mean * blocks[i + 1].weight) / (blocks[i].weight + blocks[i + 1].weight)
      };
      blocks.splice(i, 2, merged);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  return {
    knots: blocks.map((b) => ({
      predictedMin: round(b.minPredicted),
      predictedMax: round(b.maxPredicted),
      calibrated: round(b.mean),
      weight: b.weight
    })),
    samples: sorted.length
  };
}

// 给一个预测概率,从 isotonic map 取校准后的概率。线性插值用 block 边界。
export function applyIsotonicMap(map, predicted) {
  if (!map?.knots?.length || !Number.isFinite(predicted)) return null;
  const knots = map.knots;
  // 边界处理
  if (predicted <= knots[0].predictedMin) return knots[0].calibrated;
  if (predicted >= knots[knots.length - 1].predictedMax) return knots[knots.length - 1].calibrated;
  // 找命中 block,直接返回(分段常数)。如果在 block 之间的"空隙",做线性插值。
  for (let i = 0; i < knots.length; i++) {
    if (predicted >= knots[i].predictedMin && predicted <= knots[i].predictedMax) {
      return knots[i].calibrated;
    }
    if (i < knots.length - 1 && predicted > knots[i].predictedMax && predicted < knots[i + 1].predictedMin) {
      const t = (predicted - knots[i].predictedMax) / (knots[i + 1].predictedMin - knots[i].predictedMax);
      return knots[i].calibrated + t * (knots[i + 1].calibrated - knots[i].calibrated);
    }
  }
  return null;
}

function toCalibrationRow(row) {
  const actual = actualCode(row);
  const probabilities = probabilitySet(row);
  if (!actual || !probabilities) return null;
  const favorite = favoriteOutcome(probabilities);
  return {
    actual,
    probabilities,
    favorite,
    hit: favorite.code === actual,
    bucket: probabilityBucket(favorite.probability),
    risk: row.risk,
    marketType: row.marketType,
    competition: row.competition
  };
}

function buildRule(rows, maxShift) {
  if (!rows.length) return { samples: 0, predictedHitRate: null, actualHitRate: null, adjustment: 0 };
  const predictedHitRate = rows.reduce((sum, row) => sum + row.favorite.probability, 0) / rows.length;
  const actualHitRate = rows.filter((row) => row.hit).length / rows.length;
  return {
    samples: rows.length,
    predictedHitRate: round(predictedHitRate),
    actualHitRate: round(actualHitRate),
    adjustment: round(clamp((actualHitRate - predictedHitRate) * 0.5, -maxShift, maxShift))
  };
}

function groupRules(rows, keyFn, maxShift) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].map(([key, groupRows]) => [key, buildRule(groupRows, maxShift)]));
}

function normalizeProfile(profile) {
  return {
    source: profile.source ?? "unknown",
    generatedAt: profile.generatedAt ?? null,
    usable: Boolean(profile.usable),
    reason: profile.reason ?? (profile.usable ? "ok" : "not-usable"),
    samples: Number(profile.samples ?? profile.global?.samples ?? 0),
    minSamples: Number(profile.minSamples ?? 20),
    minBucketSamples: Number(profile.minBucketSamples ?? 8),
    maxShift: Number(profile.maxShift ?? 0.055),
    global: profile.global ?? { samples: 0, adjustment: 0 },
    buckets: profile.buckets ?? {},
    isotonicMap: profile.isotonicMap ?? null,
    byRisk: profile.byRisk ?? {},
    byMarketType: profile.byMarketType ?? {},
    byCompetition: profile.byCompetition ?? {}
  };
}

function emptyProfile(reason = "not-configured") {
  return normalizeProfile({ usable: false, reason, samples: 0 });
}

const COLD_START_FAVORITE_THRESHOLD = 0.65;
const COLD_START_SHRINK_TOWARD = 0.6;
const COLD_START_SHRINK_FRACTION = 0.15;
// 累进收缩:walk-forward 回测显示 65%+ 强热门仍系统性过度自信(预测 0.75 / 实际 0.67)。
// favorite-longshot bias 对越极端的热门越强,故收缩比例随 favorite 超过 0.70 的部分线性增大。
const COLD_START_SHRINK_PROGRESSIVE_FROM = 0.70;
const COLD_START_SHRINK_PROGRESSIVE_SLOPE = 2.2;
const COLD_START_SHRINK_FRACTION_CAP = 0.45;

function coldStartShrinkFraction(probability) {
  const extra = Math.max(0, probability - COLD_START_SHRINK_PROGRESSIVE_FROM) * COLD_START_SHRINK_PROGRESSIVE_SLOPE;
  return Math.min(COLD_START_SHRINK_FRACTION_CAP, COLD_START_SHRINK_FRACTION + extra);
}

function applyColdStartCalibration(normalized, favorite, bucket, reason) {
  if (favorite.probability < COLD_START_FAVORITE_THRESHOLD) {
    return { probabilities: normalized, calibration: { applied: false, reason, bucket, scope: "cold-start-no-op" } };
  }
  const fraction = coldStartShrinkFraction(favorite.probability);
  const targetFavorite = favorite.probability - (favorite.probability - COLD_START_SHRINK_TOWARD) * fraction;
  const calibrated = moveFavoriteProbability(normalized, favorite.key, targetFavorite);
  return {
    probabilities: calibrated,
    calibration: {
      applied: true,
      source: "cold-start-favorite-longshot-prior",
      bucket,
      scope: "cold-start",
      samples: 0,
      reason,
      adjustment: round(targetFavorite - favorite.probability)
    }
  };
}

function probabilitySet(row) {
  const probabilities = {
    home: Number(row.probabilityHome),
    draw: Number(row.probabilityDraw),
    away: Number(row.probabilityAway)
  };
  const total = OUTCOME_KEYS.reduce((sum, key) => sum + probabilities[key], 0);
  if (!OUTCOME_KEYS.every((key) => Number.isFinite(probabilities[key])) || total <= 0) return null;
  return normalizeProbabilities(probabilities);
}

function actualCode(row) {
  const value = String(row.actualCode ?? row.actual ?? "").trim();
  if (["3", "主胜", "home", "胜"].includes(value)) return "home";
  if (["1", "平局", "draw", "平"].includes(value)) return "draw";
  if (["0", "客胜", "away", "负"].includes(value)) return "away";
  return "";
}

function favoriteOutcome(probabilities) {
  const key = OUTCOME_KEYS.map((item) => ({ key: item, probability: probabilities[item] })).sort((left, right) => right.probability - left.probability)[0].key;
  return { key, code: key, probability: probabilities[key] };
}

function probabilityBucket(probability) {
  if (probability < 0.45) return "33-45";
  if (probability < 0.55) return "45-55";
  if (probability < 0.65) return "55-65";
  return "65-100";
}

function moveFavoriteProbability(probabilities, favoriteKey, targetFavorite) {
  const currentFavorite = probabilities[favoriteKey];
  const otherKeys = OUTCOME_KEYS.filter((key) => key !== favoriteKey);
  const otherTotal = otherKeys.reduce((sum, key) => sum + probabilities[key], 0);
  const remaining = 1 - targetFavorite;
  const moved = { [favoriteKey]: targetFavorite };
  for (const key of otherKeys) moved[key] = otherTotal > 0 ? probabilities[key] * remaining / otherTotal : remaining / otherKeys.length;
  return roundedProbabilitySet(moved);
}

function normalizeProbabilities(values) {
  const total = OUTCOME_KEYS.reduce((sum, key) => sum + Number(values[key] ?? 0), 0);
  if (!Number.isFinite(total) || total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return roundedProbabilitySet(Object.fromEntries(OUTCOME_KEYS.map((key) => [key, Number(values[key] ?? 0) / total])));
}

function roundedProbabilitySet(values) {
  const home = round(values.home);
  const draw = round(values.draw);
  return { home, draw, away: round(1 - home - draw) };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
