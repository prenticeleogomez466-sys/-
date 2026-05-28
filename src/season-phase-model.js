/**
 * Season Phase Model
 * ──────────────────────────────────────────────────
 * 赛季不同阶段对结果的影响:
 *   - 早季(月 1-3): 队伍磨合,转会重整,数据噪声大
 *   - 中季(月 4-8): 状态稳定,数据最可靠
 *   - 末季(月 9-10): 目标压力分化(争冠 / 保级 / 已锁定)
 *
 * 月份按"赛季月"计数,8 月开赛 = 月 1.
 */

const PHASE_PROFILES = {
  "early": {
    samplingMonths: [1, 2, 3],
    dataReliability: 0.70,
    drawProbBoost: 1.05,
    upsetProbBoost: 1.15,
    note: "早季阵容磨合中,样本不稳"
  },
  "mid": {
    samplingMonths: [4, 5, 6, 7, 8],
    dataReliability: 1.00,
    drawProbBoost: 1.00,
    upsetProbBoost: 1.00,
    note: "中季状态稳定"
  },
  "late": {
    samplingMonths: [9, 10],
    dataReliability: 0.85,
    drawProbBoost: 0.95,
    upsetProbBoost: 1.10,  // 已锁定排名球队心态不同
    note: "末季目标分化,需考虑动机"
  }
};

/**
 * 根据当前日期 + 赛季起始月,判断处于哪个阶段.
 * @param {Date|string} matchDate
 * @param {number} seasonStartMonth 默认 8(8 月开赛)
 */
export function detectSeasonPhase(matchDate, seasonStartMonth = 8) {
  const d = typeof matchDate === "string" ? new Date(matchDate) : matchDate;
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const monthIdx0 = d.getMonth() + 1;  // 1-12
  // 赛季月 = ((monthIdx0 - seasonStartMonth + 12) % 12) + 1
  const seasonMonth = ((monthIdx0 - seasonStartMonth + 12) % 12) + 1;

  let phase = "mid";
  if (PHASE_PROFILES.early.samplingMonths.includes(seasonMonth)) phase = "early";
  else if (PHASE_PROFILES.late.samplingMonths.includes(seasonMonth)) phase = "late";

  return {
    seasonMonth,
    phase,
    profile: PHASE_PROFILES[phase]
  };
}

/**
 * 给基础概率 + 队伍 motivation 状态,产末季调整.
 */
export function adjustForSeasonPhase(probabilities, matchDate, motivations = {}) {
  if (!probabilities) return null;
  const detected = detectSeasonPhase(matchDate);
  if (!detected) return { adjusted: probabilities, profile: null };

  const phase = detected.profile;
  const adjusted = {
    home: probabilities.home,
    draw: probabilities.draw * phase.drawProbBoost,
    away: probabilities.away
  };

  // 末季 motivation 分化
  if (detected.phase === "late") {
    // 主队已锁,客队保级:upset 概率 +20%
    if (motivations.homeRankSecured && motivations.awayFightingForSurvival) {
      adjusted.away *= 1.25;
      adjusted.home *= 0.85;
    }
    // 主队冲冠,客队已锁:主队 +10%
    if (motivations.homeTitle && motivations.awayRankSecured) {
      adjusted.home *= 1.12;
    }
    if (motivations.homeFightingForSurvival && motivations.awayRankSecured) {
      adjusted.home *= 1.18;  // 主场背水一战
    }
  }

  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    detected,
    adjusted: {
      home: round(adjusted.home / sum),
      draw: round(adjusted.draw / sum),
      away: round(adjusted.away / sum)
    },
    motivationsApplied: detected.phase === "late" ? motivations : null
  };
}

/**
 * Phase → confidence 调整(早季数据可靠性低 → 预测置信下调).
 */
export function phaseConfidenceMultiplier(matchDate) {
  const d = detectSeasonPhase(matchDate);
  return d?.profile.dataReliability ?? 1;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
