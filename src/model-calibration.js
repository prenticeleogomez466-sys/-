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
  if (!profile.usable) {
    return { probabilities: normalized, calibration: { applied: false, reason: profile.reason ?? "not-usable" } };
  }
  const favorite = favoriteOutcome(normalized);
  const bucket = probabilityBucket(favorite.probability);
  const bucketRule = profile.buckets?.[bucket];
  const rule = bucketRule?.samples >= profile.minBucketSamples ? bucketRule : profile.global;
  if (!rule || rule.samples < profile.minSamples) {
    return { probabilities: normalized, calibration: { applied: false, reason: "insufficient-calibration-samples", bucket } };
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
    byRisk: groupRules(settled, (row) => row.risk || "unknown", maxShift),
    byMarketType: groupRules(settled, (row) => row.marketType || "unknown", maxShift)
  });
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
    marketType: row.marketType
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
    byRisk: profile.byRisk ?? {},
    byMarketType: profile.byMarketType ?? {}
  };
}

function emptyProfile(reason = "not-configured") {
  return normalizeProfile({ usable: false, reason, samples: 0 });
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
