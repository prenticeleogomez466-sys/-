// 联赛可信度 profile 共享读取 + 弱联赛判定。
// profile 由 build-league-reliability.mjs 写到 exports/league-reliability.json。
// 弱联赛定义(与 daily-report.bettingTier 的降级判定一致,单一真相):
//   reliable===true 且 accuracy < weakThreshold(默认 0.42)。
//   reliable 要求样本≥20(builder 保证),故"样本不足/未知"的联赛不会被误判为弱(不臆断)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

let _cache;
export function loadLeagueReliability() {
  if (_cache !== undefined) return _cache;
  try {
    const p = join(getExportDir(), "league-reliability.json");
    _cache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch { _cache = null; }
  return _cache;
}
export function _resetLeagueReliabilityCache() { _cache = undefined; }

/** 仅"回测可靠且明显偏弱"的联赛返回 true;未知/样本不足/强联赛 → false。 */
export function isWeakLeague(league, prof = loadLeagueReliability()) {
  if (!league || !prof?.leagues) return false;
  const lg = prof.leagues[league];
  return Boolean(lg?.reliable && Number.isFinite(lg.accuracy) && lg.accuracy < (prof.weakThreshold ?? 0.42));
}
