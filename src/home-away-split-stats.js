/**
 * Home/Away Split Statistics
 * ──────────────────────────────────────────────────
 * 同一队主客场表现差异极大 — 拜仁主场 PPG 2.7 vs 客场 1.9.
 * 单独维护 homeForm / awayForm,prediction 用对应一侧而非总平均.
 *
 * 关键观察:
 *   - PPG 主客差 ≥ 0.5 → "强势主场型"
 *   - PPG 主客差 ≤ -0.2 → "客场更强型"(罕见,可能 schedule artifact)
 *   - xG-for 主客差异 + xG-against 主客差异
 */

/**
 * @param {Array<{venue: "home"|"away", result, xgFor, xgAgainst, goalsFor, goalsAgainst}>} matches
 */
export function splitStats(matches = []) {
  if (!Array.isArray(matches)) return null;
  const home = matches.filter((m) => m.venue === "home");
  const away = matches.filter((m) => m.venue === "away");
  return {
    home: aggregate(home),
    away: aggregate(away),
    overall: aggregate(matches),
    splitDiff: computeSplitDiff(home, away)
  };
}

function aggregate(matches) {
  if (!matches.length) return null;
  const ppg = mean(matches.map((m) => {
    if (m.result === "W" || m.won === "W") return 3;
    if (m.result === "D" || m.won === "D") return 1;
    return 0;
  }));
  return {
    sampleSize: matches.length,
    ppg: round(ppg),
    avgGoalsFor: round(mean(matches.map((m) => Number(m.goalsFor ?? 0)))),
    avgGoalsAgainst: round(mean(matches.map((m) => Number(m.goalsAgainst ?? 0)))),
    avgXgFor: round(mean(matches.map((m) => Number(m.xgFor ?? 0)))),
    avgXgAgainst: round(mean(matches.map((m) => Number(m.xgAgainst ?? 0)))),
    cleanSheets: matches.filter((m) => Number(m.goalsAgainst ?? 0) === 0).length,
    cleanSheetRate: round(matches.filter((m) => Number(m.goalsAgainst ?? 0) === 0).length / matches.length)
  };
}

function computeSplitDiff(home, away) {
  if (!home.length || !away.length) return null;
  const ppgDiff = mean(home.map((m) => pointsFor(m))) - mean(away.map((m) => pointsFor(m)));
  return {
    ppgDiff: round(ppgDiff),
    classification: classifySplit(ppgDiff)
  };
}

function pointsFor(m) {
  if (m.result === "W" || m.won === "W") return 3;
  if (m.result === "D" || m.won === "D") return 1;
  return 0;
}

function classifySplit(ppgDiff) {
  if (ppgDiff >= 0.8) return "extreme-home-fortress";
  if (ppgDiff >= 0.5) return "strong-home-edge";
  if (ppgDiff >= 0.2) return "moderate-home-edge";
  if (ppgDiff >= -0.2) return "neutral";
  if (ppgDiff >= -0.5) return "weak-home-form";
  return "reverse-home-disadvantage";
}

/**
 * 给主客两队的 split,产 match-up 预测调整.
 */
export function projectHomeAwayMatch(homeSplit, awaySplit) {
  if (!homeSplit?.home || !awaySplit?.away) return null;
  // 主队用 home 一侧;客队用 away 一侧
  const projectedHomeGoals = round((homeSplit.home.avgGoalsFor + awaySplit.away.avgGoalsAgainst) / 2);
  const projectedAwayGoals = round((awaySplit.away.avgGoalsFor + homeSplit.home.avgGoalsAgainst) / 2);
  return {
    homeFormUsed: homeSplit.home,
    awayFormUsed: awaySplit.away,
    projectedHomeGoals,
    projectedAwayGoals,
    edgeFromSplit:
      homeSplit.splitDiff?.classification === "extreme-home-fortress" && awaySplit.splitDiff?.classification === "reverse-home-disadvantage"
        ? "极端利主"
        : homeSplit.splitDiff?.classification === "neutral" && awaySplit.splitDiff?.classification === "neutral"
        ? "split 中性"
        : "标准 split 利好"
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
