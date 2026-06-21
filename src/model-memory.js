// 永久记忆系统:模型自身分段真实战绩(2026-06-01,用户硬要求"永久记忆系统融入大模型")。
// ───────────────────────────────────────────────────────────────────────────
// 与已有持久件的分工(防重复/拼装无深度):
//   · experience-library = 联赛**通用**统计(平局率/场均球/比分分布,与模型无关);
//   · calibration-profile = 概率→真实命中的 isotonic 映射(连续校准);
//   · 本模块 model-memory = 模型**自己**按分段(联赛/热门档/信心带/玩法)的**实测命中率**,
//     从 recommendation-ledger 已结算行 digest,持久累积、用时召回,给推荐附"本类历史命中率"
//     (诚实自知),也为日后分段自校正打底。三者正交,不重叠。
//
// 诚实纪律:只数已结算真实赛果(hit 标记),样本不足(<minN)只读不下结论(sufficient:false),
//   绝不外推/编造;遵 [[feedback_no_fabrication_live_only]] / [[feedback_hitrate_closed_loop]]。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const OUT = ["home", "draw", "away"];

// 热门强度档(按该场模型最大方向概率)——与 upset-trap 同口径,便于交叉解读。
export function favoriteTierFromProbs(probs) {
  const vals = [probs?.home, probs?.draw, probs?.away].map(Number).filter(Number.isFinite);
  if (!vals.length) return "未知";
  const p = Math.max(...vals);
  if (p >= 0.7) return "超级大热";
  if (p >= 0.6) return "强热门";
  if (p >= 0.5) return "中等热门";
  if (p >= 0.42) return "微热门";
  return "势均";
}

export function confidenceBand(conf) {
  const c = Number(conf);
  if (!Number.isFinite(c)) return "未知";
  if (c >= 75) return "极高(≥75)";
  if (c >= 65) return "高(65-75)";
  if (c >= 55) return "中(55-65)";
  return "低(<55)";
}

function blankCell() {
  return { n: 0, wld: { hit: 0, n: 0 }, score: { hit: 0, n: 0 }, halfFull: { hit: 0, n: 0 }, handicap: { hit: 0, n: 0 } };
}

// 诚实账本:某玩法只在**有该玩法真实赛果**时才计入命中/失败,否则该玩法对本行=未结算(不计)。
//   防"无 HT 比分→actualHalfFull 空→halfFullHit 恒 false"被误记成 0% 命中(那是缺数据不是预测错)。
function addRow(cell, r) {
  cell.n += 1;
  const bump = (slot, flag, settled) => { if (settled && typeof flag === "boolean") { slot.n += 1; if (flag) slot.hit += 1; } };
  const nonEmpty = (x) => typeof x === "string" ? x.trim().length > 0 : x != null;
  bump(cell.wld, r.hit, nonEmpty(r.actual));
  bump(cell.score, r.scoreHit, nonEmpty(r.actualScore));
  bump(cell.halfFull, r.halfFullHit, nonEmpty(r.actualHalfFull));
  bump(cell.handicap, r.handicapWldHit, r.actualHandicapCode != null && r.actualHandicapCode !== "");
}

function rate(slot) {
  return slot.n > 0 ? Math.round((slot.hit / slot.n) * 1000) / 1000 : null;
}

// 把累计 cell 转成带命中率的只读视图。
function finalizeCell(cell) {
  return {
    n: cell.n,
    wldHit: rate(cell.wld), wldN: cell.wld.n,
    scoreHit: rate(cell.score), scoreN: cell.score.n,
    halfFullHit: rate(cell.halfFull), halfFullN: cell.halfFull.n,
    handicapHit: rate(cell.handicap), handicapN: cell.handicap.n,
  };
}

/**
 * 从 ledger 已结算行 digest 出分段战绩记忆。
 * @param {Array} ledger  recommendation-ledger.json 数组
 * @returns {{ builtAt, settledTotal, global, byLeague, byFavoriteTier, byConfidenceBand }}
 */
export function buildModelMemory(ledger, opts = {}) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const settled = rows.filter((r) => typeof r?.hit === "boolean"); // 只数已结算真实赛果
  const global = blankCell();
  const byLeague = {};
  const byFavoriteTier = {};
  const byConfidenceBand = {};
  for (const r of settled) {
    addRow(global, r);
    const lg = r.competition || "未知联赛";
    (byLeague[lg] ??= blankCell()); addRow(byLeague[lg], r);
    const tier = favoriteTierFromProbs({ home: r.probabilityHome, draw: r.probabilityDraw, away: r.probabilityAway });
    (byFavoriteTier[tier] ??= blankCell()); addRow(byFavoriteTier[tier], r);
    const band = confidenceBand(r.confidence);
    (byConfidenceBand[band] ??= blankCell()); addRow(byConfidenceBand[band], r);
  }
  const mapFinal = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, finalizeCell(v)]));
  return {
    builtAt: opts.builtAt ?? null, // 由 build 脚本注入时间戳(脚本里 Date 可用)
    settledTotal: settled.length,
    global: finalizeCell(global),
    byLeague: mapFinal(byLeague),
    byFavoriteTier: mapFinal(byFavoriteTier),
    byConfidenceBand: mapFinal(byConfidenceBand),
  };
}

/**
 * 召回某场所属分段的历史战绩(诚实:样本不足只标 sufficient:false,不外推)。
 * @param {Object} memory  buildModelMemory 结果(或 loadModelMemory)
 * @param {Object} ctx     { competition, probabilities:{home,draw,away}, confidence }
 * @param {Object} opts    { minN=10 }
 * @returns {null | { league, leagueSufficient, favoriteTier, tierKey, overall, note }}
 */
export function recallSegmentPerformance(memory, ctx = {}, opts = {}) {
  if (!memory || !memory.global) return null;
  const minN = opts.minN ?? 10;
  const lgKey = ctx.competition || null;
  const tierKey = favoriteTierFromProbs(ctx.probabilities ?? {});
  const league = lgKey ? memory.byLeague?.[lgKey] ?? null : null;
  const favoriteTier = memory.byFavoriteTier?.[tierKey] ?? null;
  const enough = (cell) => Boolean(cell && cell.n >= minN);
  const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const noteParts = [];
  if (enough(league)) noteParts.push(`${lgKey}本类胜平负命中 ${pct(league.wldHit)}(n=${league.n})`);
  if (enough(favoriteTier)) noteParts.push(`${tierKey}档命中 ${pct(favoriteTier.wldHit)}(n=${favoriteTier.n})`);
  if (!noteParts.length && memory.global.n) noteParts.push(`样本不足分段,总体命中 ${pct(memory.global.wldHit)}(n=${memory.global.n})`);
  return {
    league, leagueSufficient: enough(league),
    favoriteTier, tierKey, tierSufficient: enough(favoriteTier),
    overall: memory.global,
    note: noteParts.join(" · "),
  };
}

// 从盘上读已 build 的记忆;不存在 → null(优雅降级,不阻塞主路径)。
export function loadModelMemory(path) {
  try {
    const p = path ?? join(getExportDir(), "model-memory.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 从 recommendation-ledger.json 实时 digest model-memory(2026-06-21 接线)。
 *   背景:buildModelMemory 此前从未被生产调用 + 无任何代码写 model-memory.json →
 *     loadModelMemory 恒 null → 推荐的"本类历史命中率"标注(memoryRecall)静默失效。
 *   改为实时从 ledger 构建(纯 digest ~1ms,永不陈旧),与 wc-calibration loadWcCalibrationProfile 同型。
 *   recallSegmentPerformance 内部已诚实 gate(样本<minN→sufficient:false 不外推);纯展示,不改概率。
 *   缺文件/解析失败 → null(优雅降级,标注消失但不报错),绝不兜底假数据。
 * @param {{path?:string, builtAt?:string}} opts
 * @returns {object|null} buildModelMemory 产物
 */
export function buildModelMemoryFromLedger(opts = {}) {
  try {
    const p = opts.path ?? join(getExportDir(), "recommendation-ledger.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const rows = Array.isArray(raw) ? raw : Object.values(raw || {});
    const mem = buildModelMemory(rows, { builtAt: opts.builtAt ?? null });
    return mem.settledTotal > 0 ? mem : null;
  } catch {
    return null;
  }
}
