/**
 * Head-to-Head (H2H) History Model
 * ──────────────────────────────────────────────────
 * 两队历史交手记录的影响:
 *   - 克星效应("我就是赢不了他")
 *   - 心理优势(连续 3+ 场不败)
 *   - 时间衰减(5 年前的克星没用了)
 *
 * 注意:H2H 多数情况下效果被 Elo 覆盖,只有在特定情况下才有边际价值:
 *   - 同联赛多年交手
 *   - 长期克星(8+ 次交手主胜率 < 20%)
 *   - 主场不败 / 客场不胜的强烈模式
 */

const RECENT_WEIGHT_HALFLIFE_DAYS = 730;  // 2 年

/**
 * @param {Array<{date, homeTeam, awayTeam, homeGoals, awayGoals}>} h2hMatches
 * @param {string} team1
 * @param {string} team2
 */
export function analyzeH2H(h2hMatches, team1, team2) {
  if (!Array.isArray(h2hMatches) || h2hMatches.length < 3) {
    return { ok: false, reason: "insufficient-h2h-data", sampleSize: h2hMatches?.length ?? 0 };
  }
  const now = Date.now();
  const decoratedMatches = h2hMatches.map((m) => {
    const isTeam1Home = m.homeTeam === team1;
    const team1Goals = isTeam1Home ? m.homeGoals : m.awayGoals;
    const team2Goals = isTeam1Home ? m.awayGoals : m.homeGoals;
    const result =
      team1Goals > team2Goals ? "team1" :
      team1Goals < team2Goals ? "team2" : "draw";
    const ageDays = m.date ? Math.max(0, (now - new Date(m.date).getTime()) / 86400000) : 365;
    const weight = Math.pow(2, -ageDays / RECENT_WEIGHT_HALFLIFE_DAYS);
    return { ...m, isTeam1Home, team1Goals, team2Goals, result, ageDays, weight };
  });

  // 加权胜率
  const total = decoratedMatches.reduce((s, m) => s + m.weight, 0);
  const team1Wins = decoratedMatches.filter((m) => m.result === "team1").reduce((s, m) => s + m.weight, 0);
  const draws = decoratedMatches.filter((m) => m.result === "draw").reduce((s, m) => s + m.weight, 0);
  const team2Wins = decoratedMatches.filter((m) => m.result === "team2").reduce((s, m) => s + m.weight, 0);

  const team1WinRate = total > 0 ? team1Wins / total : 0;
  const drawRate = total > 0 ? draws / total : 0;
  const team2WinRate = total > 0 ? team2Wins / total : 0;

  // 近 5 场
  const recent5 = decoratedMatches.slice(0, 5);
  const recent5Team1Wins = recent5.filter((m) => m.result === "team1").length;

  return {
    ok: true,
    sampleSize: h2hMatches.length,
    weightedSampleSize: round(total),
    team1WinRate: round(team1WinRate),
    drawRate: round(drawRate),
    team2WinRate: round(team2WinRate),
    recent5Team1Wins,
    pattern: detectPattern(decoratedMatches, team1WinRate, team2WinRate, drawRate),
    avgGoalsPerMatch: round(mean(decoratedMatches.map((m) => m.team1Goals + m.team2Goals)))
  };
}

function detectPattern(matches, t1WR, t2WR, dWR) {
  // 先看 draw 倾向(避免被 nemesis 误吞)
  if (dWR > 0.40) return "draw-tendency";
  if (matches.length >= 8) {
    if (t1WR < 0.20 && t2WR > 0.50) return "team2-historical-nemesis";
    if (t2WR < 0.20 && t1WR > 0.50) return "team1-historical-nemesis";
  }
  if (matches.length >= 5) {
    const last5 = matches.slice(0, 5);
    const t1Wins5 = last5.filter((m) => m.result === "team1").length;
    if (t1Wins5 >= 4) return "team1-recent-dominance";
    if (t1Wins5 === 0 && last5.filter((m) => m.result === "team2").length >= 4) return "team2-recent-dominance";
  }
  return "balanced";
}

/**
 * H2H → LR(bayesian-belief-update 用,把 team1 当主队).
 * 注意: 只有 "强模式" 才产 LR,否则 null.
 */
export function h2hToLR(h2hAnalysis) {
  if (!h2hAnalysis?.ok) return null;
  const pattern = h2hAnalysis.pattern;
  if (pattern === "balanced") return null;

  // team1 是克星 = team1 (=home) 历史上压倒 team2 → 主胜 LR 高
  if (pattern === "team1-historical-nemesis") {
    return { home: 1.20, draw: 1.05, away: 0.80 };
  }
  // team2 是克星 = team2 (=away) 历史上压倒 team1 → 客胜 LR 高
  if (pattern === "team2-historical-nemesis") {
    return { home: 0.80, draw: 1.05, away: 1.20 };
  }
  if (pattern === "draw-tendency") {
    return { home: 0.95, draw: 1.15, away: 0.95 };
  }
  if (pattern === "team1-recent-dominance") {
    return { home: 1.10, draw: 1.00, away: 0.92 };
  }
  if (pattern === "team2-recent-dominance") {
    return { home: 0.92, draw: 1.00, away: 1.10 };
  }
  return null;
}

/**
 * 主场 H2H 单独分析(很多球队的克星只在客场出现).
 */
export function analyzeHomeH2H(h2hMatches, team1Name) {
  if (!Array.isArray(h2hMatches)) return null;
  const team1Home = h2hMatches.filter((m) => m.homeTeam === team1Name);
  const team1Away = h2hMatches.filter((m) => m.awayTeam === team1Name);
  return {
    team1HomeMatches: team1Home.length,
    team1AwayMatches: team1Away.length,
    team1HomeWins: team1Home.filter((m) => m.homeGoals > m.awayGoals).length,
    team1AwayWins: team1Away.filter((m) => m.awayGoals > m.homeGoals).length,
    team1HomeWinRate: team1Home.length > 0 ? round(team1Home.filter((m) => m.homeGoals > m.awayGoals).length / team1Home.length) : null,
    team1AwayWinRate: team1Away.length > 0 ? round(team1Away.filter((m) => m.awayGoals > m.homeGoals).length / team1Away.length) : null
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
