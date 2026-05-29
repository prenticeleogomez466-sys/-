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

/**
 * 把主客场分离表现转成信号融合层的 LR 证据。
 * 逻辑:本场主队取其**主场** PPG,客队取其**客场** PPG,二者之差 = 各自在对应场地的相对强度。
 *   - 主场强、客队客场弱 → 抬主胜;反之抬客胜。draw 中性。
 * 数据门控:任一侧主/客样本 < 3 或净差 < 0.3 PPG(噪声地板)→ 返回 null(休眠)。
 * @param {Object} homeSplit splitStats(主队近期赛果) 的返回
 * @param {Object} awaySplit splitStats(客队近期赛果) 的返回
 * @returns {{home,draw,away}|null}
 */
export function homeAwaySplitToLR(homeSplit, awaySplit) {
  const hp = homeSplit?.home?.ppg;
  const ap = awaySplit?.away?.ppg;
  if (!Number.isFinite(hp) || !Number.isFinite(ap)) return null;
  if ((homeSplit.home.sampleSize ?? 0) < 3 || (awaySplit.away.sampleSize ?? 0) < 3) return null;
  const edge = hp - ap; // 主队主场 PPG − 客队客场 PPG,范围约 [-3,3]
  if (Math.abs(edge) < 0.3) return null; // 噪声地板
  const k = 0.18; // 1.5 PPG 净差 ≈ 朝优势侧 LR ~1.31
  const fav = Math.exp(Math.max(-0.5, Math.min(0.5, k * edge)));
  return { home: round(fav), draw: 1, away: round(1 / fav) };
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
