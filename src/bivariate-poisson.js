/**
 * Bivariate Poisson 模型(借鉴 penaltyblog)
 * ──────────────────────────────────────────────────
 * Karlis & Ntzoufras (2003) 双变量泊松.是 Dixon-Coles 的现代替代品:
 *
 *   Dixon-Coles 用 tau 函数对 (0,0)/(0,1)/(1,0)/(1,1) 4 个特殊点做 hack 修正
 *   → 数学上不够自然
 *
 *   Bivariate Poisson 用一个共同分量 λ_3 直接建模主客队进球的相关性
 *   → 自然处理"相互压制""高节奏 vs 低节奏"等真实现象
 *
 * 模型:
 *   X = X_1 + X_3,  Y = X_2 + X_3
 *   X_1, X_2, X_3 ~ 独立 Poisson(λ_1), Poisson(λ_2), Poisson(λ_3)
 *
 * 联合 PMF:
 *   P(X=x, Y=y) = exp(-(λ_1+λ_2+λ_3)) × (λ_1^x / x!) × (λ_2^y / y!)
 *                × sum_{k=0..min(x,y)} C(x,k) C(y,k) k! (λ_3 / (λ_1 λ_2))^k
 *
 * 当 λ_3 = 0 时退化为独立泊松(跟 Poisson baseline 一致).
 *
 * 用途:
 *   - 作为 DC 引擎的对照,看相同样本下两个模型的预测差
 *   - 在 ensemble 里加一票(权重小)
 *   - 自然处理 over/under(λ_1 + λ_2 + 2λ_3 是总进球期望)
 */

export function fitBivariatePoisson(matches, opts = {}) {
  const minSamples = opts.minSamples ?? 30;
  const iterations = opts.iterations ?? 60;
  const homeAdv = opts.homeAdvantage ?? 1.28;

  if (!Array.isArray(matches) || matches.length < minSamples) {
    return { ok: false, coldStart: true, reason: `insufficient:${matches?.length ?? 0}/${minSamples}`,
             baseRate: 1.35, homeAdvantage: homeAdv, lambda3: 0, teams: {} };
  }

  const teams = {};
  const ensure = (n) => { if (!teams[n]) teams[n] = { attack: 1, defense: 1 }; };
  for (const m of matches) {
    if (!m.home || !m.away) continue;
    ensure(m.home);
    ensure(m.away);
  }
  const teamNames = Object.keys(teams);

  // 计算全局参数(类似 DC 的 base rate)
  let goalsHome = 0, goalsAway = 0, n = 0;
  for (const m of matches) {
    if (!Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
    goalsHome += m.homeGoals;
    goalsAway += m.awayGoals;
    n++;
  }
  if (n === 0) return { ok: false, coldStart: true, reason: "no-results", baseRate: 1.35, homeAdvantage: homeAdv, lambda3: 0, teams: {} };

  const meanHome = goalsHome / n;
  const meanAway = goalsAway / n;
  const baseRate = (meanHome + meanAway) / 2;

  // 估 λ_3:用样本协方差(Karlis-Ntzoufras 的 method of moments)
  let covSum = 0;
  for (const m of matches) {
    if (!Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
    covSum += (m.homeGoals - meanHome) * (m.awayGoals - meanAway);
  }
  const lambda3 = Math.max(0, covSum / n);  // 协方差只取非负(否则没物理意义)

  // 迭代估球队 attack/defense:simplified — 用 DC 风格的 iterative scaling
  for (let it = 0; it < iterations; it++) {
    const adjA = {}, adjD = {};
    for (const name of teamNames) {
      adjA[name] = { actual: 0, expected: 0 };
      adjD[name] = { actual: 0, expected: 0 };
    }
    for (const m of matches) {
      if (!Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals)) continue;
      const th = teams[m.home], ta = teams[m.away];
      const expH = baseRate * th.attack * ta.defense * homeAdv;
      const expA = baseRate * ta.attack * th.defense;
      adjA[m.home].actual += m.homeGoals; adjA[m.home].expected += expH;
      adjA[m.away].actual += m.awayGoals; adjA[m.away].expected += expA;
      adjD[m.away].actual += m.homeGoals; adjD[m.away].expected += expH;
      adjD[m.home].actual += m.awayGoals; adjD[m.home].expected += expA;
    }
    for (const name of teamNames) {
      if (adjA[name].expected > 0) teams[name].attack *= 1 + (adjA[name].actual / adjA[name].expected - 1) * 0.5;
      if (adjD[name].expected > 0) teams[name].defense *= 1 + (adjD[name].actual / adjD[name].expected - 1) * 0.5;
    }
  }

  return {
    ok: true,
    coldStart: false,
    samples: n,
    baseRate, homeAdvantage: homeAdv, lambda3,
    teams,
    predict(homeTeam, awayTeam) {
      const th = teams[homeTeam] ?? { attack: 1, defense: 1, coldStart: true };
      const ta = teams[awayTeam] ?? { attack: 1, defense: 1, coldStart: true };
      const lambda1 = Math.max(0.01, baseRate * th.attack * ta.defense * homeAdv - lambda3);
      const lambda2 = Math.max(0.01, baseRate * ta.attack * th.defense - lambda3);
      const matrix = bivariatePoissonMatrix(lambda1, lambda2, lambda3, 8);
      const probs = outcomeProbs(matrix);
      const expHome = lambda1 + lambda3;
      const expAway = lambda2 + lambda3;
      return {
        source: "bivariate-poisson",
        coldStart: Boolean(th.coldStart || ta.coldStart),
        probabilities: probs,
        expectedGoals: { home: round(expHome), away: round(expAway) },
        lambda: { lambda1: round(lambda1), lambda2: round(lambda2), lambda3: round(lambda3) },
        matrix
      };
    }
  };
}

export function bivariatePoissonMatrix(lambda1, lambda2, lambda3, maxGoals = 8) {
  // PMF(x, y) = e^{-(λ1+λ2+λ3)} * λ1^x/x! * λ2^y/y!
  //           * sum_{k=0..min(x,y)} (x choose k)(y choose k) k! (λ3/(λ1 λ2))^k
  const matrix = [];
  const expFactor = Math.exp(-(lambda1 + lambda2 + lambda3));
  let total = 0;
  for (let x = 0; x <= maxGoals; x++) {
    matrix[x] = [];
    for (let y = 0; y <= maxGoals; y++) {
      let s = 0;
      const kmax = Math.min(x, y);
      for (let k = 0; k <= kmax; k++) {
        const term = binomial(x, k) * binomial(y, k) * factorial(k)
                   * Math.pow(lambda3, k) / Math.pow(lambda1 * lambda2, k);
        s += term;
      }
      const p = expFactor * Math.pow(lambda1, x) / factorial(x)
              * Math.pow(lambda2, y) / factorial(y) * s;
      matrix[x][y] = Number.isFinite(p) && p > 0 ? p : 0;
      total += matrix[x][y];
    }
  }
  // 归一化(maxGoals 截尾导致少量概率丢失,重新分配)
  if (total > 0) {
    for (let x = 0; x <= maxGoals; x++)
      for (let y = 0; y <= maxGoals; y++) matrix[x][y] /= total;
  }
  return matrix;
}

function outcomeProbs(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      if (h > a) home += matrix[h][a];
      else if (h === a) draw += matrix[h][a];
      else away += matrix[h][a];
    }
  return { home: round(home), draw: round(draw), away: round(away) };
}

const _fcache = [1, 1];
function factorial(n) {
  if (n < 0) return Infinity;
  if (n < _fcache.length) return _fcache[n];
  let v = _fcache[_fcache.length - 1];
  for (let i = _fcache.length; i <= n; i++) { v *= i; _fcache[i] = v; }
  return _fcache[n];
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  return factorial(n) / (factorial(k) * factorial(n - k));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
