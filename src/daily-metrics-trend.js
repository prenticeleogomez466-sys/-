/**
 * 每日复盘趋势追踪器
 * ──────────────────────────────────────────────────
 * 修复缺口二：复盘缺少"趋势曲线"
 *
 * evolution-backtest.js 做的是全量汇总——一个 backtest-summary.json。
 * 当 Brier 从 0.21 涨到 0.26 时，被历史数据稀释看不出来。
 *
 * 本模块在每次 daily-recap 时计算 **仅当日** 的 Brier/LogLoss/RPS，
 * 追加一行到 daily-metrics-trend.json（类似时间序列数据库）。
 * 同时提供滚动窗口汇总（近 7 天 / 14 天 / 30 天），
 * 让你能直接回答"这周模型比上周好还是差"。
 *
 * 接口设计匹配 daily-recap.js 的调用时机：
 *   import { appendDailyMetrics, loadMetricsTrend } from "./daily-metrics-trend.js";
 *   // 在 runDailyRecap 末尾调用
 *   appendDailyMetrics(targetDate, targetRows);
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const exportDir = getExportDir();
const trendPath = join(exportDir, "daily-metrics-trend.json");

const OUTCOME_CODES = ["3", "1", "0"];

/**
 * 计算当日已结赛场次的概率指标，追加到趋势文件。
 * @param {string} date  YYYY-MM-DD
 * @param {Array}  rows  当日 ledger 行（来自 recommendation-ledger.json）
 * @returns {Object} 当日指标行
 */
export function appendDailyMetrics(date, rows) {
  const settled = rows.filter((row) => row.actual && row.actualStatus === "settled");
  const probabilistic = settled.filter((row) => hasProbabilities(row));
  const metrics = buildDailyMetrics(date, settled, probabilistic);

  const trend = loadMetricsTrend();
  // 替换已有同日记录（幂等）
  const existing = trend.findIndex((row) => row.date === date);
  if (existing >= 0) trend[existing] = metrics;
  else trend.push(metrics);
  trend.sort((a, b) => a.date.localeCompare(b.date));

  mkdirSync(exportDir, { recursive: true });
  writeFileSync(trendPath, `${JSON.stringify(trend, null, 2)}\n`, "utf8");
  return metrics;
}

/**
 * 加载完整趋势序列。
 * @returns {Array}
 */
export function loadMetricsTrend() {
  if (!existsSync(trendPath)) return [];
  try { return JSON.parse(readFileSync(trendPath, "utf8")); }
  catch { return []; }
}

/**
 * 滚动窗口汇总：近 N 天的平均指标。
 * @param {number} days  窗口天数
 * @returns {Object|null}
 */
export function rollingMetrics(days = 7) {
  const trend = loadMetricsTrend();
  const recent = trend.slice(-days).filter((row) => row.settled > 0);
  if (!recent.length) return null;

  const totalSettled = recent.reduce((s, r) => s + r.settled, 0);
  const totalHit = recent.reduce((s, r) => s + r.hitCount, 0);

  // 按场次加权平均（大赛日权重高，合理）
  const totalProbabilistic = recent.reduce((s, r) => s + r.probabilistic, 0);
  const weightedBrier = totalProbabilistic > 0
    ? recent.reduce((s, r) => s + (r.brier ?? 0) * r.probabilistic, 0) / totalProbabilistic
    : null;
  const weightedLogLoss = totalProbabilistic > 0
    ? recent.reduce((s, r) => s + (r.logLoss ?? 0) * r.probabilistic, 0) / totalProbabilistic
    : null;
  const weightedRps = totalProbabilistic > 0
    ? recent.reduce((s, r) => s + (r.rps ?? 0) * r.probabilistic, 0) / totalProbabilistic
    : null;

  return {
    window: days,
    days: recent.length,
    settled: totalSettled,
    probabilistic: totalProbabilistic,
    hitRate: totalSettled > 0 ? round(totalHit / totalSettled) : null,
    brier: weightedBrier !== null ? round(weightedBrier) : null,
    logLoss: weightedLogLoss !== null ? round(weightedLogLoss) : null,
    rps: weightedRps !== null ? round(weightedRps) : null,
  };
}

/**
 * 漂移检测：近期 Brier 是否显著高于历史基线。
 * @param {number} recentDays  近期窗口（默认 7）
 * @param {number} baselineDays 基线窗口（默认 30）
 * @param {number} tolerance   告警阈值倍数（默认 1.15）
 * @returns {Object}
 */
export function detectDrift(recentDays = 7, baselineDays = 30, tolerance = 1.15) {
  const recent = rollingMetrics(recentDays);
  const baseline = rollingMetrics(baselineDays);
  if (!recent?.brier || !baseline?.brier) return { drifting: false, reason: "数据不足" };
  const ratio = recent.brier / baseline.brier;
  return {
    drifting: ratio > tolerance,
    recentBrier: recent.brier,
    baselineBrier: baseline.brier,
    ratio: round(ratio),
    reason: ratio > tolerance
      ? `近${recentDays}天 Brier(${recent.brier}) 高于近${baselineDays}天基线(${baseline.brier}) ${Math.round((ratio - 1) * 100)}%`
      : "正常",
  };
}

/**
 * 生成可写入 recap-master.xlsx 的趋势汇总行。
 * 用于在复盘汇总 sheet 底部追加滚动指标。
 */
export function recapTrendRows() {
  const r7 = rollingMetrics(7);
  const r14 = rollingMetrics(14);
  const r30 = rollingMetrics(30);
  const drift = detectDrift();
  return [
    ["", "", ""],
    ["── 趋势追踪 ──", "", ""],
    ["近7天平均 Brier", r7?.brier ?? "数据不足", `${r7?.settled ?? 0} 场`],
    ["近14天平均 Brier", r14?.brier ?? "数据不足", `${r14?.settled ?? 0} 场`],
    ["近30天平均 Brier", r30?.brier ?? "数据不足", `${r30?.settled ?? 0} 场`],
    ["近7天命中率", r7?.hitRate != null ? `${Math.round(r7.hitRate * 1000) / 10}%` : "数据不足", ""],
    ["漂移检测", drift.drifting ? "预警" : "正常", drift.reason],
  ];
}

// ───── 内部函数 ─────

function buildDailyMetrics(date, settled, probabilistic) {
  const hitCount = settled.filter((row) => row.hit === true).length;
  const hitRate = settled.length > 0 ? round(hitCount / settled.length) : null;

  let brier = null, logLoss = null, rps = null;
  if (probabilistic.length > 0) {
    brier = round(probabilistic.reduce((s, r) => s + brierScore(probSet(r), actualKey(r)), 0) / probabilistic.length);
    logLoss = round(probabilistic.reduce((s, r) => s + logLossScore(probSet(r), actualKey(r)), 0) / probabilistic.length);
    rps = round(probabilistic.reduce((s, r) => s + rankedProbabilityScore(probSet(r), actualKey(r)), 0) / probabilistic.length);
  }

  return {
    date,
    settled: settled.length,
    probabilistic: probabilistic.length,
    hitCount,
    hitRate,
    brier,
    logLoss,
    rps,
    generatedAt: new Date().toISOString(),
  };
}

function hasProbabilities(row) {
  return [row.probabilityHome, row.probabilityDraw, row.probabilityAway]
    .every((v) => Number.isFinite(Number(v)));
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
  return OUTCOME_CODES.reduce((sum, code) => sum + Math.pow((probs[code] ?? 0) - (actual === code ? 1 : 0), 2), 0);
}

function logLossScore(probs, actual) {
  return -Math.log(Math.max(0.0001, probs[actual] ?? 0.0001));
}

function rankedProbabilityScore(probs, actual) {
  let score = 0;
  for (let i = 0; i < OUTCOME_CODES.length - 1; i++) {
    const predicted = OUTCOME_CODES.slice(0, i + 1).reduce((s, c) => s + (probs[c] ?? 0), 0);
    const observed = OUTCOME_CODES.slice(0, i + 1).includes(actual) ? 1 : 0;
    score += Math.pow(predicted - observed, 2);
  }
  return score / (OUTCOME_CODES.length - 1);
}

function round(v) { return Math.round((v + Number.EPSILON) * 10000) / 10000; }
