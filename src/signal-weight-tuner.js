/**
 * 信号权重自适应回调
 * ──────────────────────────────────────────────────
 * 修复缺口三：信号权重是硬编码的
 *
 * prediction-engine.js 里 Elo 乘 0.18、状态乘 0.08、天气 0.98 等系数
 * 不会随着复盘结果变化。model-calibration.js 的 calibrationProfile
 * 只调最终概率偏差，不调各信号的贡献权重。
 *
 * 本模块从 recommendation-ledger 中学习：
 *   - 哪些信号存在时，预测的 Brier Score 更低？
 *   - 各信号的边际贡献是多少？
 *   - 动态计算每个信号的权重缩放因子
 *
 * 产出 signal-weights-profile.json，供 prediction-engine 在
 * adjustProbabilitiesWithAdvancedData 中读取使用。
 *
 * 接口：
 *   import { buildSignalWeightsProfile, loadSignalWeights } from "./signal-weight-tuner.js";
 *   // 每周由 evolution-backtest 调用一次
 *   const profile = buildSignalWeightsProfile();
 *   // prediction-engine 里
 *   const weights = loadSignalWeights();
 *   // Elo score 不再硬编码 * 0.18，而是 * 0.18 * weights.elo.scale
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const exportDir = getExportDir();
const ledgerPath = join(exportDir, "recommendation-ledger.json");
const profilePath = join(exportDir, "signal-weights-profile.json");

const OUTCOME_CODES = ["3", "1", "0"];
const SIGNAL_KEYS = ["elo", "form", "weather", "shotQuality", "lineup", "xg", "motivation"];

/**
 * 从复盘 ledger 学习各信号的效果，生成权重缩放文件。
 * 建议每周由 evolution-backtest 尾部调用。
 * @param {Object} opts
 *   opts.minSamples  最少需要多少已结赛场次（默认 30）
 *   opts.floor       单信号缩放下限（默认 0.4）
 *   opts.ceiling     单信号缩放上限（默认 1.8）
 *   opts.inertia     与上次权重的惯性混合（默认 0.5）
 * @returns {Object} profile
 */
export function buildSignalWeightsProfile(opts = {}) {
  const minSamples = opts.minSamples ?? 30;
  const floor = opts.floor ?? 0.4;
  const ceiling = opts.ceiling ?? 1.8;
  const inertia = opts.inertia ?? 0.5;

  const rows = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];
  const settled = rows.filter((row) => row.actual && hasProbabilities(row));

  if (settled.length < minSamples) {
    // 冷启动:样本不足时不学习,但把 baseline 显式落到 profile,
    // 这样 audit/loadSignalWeights/getSignalScale 都能拿到中性 scale=1,
    // 并能区分"从未跑过 backtest"与"跑过 backtest 但样本不足"。
    const baselineSignals = Object.fromEntries(SIGNAL_KEYS.map((key) => [key, {
      samples: 0,
      effect: null,
      scale: 1,
      direction: "cold-start-baseline",
      reason: `样本不足:${settled.length}/${minSamples}`,
    }]));
    return saveProfile({
      usable: false,
      coldStart: true,
      reason: `已结赛场次不足：${settled.length}/${minSamples}`,
      samples: settled.length,
      signals: baselineSignals,
      generatedAt: new Date().toISOString(),
    });
  }

  // 全量基线 Brier
  const baselineBrier = avgBrier(settled);

  // 对每个信号，比较"有该信号时"vs"无该信号时"的 Brier 差异
  const signalAnalysis = {};
  for (const signal of SIGNAL_KEYS) {
    const withSignal = settled.filter((row) => signalPresent(row, signal));
    const withoutSignal = settled.filter((row) => !signalPresent(row, signal));

    if (withSignal.length < 5 || withoutSignal.length < 5) {
      signalAnalysis[signal] = {
        samples: withSignal.length,
        effect: null,
        scale: 1,
        reason: "样本不足，保持默认权重",
      };
      continue;
    }

    const brierWith = avgBrier(withSignal);
    const brierWithout = avgBrier(withoutSignal);
    // 如果有信号时 Brier 更低，说明这个信号有正向贡献
    const improvement = brierWithout - brierWith;
    // 转换为缩放因子：改善越大 → scale 越高
    const rawScale = 1 + improvement * 8; // 每改善 0.01 Brier ≈ +8% 权重
    const clampedScale = clamp(rawScale, floor, ceiling);

    signalAnalysis[signal] = {
      samples: withSignal.length,
      brierWith: round(brierWith),
      brierWithout: round(brierWithout),
      improvement: round(improvement),
      rawScale: round(rawScale),
      scale: round(clampedScale),
      direction: improvement > 0.005 ? "正向贡献" : improvement < -0.005 ? "负向贡献" : "中性",
    };
  }

  // 与上次 profile 做惯性混合
  const previous = loadSignalWeights();
  if (previous.usable) {
    for (const signal of SIGNAL_KEYS) {
      const curr = signalAnalysis[signal]?.scale ?? 1;
      const prev = previous.signals?.[signal]?.scale ?? 1;
      if (signalAnalysis[signal]) {
        signalAnalysis[signal].previousScale = prev;
        signalAnalysis[signal].scale = round(inertia * prev + (1 - inertia) * curr);
      }
    }
  }

  return saveProfile({
    usable: true,
    reason: "ok",
    samples: settled.length,
    baselineBrier: round(baselineBrier),
    signals: signalAnalysis,
    generatedAt: new Date().toISOString(),
    config: { minSamples, floor, ceiling, inertia },
  });
}

/**
 * 加载信号权重 profile（供 prediction-engine 使用）。
 * @returns {Object}
 */
export function loadSignalWeights() {
  if (!existsSync(profilePath)) return { usable: false, signals: {} };
  try { return JSON.parse(readFileSync(profilePath, "utf8")); }
  catch { return { usable: false, signals: {} }; }
}

/**
 * 获取某个信号的缩放因子。
 * prediction-engine 中使用：
 *   const eloScale = getSignalScale("elo");  // 例如 1.15
 *   // 原来: score = (diff / 400) * 0.18
 *   // 现在: score = (diff / 400) * 0.18 * eloScale
 * @param {string} signal
 * @returns {number}
 */
export function getSignalScale(signal) {
  const profile = loadSignalWeights();
  return profile?.signals?.[signal]?.scale ?? 1;
}

/**
 * 生成可追加到 backtest-summary.json 的信号效果汇总。
 */
export function signalWeightsSummary() {
  const profile = loadSignalWeights();
  if (!profile.usable) {
    // 冷启动时也要返回 signals(全为 baseline scale=1),让 audit 能看到完整列表
    return {
      usable: false,
      coldStart: Boolean(profile.coldStart),
      reason: profile.reason ?? "missing-profile",
      samples: profile.samples ?? 0,
      signals: Object.fromEntries(
        Object.entries(profile.signals ?? {}).map(([key, val]) => [key, {
          scale: val?.scale ?? 1,
          direction: val?.direction ?? "cold-start-baseline",
          samples: val?.samples ?? 0,
        }])
      ),
    };
  }
  return {
    usable: true,
    samples: profile.samples,
    baselineBrier: profile.baselineBrier,
    signals: Object.fromEntries(
      Object.entries(profile.signals).map(([key, val]) => [key, {
        scale: val.scale,
        direction: val.direction,
        samples: val.samples,
      }])
    ),
  };
}

// ───── 内部函数 ─────

function signalPresent(row, signal) {
  // 从 ledger 行的 probabilityAdjustment.signals 或 advancedFeatures 判断
  const signals = row.adjustmentSignals ?? row.probabilityAdjustmentSignals ?? [];
  if (Array.isArray(signals) && signals.some((s) => s === signal || s?.key === signal)) return true;
  // 回退：检查是否有相关概率修正记录
  const adj = row.probabilityAdjustment;
  if (adj?.applied && adj?.signals?.some?.((s) => s?.key === signal)) return true;
  // 进一步回退：按信号特征判断
  if (signal === "elo" && row.eloHome != null && row.eloAway != null) return true;
  if (signal === "form" && row.formHomePointsPerMatch != null) return true;
  if (signal === "weather" && row.weatherPrecipitation != null) return true;
  if (signal === "xg" && (row.xgHome != null || row.expectedGoalsHome != null)) return true;
  return false;
}

function hasProbabilities(row) {
  return [row.probabilityHome, row.probabilityDraw, row.probabilityAway]
    .every((v) => Number.isFinite(Number(v)));
}

function avgBrier(rows) {
  const valid = rows.filter((row) => hasProbabilities(row));
  if (!valid.length) return 0.667;
  return valid.reduce((sum, row) => sum + brierScore(probSet(row), actualKey(row)), 0) / valid.length;
}

function probSet(row) {
  const p = { "3": Number(row.probabilityHome), "1": Number(row.probabilityDraw), "0": Number(row.probabilityAway) };
  const total = p["3"] + p["1"] + p["0"];
  if (total <= 0) return { "3": 1/3, "1": 1/3, "0": 1/3 };
  return { "3": p["3"]/total, "1": p["1"]/total, "0": p["0"]/total };
}

function actualKey(row) {
  if (row.actual === "主胜" || row.actualCode === "3") return "3";
  if (row.actual === "平局" || row.actualCode === "1") return "1";
  if (row.actual === "客胜" || row.actualCode === "0") return "0";
  return "";
}

function brierScore(probs, actual) {
  return OUTCOME_CODES.reduce((s, c) => s + Math.pow((probs[c] ?? 0) - (actual === c ? 1 : 0), 2), 0);
}

function saveProfile(profile) {
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profile;
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round((v + Number.EPSILON) * 10000) / 10000; }
