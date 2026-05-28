/**
 * Massey 评级(借鉴 penaltyblog)
 * ──────────────────────────────────────────────────
 * Kenneth Massey 1997 论文的算法。基于进球差矩阵求线性方程组:
 *
 *   X' X r = X' y
 *
 * 其中 X 是 n×m 比赛-球队矩阵(主队=+1, 客队=-1, 其他=0),
 * y 是该场的进球差向量,r 是要求解的 m 维球队 rating 向量。
 *
 * 系统矩阵 (X'X) 是 m×m,主对角线 = 该队比赛场次,非对角线 = -两队交手次数。
 * 单解:加约束 sum(r)=0,把最后一行替换成 [1,1,...,1]、最后 y_m=0,就能解出唯一 rating。
 *
 * Massey vs Pi-ratings vs Elo:
 *   - Massey 只看进球差(纯线性回归),没有时间衰减
 *   - 适合"实力评估"而非"形式预测"
 *   - 跟 Elo / Pi-ratings 做 ensemble 时贡献"长期实力"分量
 */

export function fitMasseyRatings(matches, opts = {}) {
  const minSamples = opts.minSamples ?? 10;
  if (!Array.isArray(matches) || matches.length < minSamples) {
    return { ok: false, reason: `insufficient-samples:${matches?.length ?? 0}/${minSamples}` };
  }
  const teams = new Set();
  for (const m of matches) {
    if (!m.home || !m.away || !Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
    teams.add(m.home);
    teams.add(m.away);
  }
  const teamList = [...teams];
  const teamIdx = Object.fromEntries(teamList.map((t, i) => [t, i]));
  const n = teamList.length;
  if (n < 2) return { ok: false, reason: "less-than-2-teams" };

  // 构造 X'X (n×n) 和 X'y (n)
  // X'X[i][i] = 球队 i 比赛场次
  // X'X[i][j] = -i 和 j 交手次数
  const M = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);

  for (const m of matches) {
    const i = teamIdx[m.home], j = teamIdx[m.away];
    if (i === undefined || j === undefined) continue;
    const diff = Number(m.homeGoals) - Number(m.awayGoals);
    if (!Number.isFinite(diff)) continue;
    M[i][i] += 1;
    M[j][j] += 1;
    M[i][j] -= 1;
    M[j][i] -= 1;
    b[i] += diff;
    b[j] -= diff;
  }

  // 加约束 sum(r) = 0:把最后一行替换成 [1,1,...,1],b[n-1] = 0
  M[n - 1] = new Array(n).fill(1);
  b[n - 1] = 0;

  // 高斯消元解 M r = b
  const r = gaussianSolve(M, b);
  if (!r) return { ok: false, reason: "singular-matrix" };

  const ratings = Object.fromEntries(teamList.map((t, i) => [t, round(r[i])]));
  return {
    ok: true,
    samples: matches.length,
    teams: ratings,
    teamList,
    predictGoalDiff(homeTeam, awayTeam) {
      const rh = ratings[homeTeam] ?? 0;
      const ra = ratings[awayTeam] ?? 0;
      return round(rh - ra);
    },
    predictWinProb(homeTeam, awayTeam, homeAdv = 0.25) {
      const diff = this.predictGoalDiff(homeTeam, awayTeam) + homeAdv;
      const sigmoid = (x) => 1 / (1 + Math.exp(-x * 0.7));
      const home = sigmoid(diff);
      const away = sigmoid(-diff);
      const draw = Math.max(0.05, 0.28 - 0.18 * Math.abs(diff));
      const total = home + away + draw;
      return { home: round(home / total), draw: round(draw / total), away: round(away / total), goalDiff: diff };
    },
    topTeams(k = 10) {
      return Object.entries(ratings)
        .map(([t, r]) => ({ team: t, rating: r }))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, k);
    }
  };
}

// 高斯消元(部分主元 partial pivoting)
function gaussianSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    // 找主元
    let maxRow = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > Math.abs(M[maxRow][k])) maxRow = i;
    }
    if (Math.abs(M[maxRow][k]) < 1e-12) return null;  // 奇异
    [M[k], M[maxRow]] = [M[maxRow], M[k]];
    // 消元
    for (let i = k + 1; i < n; i++) {
      const factor = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= factor * M[k][j];
    }
  }
  // 回代
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
