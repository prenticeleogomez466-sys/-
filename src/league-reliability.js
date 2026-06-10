// 联赛可信度 profile 共享读取 + 弱联赛判定。
// profile 由 build-league-reliability.mjs 写到 data\profiles\league-reliability.json
// (2026-06-10 缺陷#14:原在 exports 根,被 16:01 清空计划任务删除 → isWeakLeague 恒 false,
//  弱联赛"不当胆"真钱护栏静默失效;迁到持久 profiles 目录 + 缺失 fail-loud)。
// 弱联赛定义(与 daily-report.bettingTier 的降级判定一致,单一真相):
//   reliable===true 且 accuracy < weakThreshold(默认 0.42)。
//   reliable 要求样本≥20(builder 保证),故"样本不足/未知"的联赛不会被误判为弱(不臆断)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir, getProfilesDir } from "./paths.js";
import { canonicalLeague } from "./league-profile.js";

let _cache;
export function loadLeagueReliability() {
  if (_cache !== undefined) return _cache;
  try {
    const candidates = [
      join(getProfilesDir(), "league-reliability.json"),   // 新持久路径(权威)
      join(getExportDir(), "league-reliability.json")      // 旧 exports 根(只读兼容,会被16:01清空)
    ];
    const p = candidates.find((c) => existsSync(c));
    if (!p) {
      console.error(
        `\n🔴🔴🔴 [league-reliability] league-reliability.json 缺失!\n` +
        `   查找路径: ${candidates.join(" | ")}\n` +
        `   后果: 弱联赛『不当胆』真钱护栏失效(isWeakLeague 恒 false,无数据不臆断)。\n` +
        `   修复: npm run recommend:league-reliability 重产 profile。\n`
      );
      _cache = null;
      return null;
    }
    _cache = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`🔴 [league-reliability] league-reliability.json 读取/解析异常: ${err.message} —— 弱联赛护栏失效。`);
    _cache = null;
  }
  return _cache;
}
export function _resetLeagueReliabilityCache() { _cache = undefined; }

/** 仅"回测可靠且明显偏弱"的联赛返回 true;未知/样本不足/强联赛 → false。
 *  按 canonicalLeague 归一后查,避免"芬超/芬兰超级联赛""沙职/沙特联"变体分裂
 *  使样本割裂(各自<20→reliable:false)而逃过弱联赛降级。profile 也以 canonical 键写入。 */
export function isWeakLeague(league, prof = loadLeagueReliability()) {
  if (!league || !prof?.leagues) return false;
  const canon = canonicalLeague(league);
  const lg = prof.leagues[canon] ?? prof.leagues[league];
  return Boolean(lg?.reliable && Number.isFinite(lg.accuracy) && lg.accuracy < (prof.weakThreshold ?? 0.42));
}
