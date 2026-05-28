/**
 * Standings Pressure 排名压力模型
 * ──────────────────────────────────────────────────
 * 球队当前排名 + 剩余场次 → 压力指数.几类:
 *
 *   - 争冠区(top 2,差冠军 ≤ 6 分,剩余 ≤ 8 场):极高压力
 *   - 欧战席位边缘:中高压力
 *   - 中游安全区:无压力
 *   - 降级区边缘:极高压力(死中求生)
 *   - 已锁定/已无悬念:几乎无动力
 *
 * 压力对 form 的影响 V 字形:
 *   - 高压力 + 强战术执行:小幅 lift(+2-3%)
 *   - 高压力 + 心态崩溃:大幅 drop(-5-10%)
 *   - 无悬念球队:form 下降(摆烂)
 */

/**
 * @param {Object} standings  { position, totalTeams, points, leaderPoints, relegationLine, europePoints, remainingMatches }
 */
export function computePressureProfile(standings) {
  if (!standings) return { tier: "unknown", intensity: 0 };
  const pos = Number(standings.position);
  const total = Number(standings.totalTeams ?? 20);
  const points = Number(standings.points ?? 0);
  const leaderPoints = Number(standings.leaderPoints ?? points);
  const relegationLine = Number(standings.relegationLine ?? 0);
  const europeLine = Number(standings.europePoints ?? 0);
  const remaining = Number(standings.remainingMatches ?? 5);

  // 距冠军差距
  const titleGap = leaderPoints - points;
  // 距降级区差距
  const safetyGap = points - relegationLine;
  // 距欧战席位
  const europeGap = europeLine - points;

  let tier = "neutral";
  let intensity = 0;

  // 已锁定(top 1 且 titleGap 显著负)— 优先检查,避免被 title-race 误判
  if (pos === 1 && titleGap < -15) {
    tier = "title-clinched";
    intensity = -0.3;
  }
  // 已降级
  else if (safetyGap < -10) {
    tier = "relegated-already";
    intensity = -0.4;
  }
  // 争冠区
  else if (pos <= 2 && titleGap >= 0 && titleGap <= 6 && remaining <= 10) {
    tier = "title-race";
    intensity = round(0.5 + Math.max(0, (6 - titleGap) / 12));   // 0.5–1.0
  }
  // 降级区边缘
  else if (safetyGap >= 0 && safetyGap <= 6 && remaining <= 10) {
    tier = "relegation-fight";
    intensity = round(0.55 + Math.max(0, (6 - safetyGap) / 13)); // 0.55–1.0
  }
  // 欧战席位边缘
  else if (europeGap >= -3 && europeGap <= 6 && remaining <= 10) {
    tier = "europe-spot-race";
    intensity = 0.5;
  }
  // 中游安全
  else if (pos >= 7 && pos <= total - 5) {
    tier = "mid-table-safe";
    intensity = 0;
  }

  return {
    tier,
    intensity: round(intensity),
    titleGap, safetyGap, europeGap, remaining,
    pressureSource: tier === "title-race" ? "冠军压力"
                  : tier === "relegation-fight" ? "降级压力"
                  : tier === "europe-spot-race" ? "欧战席位"
                  : tier === "title-clinched" ? "已锁定 — 动力下降"
                  : tier === "relegated-already" ? "已降级 — 摆烂"
                  : "无压力"
  };
}

/**
 * 应用排名压力对 form 的影响:V 字模型.
 *   - 高压(intensity > 0.5):±2% lift(看球队历史抗压能力,这里简化为统一 +1%)
 *   - 极高压:±0%(50/50)
 *   - 负 intensity(摆烂):-5%
 */
export function pressureToFormMultiplier(pressureProfile) {
  if (!pressureProfile) return 1.0;
  const i = pressureProfile.intensity;
  if (i > 0.8) return 1.00;     // 极端压力 → 心理负担抵消斗志
  if (i > 0.5) return 1.01;
  if (i > 0.2) return 1.00;
  if (i > 0) return 1.00;
  if (i > -0.2) return 0.99;
  if (i > -0.3) return 0.97;
  return 0.95;                  // 摆烂
}

/**
 * 应用到 prediction 概率.
 */
export function applyStandingsPressureAdjustment(probabilities, homePressure, awayPressure) {
  const homeMult = pressureToFormMultiplier(homePressure);
  const awayMult = pressureToFormMultiplier(awayPressure);
  if (Math.abs(homeMult - awayMult) < 0.01) return probabilities;
  const homeAdvantage = homeMult / awayMult - 1;
  const adjusted = {
    home: probabilities.home * (1 + homeAdvantage * 0.5),
    draw: probabilities.draw,
    away: probabilities.away * (1 - homeAdvantage * 0.5)
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
