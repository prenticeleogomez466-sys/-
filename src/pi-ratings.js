/**
 * Pi-ratings 球队评级(借鉴 penaltyblog)
 * ──────────────────────────────────────────────────
 * Pi-rating 比 Elo 更先进 —— 它把球队拆成「主场 rating」和「客场 rating」,
 * 因为主客表现差异客观存在(主场优势不等于一个常数 +1.28)。
 *
 * 原始论文:Constantinou & Fenton (2013) "Determining the level of ability of
 * football teams by dynamic ratings based on the relative discrepancies in
 * scores between adversaries".
 *
 * 算法:
 *   1. 每队两个 rating:Ph (主场实力), Pa (客场实力)
 *   2. 比赛预测进球差 = Ph_home - Pa_away
 *   3. 实际差 vs 预测差 → 误差更新两个 rating(LR 风格)
 *   4. 学习率 λ ~ 0.06,γ ~ 0.5(主客场 rating 互相 spillover 系数)
 *
 * 用法:
 *   const ratings = fitPiRatings(matches);
 *   ratings.predictGoalDiff(homeTeam, awayTeam);
 *   ratings.predictWinProb(homeTeam, awayTeam);
 */

const DEFAULT_LAMBDA = 0.06;
const DEFAULT_GAMMA = 0.5;
const DEFAULT_PSI = 0.8;  // 进球差到胜率的转换缩放
const PRIOR_RATING = 0;

export function fitPiRatings(matches, opts = {}) {
  const lambda = opts.lambda ?? DEFAULT_LAMBDA;
  const gamma = opts.gamma ?? DEFAULT_GAMMA;
  const psi = opts.psi ?? DEFAULT_PSI;

  const ratings = new Map();  // team -> { home: number, away: number }
  const ensure = (name) => {
    if (!ratings.has(name)) ratings.set(name, { home: PRIOR_RATING, away: PRIOR_RATING });
    return ratings.get(name);
  };

  let processed = 0;
  for (const m of matches) {
    if (!m.home || !m.away || !Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
    const rh = ensure(m.home);
    const ra = ensure(m.away);
    const predictedDiff = rh.home - ra.away;
    const actualDiff = m.homeGoals - m.awayGoals;
    const error = actualDiff - predictedDiff;
    // 更新主场 rating(主队): direct error
    rh.home += lambda * error;
    // 主队的客场 rating 受同样比赛的间接影响(γ 衰减)
    rh.away += lambda * gamma * error;
    // 客队对称: error 反符号
    ra.away -= lambda * error;
    ra.home -= lambda * gamma * error;
    processed++;
  }

  return {
    ok: processed > 0,
    samples: processed,
    teams: Object.fromEntries(ratings),
    lambda, gamma, psi,
    predictGoalDiff(homeTeam, awayTeam) {
      const rh = ratings.get(homeTeam) ?? { home: PRIOR_RATING, away: PRIOR_RATING };
      const ra = ratings.get(awayTeam) ?? { home: PRIOR_RATING, away: PRIOR_RATING };
      return round(rh.home - ra.away);
    },
    predictWinProb(homeTeam, awayTeam) {
      const diff = this.predictGoalDiff(homeTeam, awayTeam);
      // logistic 转换:diff > 0 → 主队优势
      const sigmoid = (x) => 1 / (1 + Math.exp(-x));
      const homeWin = sigmoid(diff * psi);
      const awayWin = sigmoid(-diff * psi);
      // 平局:|diff| 越小 平局率越高
      const drawWidth = 0.27;  // 经验值
      const draw = Math.max(0.05, drawWidth - 0.18 * Math.abs(diff));
      // 归一化
      const total = homeWin + draw + awayWin;
      return {
        home: round(homeWin / total),
        draw: round(draw / total),
        away: round(awayWin / total),
        goalDiff: diff
      };
    },
    topTeams(n = 10) {
      const arr = [...ratings.entries()].map(([t, r]) => ({
        team: t, home: round(r.home), away: round(r.away),
        total: round(r.home + r.away)
      }));
      return arr.sort((a, b) => b.total - a.total).slice(0, n);
    }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
