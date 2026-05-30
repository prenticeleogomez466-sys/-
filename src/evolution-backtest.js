import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCalibrationProfileFromRows } from "./model-calibration.js";
import { buildSignalWeightsProfile, signalWeightsSummary } from "./signal-weight-tuner.js";
import { getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const ledgerPath = join(exportDir, "recommendation-ledger.json");

// 盘上是否已有「数据驱动训练出的、可用的」校准档(非 ledger 版)。
// ledger 版 source 为 daily-recap-ledger 且通常 usable:false;训练版 source 为
// football-data-walkforward 且带 isotonicMap knots。只有后者才算生产权威档。
export function hasUsableTrainedProfile(path) {
  if (!existsSync(path)) return false;
  try {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(
      existing &&
        existing.usable &&
        existing.source &&
        existing.source !== "daily-recap-ledger",
    );
  } catch {
    return false;
  }
}

export function runEvolutionBacktest() {
  const rows = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
  const settled = rows.filter((row) => row.actual);
  const hit = settled.filter((row) => row.hit === true).length;
  const probabilistic = settled.filter((row) => probabilitySet(row));
  const probabilityMetrics = probabilistic.length ? buildProbabilityMetrics(probabilistic) : null;
  const calibrationProfile = buildCalibrationProfileFromRows(settled);
  const summary = {
    total: rows.length,
    settled: settled.length,
    probabilistic: probabilistic.length,
    winDrawLoss: { hit, accuracy: settled.length ? round(hit / settled.length) : null },
    probabilityMetrics,
    reliability: probabilistic.length ? buildReliabilitySummary(probabilistic) : null,
    riskBreakdown: buildRiskBreakdown(settled),
    calibration: {
      usable: calibrationProfile.usable,
      samples: calibrationProfile.samples,
      global: calibrationProfile.global,
      buckets: calibrationProfile.buckets
    }
  };
  mkdirSync(exportDir, { recursive: true });
  const signalProfile = buildSignalWeightsProfile();
  summary.signalWeights = signalWeightsSummary();
  writeFileSync(join(exportDir, "backtest-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  // ledger 版校准档始终写到独立文件留档(供诊断/对比),不碰生产档。
  writeFileSync(
    join(exportDir, "backtest-calibration-profile-ledger.json"),
    `${JSON.stringify(calibrationProfile, null, 2)}\n`,
    "utf8",
  );
  // 生产校准档由 calibration-trainer(isotonic,数据驱动)拥有。仅当盘上没有
  // 已训练的可用档时,才用 ledger 版兜底写入,避免 daily-recap/evolution 自动化
  // 把训练出的 isotonic 档刷回 usable:false 的 ledger 版(W/AI 档了结温度线的成果)。
  const prodProfilePath = join(exportDir, "backtest-calibration-profile.json");
  if (!hasUsableTrainedProfile(prodProfilePath)) {
    writeFileSync(prodProfilePath, `${JSON.stringify(calibrationProfile, null, 2)}\n`, "utf8");
  }
  return summary;
}

function buildProbabilityMetrics(rows) {
  const brier = rows.reduce((sum, row) => sum + brierScore(probabilitySet(row), actualCode(row)), 0) / rows.length;
  const logLoss = rows.reduce((sum, row) => sum + logLossScore(probabilitySet(row), actualCode(row)), 0) / rows.length;
  const rps = rows.reduce((sum, row) => sum + rankedProbabilityScore(probabilitySet(row), actualCode(row)), 0) / rows.length;
  // D 档接入:同时算 ensemble probability 的 RPS,跟主路径对比
  const ensRows = rows.filter((row) => ensembleSet(row));
  let ensembleMetrics = null;
  if (ensRows.length >= 5) {
    const ensBrier = ensRows.reduce((sum, row) => sum + brierScore(ensembleSet(row), actualCode(row)), 0) / ensRows.length;
    const ensRps = ensRows.reduce((sum, row) => sum + rankedProbabilityScore(ensembleSet(row), actualCode(row)), 0) / ensRows.length;
    ensembleMetrics = {
      samples: ensRows.length,
      brier: round(ensBrier),
      rps: round(ensRps),
      versusMain: {
        rpsDelta: round(ensRps - rps),
        recommendation: ensRps < rps - 0.005 ? "切换主路径为 ensemble" : "保持主路径"
      }
    };
  }
  return { brier: round(brier), logLoss: round(logLoss), rps: round(rps), ensemble: ensembleMetrics };
}

function buildReliabilitySummary(rows) {
  const buckets = ["33-45", "45-55", "55-65", "65-100"];
  return Object.fromEntries(buckets.map((bucket) => {
    const bucketRows = rows.filter((row) => probabilityBucket(favoriteProbability(probabilitySet(row))) === bucket);
    if (!bucketRows.length) return [bucket, { samples: 0, predicted: null, actual: null, gap: null }];
    const predicted = bucketRows.reduce((sum, row) => sum + favoriteProbability(probabilitySet(row)), 0) / bucketRows.length;
    const actual = bucketRows.filter((row) => primaryHit(row)).length / bucketRows.length;
    return [bucket, { samples: bucketRows.length, predicted: round(predicted), actual: round(actual), gap: round(actual - predicted) }];
  }));
}

function buildRiskBreakdown(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.risk || "unknown";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].map(([risk, groupRows]) => [risk, {
    samples: groupRows.length,
    accuracy: groupRows.length ? round(groupRows.filter(primaryHit).length / groupRows.length) : null
  }]));
}

function probabilitySet(row) {
  const probabilities = {
    "3": Number(row.probabilityHome),
    "1": Number(row.probabilityDraw),
    "0": Number(row.probabilityAway)
  };
  const total = probabilities["3"] + probabilities["1"] + probabilities["0"];
  if (![probabilities["3"], probabilities["1"], probabilities["0"], total].every(Number.isFinite) || total <= 0) return null;
  return { "3": probabilities["3"] / total, "1": probabilities["1"] / total, "0": probabilities["0"] / total };
}

function ensembleSet(row) {
  const probabilities = {
    "3": Number(row.ensembleHome),
    "1": Number(row.ensembleDraw),
    "0": Number(row.ensembleAway)
  };
  const total = probabilities["3"] + probabilities["1"] + probabilities["0"];
  if (![probabilities["3"], probabilities["1"], probabilities["0"], total].every(Number.isFinite) || total <= 0) return null;
  return { "3": probabilities["3"] / total, "1": probabilities["1"] / total, "0": probabilities["0"] / total };
}

function favoriteProbability(probabilities) {
  return Math.max(probabilities["3"], probabilities["1"], probabilities["0"]);
}

function probabilityBucket(probability) {
  if (probability < 0.45) return "33-45";
  if (probability < 0.55) return "45-55";
  if (probability < 0.65) return "55-65";
  return "65-100";
}

function primaryHit(row) {
  return row.hit === true || outcomeCode(row.primary) === actualCode(row);
}

function outcomeCode(value) {
  const text = String(value ?? "").trim();
  if (["3", "主胜", "涓昏儨", "home"].includes(text)) return "3";
  if (["1", "平局", "骞冲眬", "draw"].includes(text)) return "1";
  if (["0", "客胜", "瀹㈣儨", "away"].includes(text)) return "0";
  return "";
}

function actualCode(row) {
  if (row.actual === "主胜") return "3";
  if (row.actual === "平局") return "1";
  if (row.actual === "客胜") return "0";
  return "";
}

function brierScore(probabilities, actual) {
  return ["3", "1", "0"].reduce((sum, code) => sum + Math.pow((probabilities[code] ?? 0) - (actual === code ? 1 : 0), 2), 0);
}

function logLossScore(probabilities, actual) {
  return -Math.log(Math.max(0.0001, probabilities[actual] ?? 0.0001));
}

function rankedProbabilityScore(probabilities, actual) {
  const order = ["3", "1", "0"];
  let score = 0;
  for (let index = 0; index < order.length - 1; index += 1) {
    const predicted = order.slice(0, index + 1).reduce((sum, code) => sum + (probabilities[code] ?? 0), 0);
    const observed = order.slice(0, index + 1).includes(actual) ? 1 : 0;
    score += Math.pow(predicted - observed, 2);
  }
  return score / (order.length - 1);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(runEvolutionBacktest(), null, 2));
