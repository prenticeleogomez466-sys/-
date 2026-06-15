/**
 * 诊断(只读,零写盘):世界杯专属校准反哺能否真增益?
 * ──────────────────────────────────────────────
 * 背景:0614 复盘诊断"模型不进化"三断点之一 = 已结算样本零反哺校准。
 *   俱乐部样本=0 永远饿死,但世界杯侧已有 86 场已结算(>样本阈值)。
 *   本脚本 leak-safe 验证:用 WC 已结算样本做 walk-forward 校准,
 *   对比"现状(ledger 落盘概率)"vs"叠加 WC 专属反哺校准"的 logloss/Brier/命中。
 *
 * 严格 leak-safe:第 i 场只用「严格早于它」的 WC 已结算样本拟合校准 profile。
 * 复用生产函数(buildCalibrationProfileFromRows / calibrateProbabilities),
 * 结果直接代表"把这条反哺接进生产"的真实效果。变好→落地;没变好→数据墙,不做。
 *
 * 不写任何文件。不碰生产 profile。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { isSoftCompetition } from "../src/competition-soft-recalibration.js";
import { buildCalibrationProfileFromRows, calibrateProbabilities } from "../src/model-calibration.js";

const ledgerPath = join(getExportDir(), "recommendation-ledger.json");
const rows = JSON.parse(readFileSync(ledgerPath, "utf8"));

// ── 1) 取 WC/国际赛已结算行,**去重**(同一场被多日重复推荐→只留最新一条,
//      防同一物理比赛既进训练又进测试的样本泄漏),按真实赛日时序排。
const rawWc = rows
  .filter((r) => r.actual && isSoftCompetition(r.competition))
  .filter((r) => Number.isFinite(r.probabilityHome) && Number.isFinite(r.probabilityDraw) && Number.isFinite(r.probabilityAway));
// 去重键=match+actualScore(同场同赛果);多条取 settledAt 最新
const dedup = new Map();
for (const r of rawWc) {
  const key = `${r.match}|${r.actualScore}`;
  const prev = dedup.get(key);
  if (!prev || String(r.settledAt || "") > String(prev.settledAt || "")) dedup.set(key, r);
}
// 真实赛日:优先从原 pendingReason 已被清,改用 settledAt 近似时序(去重后同场仅一条,时序仅用于 walk-forward 切分)
const settledWc = [...dedup.values()].sort((a, b) => String(a.settledAt || a.date).localeCompare(String(b.settledAt || b.date)));

console.log(`WC/国际赛已结算原始: ${rawWc.length} 行 → 去重后唯一场: ${settledWc.length}`);

// ── 2) 真值用 actualScore(比分)反推 outcome,并与 actual 文字交叉校验(不假设编码)
function outcomeFromScore(score) {
  const m = /^(\d+)\s*[-:]\s*(\d+)$/.exec(String(score || "").trim());
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  return h > a ? "home" : h < a ? "away" : "draw";
}
const textOutcome = (r) => (r.actual === "主胜" ? "home" : r.actual === "客胜" ? "away" : r.actual === "平局" ? "draw" : null);
// 交叉校验:凡比分与文字都在、却不一致的行,报错退出(数据脏)
let crossOk = 0, crossMiss = 0;
for (const r of settledWc) {
  const s = outcomeFromScore(r.actualScore), t = textOutcome(r);
  if (s && t) { if (s !== t) { console.error(`❌ 比分/文字不一致 ${r.match} score=${r.actualScore} text=${r.actual}`); process.exit(1); } crossOk++; }
  else crossMiss++;
}
console.log(`比分↔文字交叉校验一致: ${crossOk} 场,其一缺失: ${crossMiss} 场`);

const probSet = (r) => ({ home: r.probabilityHome, draw: r.probabilityDraw, away: r.probabilityAway });
const actualOutcome = (r) => outcomeFromScore(r.actualScore) || textOutcome(r);

function logloss(p, outcome) {
  const v = Math.max(1e-12, Math.min(1 - 1e-12, p[outcome]));
  return -Math.log(v);
}
function brier(p, outcome) {
  return ["home", "draw", "away"].reduce((s, k) => s + Math.pow((p[k] || 0) - (k === outcome ? 1 : 0), 2), 0);
}
function favOf(p) {
  return ["home", "draw", "away"].reduce((b, k) => (p[k] > p[b] ? k : b), "home");
}
function normalize(p) {
  const s = (p.home || 0) + (p.draw || 0) + (p.away || 0);
  return s > 0 ? { home: p.home / s, draw: p.draw / s, away: p.away / s } : p;
}

// ── 3) leak-safe walk-forward,两种 context(无市场先验/有市场先验)各跑一遍
function run(label, warmup, hasMarketPrior) {
  let n = 0;
  const base = { ll: 0, brier: 0, hit: 0 };
  const cal = { ll: 0, brier: 0, hit: 0 };
  let moved = 0;
  for (let i = warmup; i < settledWc.length; i++) {
    const row = settledWc[i];
    const oc = actualOutcome(row);
    if (!oc) continue;
    const prior = settledWc.slice(0, i); // 严格早于当前场
    const profile = buildCalibrationProfileFromRows(prior, { minSamples: 20, minIsotonicSamples: 30 });
    const raw = normalize(probSet(row));
    const out = calibrateProbabilities(probSet(row), profile, { hasMarketPrior });
    const calibrated = normalize(out.probabilities || raw);

    base.ll += logloss(raw, oc); base.brier += brier(raw, oc); base.hit += favOf(raw) === oc ? 1 : 0;
    cal.ll += logloss(calibrated, oc); cal.brier += brier(calibrated, oc); cal.hit += favOf(calibrated) === oc ? 1 : 0;
    if (Math.abs((calibrated[favOf(raw)] || 0) - (raw[favOf(raw)] || 0)) > 1e-6) moved++;
    n++;
  }
  if (!n) { console.log(`\n[${label}] 评估样本=0`); return; }
  const d = (a, b) => (a - b >= 0 ? "+" : "") + ((a - b)).toFixed(4);
  console.log(`\n=== [${label}] hasMarketPrior=${hasMarketPrior} warmup=${warmup} 评估=${n} 场,校准实际改动=${moved} 场 ===`);
  console.log(`           现状(raw)      WC反哺校准     差值(负=改善)`);
  console.log(`LogLoss    ${(base.ll / n).toFixed(4)}        ${(cal.ll / n).toFixed(4)}        ${d(cal.ll / n, base.ll / n)}`);
  console.log(`Brier      ${(base.brier / n).toFixed(4)}        ${(cal.brier / n).toFixed(4)}        ${d(cal.brier / n, base.brier / n)}`);
  console.log(`命中率     ${(base.hit / n * 100).toFixed(1)}%         ${(cal.hit / n * 100).toFixed(1)}%         ${d(cal.hit / n * 100, base.hit / n * 100)}pp`);
}

// reliability 概览:WC 整体过/欠自信?
(() => {
  const buckets = { "33-45": [], "45-55": [], "55-65": [], "65-100": [] };
  for (const r of settledWc) {
    const p = normalize(probSet(r)); const f = favOf(p); const fp = p[f];
    const bk = fp < 0.45 ? "33-45" : fp < 0.55 ? "45-55" : fp < 0.65 ? "55-65" : "65-100";
    buckets[bk].push({ pred: fp, hit: f === actualOutcome(r) ? 1 : 0 });
  }
  console.log("\n── WC 整体 reliability(预测 favorite 概率 vs 实际命中)──");
  for (const [bk, arr] of Object.entries(buckets)) {
    if (!arr.length) { console.log(`  ${bk}: 空`); continue; }
    const pred = arr.reduce((s, x) => s + x.pred, 0) / arr.length;
    const act = arr.reduce((s, x) => s + x.hit, 0) / arr.length;
    console.log(`  ${bk}: n=${arr.length} 预测=${(pred * 100).toFixed(1)}% 实际=${(act * 100).toFixed(1)}% gap=${((act - pred) * 100).toFixed(1)}pp`);
  }
})();

run("无市场先验路径(走 isotonicMap 模型校准)", 25, false);
run("有市场先验路径(走 bucket/global)", 25, true);
run("无市场先验·warmup40", 40, false);
