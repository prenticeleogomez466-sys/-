/**
 * Injury Impact Model
 * ──────────────────────────────────────────────────
 * 伤停名单对球队战力量化冲击.
 *
 * 输入:每个缺阵球员 { position, importance (0-1), marketValueM, role }
 * 输出:eloDelta + xgForMultiplier + xgAgainstMultiplier + cleanSheetProbabilityShift
 *
 * 权重(基于 Transfermarkt 经验):
 *   - GK 关键: 强,平均 Elo -25
 *   - 后腰/中卫领袖: Elo -20
 *   - 主力前锋: Elo -18
 *   - 边锋/AM: Elo -12
 *   - 替补/角色球员: Elo -3
 *
 * importance > 0.85 = star;0.70-0.85 = key;< 0.5 = rotation
 */

const POSITION_WEIGHTS = {
  "GK":   { elo: 25, xgFor: 1.0,  xgAgainst: 1.15, cs: -0.10 },
  "CB":   { elo: 18, xgFor: 0.97, xgAgainst: 1.10, cs: -0.08 },
  "DM":   { elo: 18, xgFor: 0.95, xgAgainst: 1.07, cs: -0.05 },
  "CM":   { elo: 13, xgFor: 0.95, xgAgainst: 1.03, cs: -0.02 },
  "AM":   { elo: 13, xgFor: 0.92, xgAgainst: 1.02, cs:  0    },
  "LB":   { elo: 10, xgFor: 0.97, xgAgainst: 1.05, cs: -0.04 },
  "RB":   { elo: 10, xgFor: 0.97, xgAgainst: 1.05, cs: -0.04 },
  "LW":   { elo: 12, xgFor: 0.90, xgAgainst: 1.0,  cs:  0    },
  "RW":   { elo: 12, xgFor: 0.90, xgAgainst: 1.0,  cs:  0    },
  "ST":   { elo: 16, xgFor: 0.85, xgAgainst: 1.0,  cs:  0    }
};

function getPositionWeight(pos) {
  return POSITION_WEIGHTS[pos] ?? { elo: 5, xgFor: 0.98, xgAgainst: 1.02, cs: -0.01 };
}

/**
 * @param {Array<{position, importance, role}>} absences
 *   importance 0..1
 *   role: "star" | "key" | "rotation"
 */
export function computeInjuryImpact(absences = []) {
  if (!Array.isArray(absences) || !absences.length) {
    return { eloDelta: 0, xgForMultiplier: 1, xgAgainstMultiplier: 1, cleanSheetShift: 0, absenceCount: 0, severity: "none" };
  }
  let elo = 0;
  let xgForMult = 1;
  let xgAgainstMult = 1;
  let csShift = 0;

  for (const ab of absences) {
    const w = getPositionWeight(ab.position);
    const importance = Number(ab.importance ?? (ab.role === "star" ? 0.95 : ab.role === "key" ? 0.75 : 0.45));
    const scale = importance;  // star × full weight,rotation 弱
    elo += w.elo * scale;
    xgForMult *= 1 + (w.xgFor - 1) * scale;
    xgAgainstMult *= 1 + (w.xgAgainst - 1) * scale;
    csShift += w.cs * scale;
  }

  return {
    eloDelta: elo === 0 ? 0 : -round(elo),
    xgForMultiplier: round(xgForMult),
    xgAgainstMultiplier: round(xgAgainstMult),
    cleanSheetShift: csShift === 0 ? 0 : round(csShift),
    absenceCount: absences.length,
    severity: classifySeverity(elo, absences.length)
  };
}

function classifySeverity(eloLoss, count) {
  if (eloLoss >= 40) return "catastrophic";
  if (eloLoss >= 25) return "major";
  if (eloLoss >= 15) return "significant";
  if (eloLoss >= 8) return "moderate";
  if (count > 0) return "minor";
  return "none";
}

/**
 * 对比主客两队 injury impact,产 net edge.
 */
export function compareInjuryImpact(homeAbsences, awayAbsences) {
  const home = computeInjuryImpact(homeAbsences);
  const away = computeInjuryImpact(awayAbsences);
  // home.eloDelta / away.eloDelta 都是负值(损失). home 损失少 → home.eloDelta 不那么负 → home - away > 0 利主.
  const netEloDelta = home.eloDelta - away.eloDelta;
  return {
    home,
    away,
    netEloShift: round(netEloDelta),
    homeAdvantageBonus: netEloDelta > 10 ? "boost" : netEloDelta < -10 ? "penalty" : "neutral",
    interpretation:
      Math.abs(netEloDelta) < 5
        ? "双方伤停损失接近,可忽略"
        : netEloDelta > 0
        ? `客队伤停净损失 ${Math.abs(netEloDelta)} Elo 点,利主队`
        : `主队伤停净损失 ${Math.abs(netEloDelta)} Elo 点,利客队`
  };
}

/**
 * 转 LR(直接给 bayesian-belief-update 用).
 */
export function injuryToLR(netEloShift) {
  // ±30 Elo ≈ ±10% 胜率 → LR ~1.10
  const scale = netEloShift / 30;
  const homeMult = Math.exp(scale * 0.10);
  const awayMult = Math.exp(-scale * 0.10);
  return {
    home: round(homeMult),
    draw: 1,
    away: round(awayMult)
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
