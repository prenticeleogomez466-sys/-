/**
 * 裁判倾向模型
 * ──────────────────────────────────────────────────
 * 从历史执法数据算每个裁判的:
 *   - 罚牌率(场均黄牌 / 红牌)
 *   - 主队偏向(主队执法时主胜率)
 *   - 点球倾向(场均判罚点球)
 *
 * 对预测的影响:
 *   - 主队偏向高的裁判 → 主胜概率轻度上调(+0.5-1.5pp)
 *   - 罚牌率高 → 进球可能受影响(节奏放缓)
 *   - 点球倾向高 → over 概率轻度上调
 *
 * LR 表交给 bayesian-belief-update 使用.
 */

/**
 * 拟合裁判 profile.
 *
 * @param {Array} history [{ refereeId, refereeName, isHome, won, yellows, reds, penalties }]
 * @returns {Object} { refereeId → profile }
 */
export function fitRefereeProfiles(history) {
  if (!Array.isArray(history) || !history.length) return {};
  const profiles = new Map();
  for (const m of history) {
    const id = m.refereeId ?? m.refereeName;
    if (!id) continue;
    if (!profiles.has(id)) profiles.set(id, {
      id, name: m.refereeName,
      matches: 0, homeWins: 0, draws: 0, awayWins: 0,
      yellowsTotal: 0, redsTotal: 0, penaltiesTotal: 0
    });
    const p = profiles.get(id);
    p.matches++;
    if (m.won === "home") p.homeWins++;
    else if (m.won === "away") p.awayWins++;
    else p.draws++;
    p.yellowsTotal += Number(m.yellows ?? 0);
    p.redsTotal += Number(m.reds ?? 0);
    p.penaltiesTotal += Number(m.penalties ?? 0);
  }
  // Compute rates
  const out = {};
  for (const [id, p] of profiles.entries()) {
    if (p.matches < 5) continue;  // 样本太少
    out[id] = {
      id, name: p.name,
      matches: p.matches,
      homeWinRate: round(p.homeWins / p.matches),
      drawRate: round(p.draws / p.matches),
      awayWinRate: round(p.awayWins / p.matches),
      yellowsPerMatch: round(p.yellowsTotal / p.matches),
      redsPerMatch: round(p.redsTotal / p.matches),
      penaltiesPerMatch: round(p.penaltiesTotal / p.matches),
      tendency: classify(p)
    };
  }
  return out;
}

function classify(p) {
  const homeRate = p.homeWins / p.matches;
  const yellows = p.yellowsTotal / p.matches;
  return {
    homeFriendly: homeRate > 0.50,
    strict: yellows > 5.5,
    penaltyProne: p.penaltiesTotal / p.matches > 0.3
  };
}

/**
 * 给一个裁判 profile + baseline league rates,算 LR 调整因子.
 *
 * @param {Object} profile  fitRefereeProfiles 输出之一
 * @param {Object} leagueBaseline  { homeWinRate, drawRate, awayWinRate, yellowsPerMatch }
 */
export function computeRefereeLR(profile, leagueBaseline) {
  if (!profile || !leagueBaseline) return null;
  const homeShift = Number(profile.homeWinRate) / Math.max(0.01, Number(leagueBaseline.homeWinRate ?? 0.45));
  const awayShift = Number(profile.awayWinRate) / Math.max(0.01, Number(leagueBaseline.awayWinRate ?? 0.30));
  const drawShift = Number(profile.drawRate) / Math.max(0.01, Number(leagueBaseline.drawRate ?? 0.25));
  // Clip [0.85, 1.15] 避免单一裁判 LR 过度影响
  return {
    home: clamp(homeShift, 0.85, 1.15),
    draw: clamp(drawShift, 0.85, 1.15),
    away: clamp(awayShift, 0.85, 1.15)
  };
}

/**
 * 给 prediction 加裁判调整(返回新概率).
 */
export function applyRefereeBias(probabilities, refereeProfile, leagueBaseline) {
  const lr = computeRefereeLR(refereeProfile, leagueBaseline);
  if (!lr) return probabilities;
  const adjusted = {
    home: probabilities.home * lr.home,
    draw: probabilities.draw * lr.draw,
    away: probabilities.away * lr.away
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum)
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
