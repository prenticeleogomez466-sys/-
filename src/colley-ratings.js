/**
 * Colley 评级(借鉴 penaltyblog)
 * ──────────────────────────────────────────────────
 * Wesley Colley 论文。跟 Massey 同样用线性方程组,但**不看进球差,只看胜平负**。
 *
 * 系统矩阵 C r = b,其中:
 *   C[i][i] = 2 + 球队 i 比赛场次
 *   C[i][j] = -i j 交手次数
 *   b[i] = 1 + (胜场 - 负场) / 2
 *
 * 这个公式从 Colley 的 Laplace's rule of succession 推出。
 * 平局算 0.5 胜 + 0.5 负。
 *
 * Massey vs Colley:
 *   - Massey 看进球差(惨败 7-0 比赢 1-0 算实力差很大)
 *   - Colley 只看胜负(7-0 跟 1-0 都算 1 胜)
 *   - 真实比赛里两者互补:Massey 捕捉 dominance,Colley 捕捉 robustness
 */

export function fitColleyRatings(matches, opts = {}) {
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

  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  // 初始化对角线 = 2(Colley 公式)
  for (let i = 0; i < n; i++) {
    C[i][i] = 2;
    b[i] = 1;
  }

  for (const m of matches) {
    const i = teamIdx[m.home], j = teamIdx[m.away];
    if (i === undefined || j === undefined) continue;
    const hg = Number(m.homeGoals), ag = Number(m.awayGoals);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    C[i][i] += 1;
    C[j][j] += 1;
    C[i][j] -= 1;
    C[j][i] -= 1;
    // 胜场 - 负场:平局 0
    let wDiffI, wDiffJ;
    if (hg > ag) { wDiffI = 1; wDiffJ = -1; }
    else if (hg < ag) { wDiffI = -1; wDiffJ = 1; }
    else { wDiffI = 0; wDiffJ = 0; }
    b[i] += wDiffI / 2;
    b[j] += wDiffJ / 2;
  }

  const r = gaussianSolve(C, b);
  if (!r) return { ok: false, reason: "singular-matrix" };

  const ratings = Object.fromEntries(teamList.map((t, i) => [t, round(r[i])]));
  return {
    ok: true,
    samples: matches.length,
    teams: ratings,
    teamList,
    predictWinProb(homeTeam, awayTeam, homeAdv = 0.04) {
      const rh = ratings[homeTeam] ?? 0.5;
      const ra = ratings[awayTeam] ?? 0.5;
      // Colley rating 已经是 [0, 1] 区间的实力值,加 homeAdv shift
      const diff = (rh + homeAdv) - ra;
      const sigmoid = (x) => 1 / (1 + Math.exp(-x * 4));
      const home = sigmoid(diff);
      const away = sigmoid(-diff);
      const draw = Math.max(0.05, 0.28 - 0.7 * Math.abs(diff));
      const total = home + away + draw;
      return { home: round(home / total), draw: round(draw / total), away: round(away / total), ratingDiff: round(diff) };
    },
    topTeams(k = 10) {
      return Object.entries(ratings)
        .map(([t, r]) => ({ team: t, rating: r }))
        .sort((a, b) => b.rating - a.rating)
        .slice(0, k);
    }
  };
}

function gaussianSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let maxRow = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(M[i][k]) > Math.abs(M[maxRow][k])) maxRow = i;
    }
    if (Math.abs(M[maxRow][k]) < 1e-12) return null;
    [M[k], M[maxRow]] = [M[maxRow], M[k]];
    for (let i = k + 1; i < n; i++) {
      const factor = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= factor * M[k][j];
    }
  }
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
