/**
 * Travel Distance 客场旅途模型
 * ──────────────────────────────────────────────────
 * 客队长途奔袭 → 体能 + 时差 + 适应折扣.
 * 经验:
 *   - <100km:无影响
 *   - 100-500km(同国跨城):-1%
 *   - 500-1500km(跨国短途):-2%
 *   - 1500-4000km(跨大洲短途):-4%
 *   - >4000km(跨洋,如 South America 客场欧洲):-6-8%,加时差 1-3%
 *
 * 简化:不维护球队 city 坐标库,用调用方提供 (lat, lon) 或 distance.
 */

/**
 * 计算两点 great-circle 距离(km).
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * 距离 → form 折扣系数(乘数,小于 1).
 */
export function travelMultiplier(distanceKm, opts = {}) {
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d <= 100) return 1.0;
  if (d <= 500) return 0.99;
  if (d <= 1500) return 0.98;
  if (d <= 4000) return 0.96;
  // 跨洋,加时差
  const timezoneDiff = Math.abs(opts.timezoneDiff ?? 0);
  let base = 0.94;
  if (timezoneDiff >= 3) base -= 0.01;
  if (timezoneDiff >= 6) base -= 0.01;
  return Math.max(0.88, base);
}

/**
 * 给一场比赛 + 两队 city 坐标 + 双方时区差,返回客队 form 折扣.
 */
export function computeTravelImpact(homeCity, awayCity, opts = {}) {
  if (!homeCity || !awayCity) return { multiplier: 1.0, distance: 0, note: "缺城市信息" };
  const distance = Number.isFinite(homeCity.distance) ? homeCity.distance
    : haversineDistance(homeCity.lat, homeCity.lon, awayCity.lat, awayCity.lon);
  const tzDiff = Math.abs((homeCity.timezone ?? 0) - (awayCity.timezone ?? 0));
  const mult = travelMultiplier(distance, { timezoneDiff: tzDiff });
  return {
    distanceKm: round(distance),
    timezoneDiff: tzDiff,
    awayTeamMultiplier: round(mult),
    homeAdvantageFromTravel: round(1 / mult - 1),
    note: distance < 100 ? "同城/邻城"
        : distance < 500 ? "短途"
        : distance < 1500 ? "跨国短途"
        : distance < 4000 ? "跨大洲"
        : "跨洋长途",
    significant: mult < 0.97
  };
}

/**
 * 调整 prediction 概率应对客场旅途.
 */
export function applyTravelBias(probabilities, travelImpact) {
  if (!travelImpact || !travelImpact.significant) return probabilities;
  const homeBoost = 1 - travelImpact.awayTeamMultiplier;
  const adjusted = {
    home: probabilities.home * (1 + homeBoost),
    draw: probabilities.draw * (1 + homeBoost * 0.1),
    away: probabilities.away * (1 - homeBoost)
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
