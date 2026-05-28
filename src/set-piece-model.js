/**
 * Set Piece Specialist 模型
 * ──────────────────────────────────────────────────
 * 球队进球来源:运动战 / 角球 / 任意球 / 点球.
 * 某些球队(防守反击型 / 高大中卫多 / 主罚球员强)set piece 进球占比 25-35%,
 * 拉高 over / 比分概率.
 *
 * 经验数据:
 *   - 全联赛平均:set piece 占进球 25-30%
 *   - 顶级 set piece team(如 Burnley/Atlético):35-45%
 *   - Tiki-taka team(Man City/Barca):15-20%(运动战为主)
 */

/**
 * 计算球队 set piece 进球占比.
 *
 * @param {Array} goals [{ teamId, type: "open-play"|"corner"|"free-kick"|"penalty"|"own-goal" }]
 */
export function computeSetPieceProfile(goals) {
  const profiles = new Map();
  for (const g of goals) {
    const team = g.teamId ?? g.team;
    if (!team) continue;
    if (!profiles.has(team)) profiles.set(team, {
      team, total: 0, openPlay: 0, corner: 0, freeKick: 0, penalty: 0, ownGoal: 0
    });
    const p = profiles.get(team);
    p.total++;
    const type = String(g.type ?? "").toLowerCase();
    if (type.includes("open") || type === "运动战") p.openPlay++;
    else if (type.includes("corner") || type === "角球") p.corner++;
    else if (type.includes("free") || type === "任意球") p.freeKick++;
    else if (type.includes("penalty") || type === "点球") p.penalty++;
    else if (type.includes("own") || type === "乌龙") p.ownGoal++;
    else p.openPlay++;  // default
  }
  const out = {};
  for (const [team, p] of profiles.entries()) {
    if (p.total < 5) continue;
    const setPieceTotal = p.corner + p.freeKick + p.penalty;
    out[team] = {
      team,
      total: p.total,
      openPlayShare: round(p.openPlay / p.total),
      setPieceShare: round(setPieceTotal / p.total),
      cornerShare: round(p.corner / p.total),
      freeKickShare: round(p.freeKick / p.total),
      penaltyShare: round(p.penalty / p.total),
      classification: classifyTeam(p, setPieceTotal)
    };
  }
  return out;
}

function classifyTeam(p, setPieceTotal) {
  const setRatio = setPieceTotal / p.total;
  if (setRatio > 0.35) return "set-piece-specialist";
  if (setRatio > 0.25) return "balanced";
  return "open-play-team";
}

/**
 * 联赛级 set piece baseline.
 */
export function leagueSetPieceBaseline(profiles) {
  const values = Object.values(profiles);
  if (!values.length) return null;
  return {
    avgOpenPlayShare: round(mean(values.map((v) => v.openPlayShare))),
    avgSetPieceShare: round(mean(values.map((v) => v.setPieceShare))),
    sampleTeams: values.length
  };
}

/**
 * 调整 over/under 概率:set piece specialist 双方 → over 概率 +(因为 set piece 进球加成).
 */
export function applySetPieceToOverUnder(baselineOverProb, homeProfile, awayProfile) {
  if (!homeProfile || !awayProfile) return baselineOverProb;
  const avgSetShare = ((homeProfile.setPieceShare ?? 0.25) + (awayProfile.setPieceShare ?? 0.25)) / 2;
  // 经验:set piece 高的两队 → over 概率 +3pp,低的 → -2pp
  let shift = 0;
  if (avgSetShare > 0.32) shift = 0.03;
  else if (avgSetShare > 0.28) shift = 0.015;
  else if (avgSetShare < 0.20) shift = -0.02;
  return round(Math.max(0.05, Math.min(0.95, baselineOverProb + shift)));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
