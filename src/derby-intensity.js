/**
 * Derby Intensity 同城/历史宿敌
 * ──────────────────────────────────────────────────
 * Derby 比赛特征:
 *   - 平局率比普通比赛高 3-5%(双方更谨慎)
 *   - 进球率波动大(要么 0-0 闷战,要么 3-3 大战)
 *   - 心理因素 > 实力因素(弱队对强队偷分的常见场景)
 *   - 红黄牌数显著高
 *
 * 识别方式:
 *   1. 同城(< 30km)= 必定 derby
 *   2. 同区域历史宿敌列表(预置)
 *   3. 历史交锋次数 ≥ 50 场 + 平局率 > 30% = 可能 derby
 */

// 预置已知 derby 关系
const KNOWN_DERBIES = new Set([
  // 西甲
  "real madrid::atletico madrid",
  "barcelona::espanyol",
  // 英超
  "manchester united::manchester city",
  "arsenal::tottenham",
  "liverpool::everton",
  "chelsea::arsenal",
  "chelsea::tottenham",
  // 意甲
  "ac milan::inter milan",
  "juventus::torino",
  "roma::lazio",
  // 德甲
  "borussia dortmund::schalke 04",
  "bayern munich::1860 munich",
  // 阿甲
  "boca juniors::river plate",
  "racing::independiente",
  // 中超
  "上海海港::上海申花",
  "北京国安::北京人和",
  "广州::广州城"
]);

/**
 * 给两队名 + 可选距离,判断是否 derby + intensity 等级.
 */
export function detectDerby(homeTeam, awayTeam, opts = {}) {
  if (!homeTeam || !awayTeam) return { isDerby: false };
  const normalize = (s) => String(s).toLowerCase().trim();
  const a = normalize(homeTeam);
  const b = normalize(awayTeam);
  const k1 = `${a}::${b}`;
  const k2 = `${b}::${a}`;
  const knownDerby = KNOWN_DERBIES.has(k1) || KNOWN_DERBIES.has(k2);

  const distance = Number(opts.distanceKm ?? Infinity);
  const sameCity = distance < 30;
  const sameRegion = distance < 100;

  let intensity = "none";
  if (knownDerby) intensity = "historical-rivalry";
  else if (sameCity) intensity = "city-derby";
  else if (sameRegion) intensity = "regional-derby";

  return {
    isDerby: intensity !== "none",
    intensity,
    knownDerby,
    sameCity,
    sameRegion,
    distanceKm: Number.isFinite(distance) ? distance : null
  };
}

/**
 * 给 prediction 应用 derby 调整.
 *   - 平局率上调 3-5%
 *   - 进球率波动:让 over 概率往中间靠
 */
export function applyDerbyAdjustment(probabilities, derbyInfo) {
  if (!derbyInfo || !derbyInfo.isDerby) return probabilities;
  const shiftLevel = derbyInfo.intensity === "historical-rivalry" ? 0.05
                  : derbyInfo.intensity === "city-derby" ? 0.04
                  : derbyInfo.intensity === "regional-derby" ? 0.025
                  : 0;
  const adjusted = {
    home: probabilities.home * (1 - shiftLevel * 0.5),
    draw: probabilities.draw * (1 + shiftLevel * 1.5),  // 平局率显著上调
    away: probabilities.away * (1 - shiftLevel * 0.5)
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum)
  };
}

/**
 * 注册新的 derby 关系(供 runtime 扩展).
 */
export function registerDerby(team1, team2) {
  const key = `${String(team1).toLowerCase().trim()}::${String(team2).toLowerCase().trim()}`;
  KNOWN_DERBIES.add(key);
}

/**
 * Derby intensity → Bayesian LR.
 */
export function derbyToLR(derbyInfo) {
  if (!derbyInfo || !derbyInfo.isDerby) return null;
  const intensity = derbyInfo.intensity === "historical-rivalry" ? 0.15
                 : derbyInfo.intensity === "city-derby" ? 0.10
                 : 0.05;
  return {
    home: 1 - intensity * 0.5,
    draw: 1 + intensity,
    away: 1 - intensity * 0.5
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
