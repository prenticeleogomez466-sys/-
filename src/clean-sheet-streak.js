/**
 * Clean-Sheet Streak
 * ──────────────────────────────────────────────────
 * 连续不丢球 / 连续不进球 streak 的回归均值压力.
 *
 * 经验:
 *   - 连续 5 场清白单 → 下场清白单概率不升反降(均值回归)
 *   - 连续 3 场不进球 → 下场进球概率上升(均值回归 + 心理释放)
 *
 * 跟 streak-detector 区别:
 *   - streak 看 W/D/L
 *   - 这里只看 clean-sheet (gAgainst=0) 和 scoreless (gFor=0)
 */

/**
 * @param {Array<{goalsFor, goalsAgainst}>} matches 按时间倒序(最近第一)
 */
export function detectCleanSheetStreak(matches = []) {
  if (!Array.isArray(matches) || !matches.length) return null;
  let csCount = 0;
  let scorelessCount = 0;

  for (const m of matches) {
    if (Number(m.goalsAgainst ?? 0) === 0) csCount++;
    else break;
  }
  for (const m of matches) {
    if (Number(m.goalsFor ?? 0) === 0) scorelessCount++;
    else break;
  }

  return {
    cleanSheetStreak: csCount,
    scorelessStreak: scorelessCount,
    cleanSheetLevel: cleanSheetLevel(csCount),
    scorelessLevel: scorelessLevel(scorelessCount)
  };
}

function cleanSheetLevel(n) {
  if (n >= 5) return "extreme-cs-streak";
  if (n >= 3) return "strong-cs-streak";
  if (n >= 2) return "moderate-cs-streak";
  return "no-cs-streak";
}

function scorelessLevel(n) {
  if (n >= 4) return "extreme-scoreless-streak";
  if (n >= 3) return "strong-scoreless-streak";
  if (n >= 2) return "moderate-scoreless-streak";
  return "no-scoreless-streak";
}

/**
 * Streak → 下一场 BTTS / 大小球 / 进球数 概率调整.
 *
 * 极端 clean-sheet streak → mean reversion,下场 BTTS 概率 +5%(防线超表现到极限)
 * 极端 scoreless streak → 下场进球概率 +8%(心理释放)
 */
export function streakToProbabilityShift(streakInfo) {
  if (!streakInfo) return null;
  let bttsShift = 0;
  let overShift = 0;
  let teamScoreProb = 0;  // shift for "this team scores next match"

  if (streakInfo.cleanSheetLevel === "extreme-cs-streak") {
    bttsShift += 0.05;
    overShift += 0.04;
  } else if (streakInfo.cleanSheetLevel === "strong-cs-streak") {
    bttsShift += 0.03;
    overShift += 0.02;
  }

  if (streakInfo.scorelessLevel === "extreme-scoreless-streak") {
    teamScoreProb += 0.08;
    bttsShift += 0.05;
  } else if (streakInfo.scorelessLevel === "strong-scoreless-streak") {
    teamScoreProb += 0.05;
    bttsShift += 0.03;
  }

  return {
    bttsShift: round(bttsShift),
    overShift: round(overShift),
    teamScoreProbShift: round(teamScoreProb),
    narrative: buildStreakNarrative(streakInfo)
  };
}

function buildStreakNarrative(s) {
  const parts = [];
  if (s.cleanSheetStreak >= 5) parts.push(`连续 ${s.cleanSheetStreak} 场清白单,防线超表现可能均值回归`);
  else if (s.cleanSheetStreak >= 3) parts.push(`连续 ${s.cleanSheetStreak} 场清白单,防线在状态`);

  if (s.scorelessStreak >= 4) parts.push(`连续 ${s.scorelessStreak} 场未进球,进攻枯竭明显,可能爆发`);
  else if (s.scorelessStreak >= 3) parts.push(`连续 ${s.scorelessStreak} 场未进球,进攻乏力`);
  return parts.length ? parts.join(",") : "无显著 streak";
}

/**
 * Streak → LR(bayesian-belief-update 用).
 * Clean-sheet 强 = 主队不丢球可能,小幅利主胜 + 小球;
 * Scoreless 强 = 队进攻乏力,小幅反向.
 */
export function cleanSheetStreakToLR(homeStreak, awayStreak) {
  if (!homeStreak && !awayStreak) return null;
  let homeMult = 1, drawMult = 1, awayMult = 1;
  // 主队 CS streak strong → 防守好,赢/平,LR(主胜) > 1
  if (homeStreak?.cleanSheetLevel === "extreme-cs-streak") {
    homeMult *= 1.10; drawMult *= 1.03;
  } else if (homeStreak?.cleanSheetLevel === "strong-cs-streak") {
    homeMult *= 1.05; drawMult *= 1.02;
  }
  // 主队 scoreless streak strong → 进攻不行,平/客胜
  if (homeStreak?.scorelessLevel === "extreme-scoreless-streak") {
    homeMult *= 0.85; drawMult *= 1.05; awayMult *= 1.10;
  } else if (homeStreak?.scorelessLevel === "strong-scoreless-streak") {
    homeMult *= 0.92; drawMult *= 1.03; awayMult *= 1.05;
  }
  // 客队反向
  if (awayStreak?.cleanSheetLevel === "extreme-cs-streak") {
    awayMult *= 1.10; drawMult *= 1.03;
  }
  if (awayStreak?.scorelessLevel === "extreme-scoreless-streak") {
    awayMult *= 0.85; drawMult *= 1.05; homeMult *= 1.10;
  }
  return {
    home: round(homeMult),
    draw: round(drawMult),
    away: round(awayMult)
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
