/**
 * WC 专属校准反哺(2026-06-15)——让世界杯/国际赛已结算样本反哺 WC 逐场模型概率。
 * ────────────────────────────────────────────────────────────
 * 背景:WC 路由场在 prediction-engine 旁路了俱乐部 calibration(club-only 学习域),
 *   国家队侧长期"无专属校准反馈"(recap-diagnostic 未中归因 11/23 场点名此项)。
 *   本模块用 WC 已结算唯一场学一张 WC 专属 isotonic 映射,补上这条反馈。
 *
 * 三道安全闸(守 feedback_no_fallback_absolute + 薄样本不过拟合铁律):
 *   ① 去重:同一物理比赛被多业务日重复推荐 → 只留最新一条,杜绝同场既训练又测试的泄漏。
 *   ② gate:唯一场 < minSamples(默认 50)→ usable:false → 完全不生效(调用方 bypass=现状)。
 *      当前(2026-06-15)WC 唯一已结算仅 23 场 → gate 住,零行为变化;小组赛打完样本够自动激活。
 *   ③ 漂移闸:校准对 favorite 概率的改动 > maxDriftBlock(默认 0.15)→ 拒绝该场校准(防薄样本
 *      把单场概率带飞);> maxDriftWarn(默认 0.08)→ 放行但标 warn。
 *
 * leak-safe:这是"生产档"用法——用历史已结算场学,应用到未来新场,天然不偷看。
 *   (回测评估另需按场时序 walk-forward,见 diag-wc-calibration-feedback.mjs。)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildIsotonicMap, applyIsotonicMap } from "./model-calibration.js";
import { isSoftCompetition } from "./competition-soft-recalibration.js";
import { getExportDir } from "./paths.js";

const OUTCOMES = ["home", "draw", "away"];

function normalize(p) {
  const h = Number(p?.home) || 0, d = Number(p?.draw) || 0, a = Number(p?.away) || 0;
  const s = h + d + a;
  return s > 0 ? { home: h / s, draw: d / s, away: a / s } : { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
}
function favoriteOf(p) {
  const key = OUTCOMES.reduce((b, k) => (p[k] > p[b] ? k : b), "home");
  return { key, probability: p[key] };
}
// 把 favorite 概率移到 target,其余两项按原比例分摊剩余(保持归一)。
function moveFavorite(p, favKey, target) {
  const t = Math.max(1 / 3, Math.min(0.92, target));
  const rest = 1 - t;
  const others = OUTCOMES.filter((k) => k !== favKey);
  const restSum = others.reduce((s, k) => s + p[k], 0);
  const out = { [favKey]: t };
  for (const k of others) out[k] = restSum > 0 ? rest * (p[k] / restSum) : rest / 2;
  return { home: out.home, draw: out.draw, away: out.away };
}
function outcomeFromScore(score) {
  const m = /^(\d+)\s*[-:]\s*(\d+)$/.exec(String(score || "").trim());
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  return h > a ? "home" : h < a ? "away" : "draw";
}

/**
 * 去重 WC 已结算行:同一物理比赛(match+actualScore)多条重复推荐 → 留 settledAt 最新。
 * @param {Array<object>} rows ledger 行
 * @returns {Array<object>} 去重后的 WC 已结算唯一场
 */
export function dedupeSettledWc(rows) {
  const wc = (Array.isArray(rows) ? rows : []).filter(
    (r) => r?.actual && isSoftCompetition(r.competition) &&
      Number.isFinite(r.probabilityHome) && Number.isFinite(r.probabilityDraw) && Number.isFinite(r.probabilityAway)
  );
  const byKey = new Map();
  for (const r of wc) {
    const key = `${r.match}|${r.actualScore}`;
    const prev = byKey.get(key);
    if (!prev || String(r.settledAt || "") > String(prev.settledAt || "")) byKey.set(key, r);
  }
  return [...byKey.values()];
}

/**
 * 从 WC 已结算唯一场构建 WC 专属校准档(favorite predicted → 实际命中 的 isotonic 映射)。
 * @param {Array<object>} rows ledger 行(原始,内部去重)
 * @param {{minSamples?:number, minIsotonicSamples?:number}} opts
 * @returns {{source, usable, samples, reason, isotonicMap, reliability}}
 */
export function buildWcCalibrationProfile(rows, opts = {}) {
  const minSamples = Number(opts.minSamples ?? 50);
  const minIsotonic = Number(opts.minIsotonicSamples ?? 50);
  const settled = dedupeSettledWc(rows)
    .map((r) => {
      const probs = normalize({ home: r.probabilityHome, draw: r.probabilityDraw, away: r.probabilityAway });
      const fav = favoriteOf(probs);
      const actual = outcomeFromScore(r.actualScore);
      return actual ? { predicted: fav.probability, hit: fav.key === actual ? 1 : 0 } : null;
    })
    .filter(Boolean);

  const usable = settled.length >= minSamples;
  const isotonicMap = settled.length >= minIsotonic
    ? buildIsotonicMap(settled.map((s) => ({ predicted: s.predicted, actual: s.hit })))
    : null;

  // reliability 概览(诊断用,不门控)
  const buckets = { "33-45": [], "45-55": [], "55-65": [], "65-100": [] };
  for (const s of settled) {
    const bk = s.predicted < 0.45 ? "33-45" : s.predicted < 0.55 ? "45-55" : s.predicted < 0.65 ? "55-65" : "65-100";
    buckets[bk].push(s);
  }
  const reliability = Object.fromEntries(Object.entries(buckets).map(([bk, arr]) => [bk, {
    samples: arr.length,
    predicted: arr.length ? +(arr.reduce((x, s) => x + s.predicted, 0) / arr.length).toFixed(4) : null,
    actual: arr.length ? +(arr.reduce((x, s) => x + s.hit, 0) / arr.length).toFixed(4) : null
  }]));

  return {
    source: "wc-recap-ledger",
    usable,
    samples: settled.length,
    minSamples,
    reason: usable ? "ok" : `WC 唯一已结算样本不足:${settled.length}/${minSamples}(gate 住,待小组赛累积自动激活)`,
    isotonicMap,
    reliability
  };
}

/**
 * 生产档加载(2026-06-21 接线):从 recommendation-ledger.json 读已结算行,构建 WC 专属校准档。
 *   leak-safe:用历史已结算场学一张 favorite→实际命中 isotonic,应用到未来新场(天然不偷看)。
 *   gate(去重唯一场 < minSamples=50)未过 → usable:false → applyWcCalibration 完全 bypass(零行为变化)。
 *   缺文件/解析失败 → 返回 unusable 档(同样 bypass),绝不兜底假数据(守 feedback_no_fallback_absolute)。
 * @param {{path?:string, minSamples?:number, minIsotonicSamples?:number}} opts
 * @returns {object} buildWcCalibrationProfile 产物
 */
export function loadWcCalibrationProfile(opts = {}) {
  try {
    const p = opts.path ?? join(getExportDir(), "recommendation-ledger.json");
    if (!existsSync(p)) return buildWcCalibrationProfile([], opts);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
    return buildWcCalibrationProfile(rows, opts);
  } catch {
    return buildWcCalibrationProfile([], opts);
  }
}

/**
 * 应用 WC 专属校准到一场预测概率(带漂移闸)。
 * @param {{home,draw,away}} probabilities WC 模型原始概率
 * @param {object} profile buildWcCalibrationProfile 产物
 * @param {{maxDriftWarn?:number, maxDriftBlock?:number}} opts
 * @returns {{probabilities, applied, reason, drift?, warn?}}
 */
export function applyWcCalibration(probabilities, profile, opts = {}) {
  const normalized = normalize(probabilities);
  const maxWarn = Number(opts.maxDriftWarn ?? 0.08);
  const maxBlock = Number(opts.maxDriftBlock ?? 0.15);
  if (!profile?.usable || !profile.isotonicMap?.knots?.length) {
    return { probabilities: normalized, applied: false, reason: profile?.reason || "gate:无可用 WC 校准档" };
  }
  const fav = favoriteOf(normalized);
  const target = applyIsotonicMap(profile.isotonicMap, fav.probability);
  if (!Number.isFinite(target)) return { probabilities: normalized, applied: false, reason: "isotonic 无映射值" };
  const drift = target - fav.probability;
  if (Math.abs(drift) > maxBlock) {
    return { probabilities: normalized, applied: false, reason: "drift-block", drift: +drift.toFixed(4) };
  }
  const calibrated = moveFavorite(normalized, fav.key, target);
  return {
    probabilities: calibrated,
    applied: true,
    reason: "wc-isotonic",
    drift: +drift.toFixed(4),
    warn: Math.abs(drift) > maxWarn ? "drift-warn" : null
  };
}
