/**
 * Ensemble Weights Profile 自动学习落盘
 * ──────────────────────────────────────────────────
 * 从 ledger 算每个方法 RPS,autoOptimizeWeights → 写盘.
 * prediction-engine 调 ratings-ensemble 时优先读这个 profile.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getExportDir } from "./paths.js";
import { autoOptimizeWeights } from "./auto-weight-optimizer.js";

const PROFILE_PATH = join(getExportDir(), "ratings-ensemble-weights.json");

export function loadEnsembleWeightsProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  try { return JSON.parse(readFileSync(PROFILE_PATH, "utf8")); } catch { return null; }
}

export function saveEnsembleWeightsProfile(profile) {
  mkdirSync(dirname(PROFILE_PATH), { recursive: true });
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf8");
  return PROFILE_PATH;
}

/**
 * 从 ledger 学最优权重并保存.
 * ledger row 需有 ensembleHome/Draw/Away + probabilityHome/Draw/Away + actual 才能算.
 *
 * @param {Array} ledgerRows  历史 ledger
 * @param {Object} opts  strategy, minSamples
 */
export function learnAndPersistWeights(ledgerRows, opts = {}) {
  const minSamples = opts.minSamples ?? 30;
  const settled = (ledgerRows ?? []).filter((r) => r.hit === true || r.hit === false);
  if (settled.length < minSamples) {
    return { ok: false, reason: `insufficient-settled:${settled.length}/${minSamples}` };
  }

  // 构造 methodPredictions:把 ledger 拆成 ensemble 和 main 两个"方法"
  const methodPredictions = {
    main: settled.map((r) => ({
      probabilities: { "3": Number(r.probabilityHome), "1": Number(r.probabilityDraw), "0": Number(r.probabilityAway) },
      actual: actualCode(r.actual)
    })).filter((s) => valid(s.probabilities) && s.actual),
    ensemble: settled.filter((r) => Number.isFinite(Number(r.ensembleHome))).map((r) => ({
      probabilities: { "3": Number(r.ensembleHome), "1": Number(r.ensembleDraw), "0": Number(r.ensembleAway) },
      actual: actualCode(r.actual)
    })).filter((s) => valid(s.probabilities) && s.actual)
  };

  const result = autoOptimizeWeights(methodPredictions, { strategy: opts.strategy ?? "inverse-rps" });
  if (!result?.weights) return { ok: false, reason: "optimizer-returned-no-weights" };

  const profile = {
    generatedAt: new Date().toISOString(),
    samplesUsed: settled.length,
    strategy: result.strategy,
    methodRps: result.methodRps,
    weights: result.weights,
    recommendation: pickWinner(result.methodRps)
  };
  saveEnsembleWeightsProfile(profile);
  return { ok: true, ...profile, path: PROFILE_PATH };
}

function actualCode(value) {
  const v = String(value ?? "").trim();
  if (["3", "主胜", "home", "胜"].includes(v)) return "3";
  if (["1", "平局", "draw", "平"].includes(v)) return "1";
  if (["0", "客胜", "away", "负"].includes(v)) return "0";
  return null;
}

function valid(probs) {
  const sum = (probs["3"] ?? 0) + (probs["1"] ?? 0) + (probs["0"] ?? 0);
  return Number.isFinite(sum) && sum > 0.5 && sum < 2;
}

function pickWinner(methodRps) {
  if (!methodRps) return null;
  const entries = Object.entries(methodRps).filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return null;
  entries.sort((a, b) => a[1] - b[1]);
  return `${entries[0][0]} RPS ${entries[0][1].toFixed(4)} (lowest is best)`;
}
