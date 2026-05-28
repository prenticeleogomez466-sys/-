/**
 * Metropolis-Hastings MCMC 采样
 * ──────────────────────────────────────────────────
 * 真 Bayesian 后验采样,替代当前 EM-like Hierarchical Poisson.
 * 给球队 attack / defense 参数完整后验分布,不只是点估计.
 *
 * 模型:
 *   homeGoals ~ Poisson(λ_h),  λ_h = exp(α_home + β_home_atk - β_away_def)
 *   awayGoals ~ Poisson(λ_a),  λ_a = exp(β_away_atk - β_home_def)
 *   先验:β ~ N(0, 1),α ~ N(0.3, 0.5)
 *
 * 后验采样 N 步,每个球队的 attack/defense 是 N 个样本的分布.
 *
 * 用途:
 *   - 输出 80% 后验区间,给 conformal-prediction 补充信号
 *   - 命中率间接提升(不确定性显式量化 → 模型分歧大时降仓避免冲动下注)
 *
 * 注:出于 JS 性能考虑,只对小球队集(<30)+ 短链(1000 步)demonstrate.
 *     大规模用 PyMC / Stan 离线训.
 */

const DEFAULT_STEPS = 2000;
const DEFAULT_BURNIN = 500;
const DEFAULT_PROPOSAL_SD = 0.1;

/**
 * MCMC 拟合.
 *
 * @param {Array} matches  [{ home, away, homeGoals, awayGoals }]
 * @param {Object} opts
 *   steps, burnIn, proposalSd, maxTeams(防止 OOM)
 */
export function fitMCMC(matches, opts = {}) {
  const steps = opts.steps ?? DEFAULT_STEPS;
  const burnIn = opts.burnIn ?? DEFAULT_BURNIN;
  const sd = opts.proposalSd ?? DEFAULT_PROPOSAL_SD;
  const maxTeams = opts.maxTeams ?? 30;

  // 收集球队 + 初始参数
  const teamSet = new Set();
  for (const m of matches) { teamSet.add(m.home); teamSet.add(m.away); }
  if (teamSet.size > maxTeams) {
    return { ok: false, reason: `too-many-teams:${teamSet.size}/${maxTeams}` };
  }
  const teams = [...teamSet];

  // 当前参数(用 log-scale)
  const current = {
    homeAdvantage: 0.3,
    teams: Object.fromEntries(teams.map((t) => [t, { attack: 0, defense: 0 }]))
  };

  // 采样历史
  const samples = [];

  let acceptCount = 0;
  for (let step = 0; step < steps; step++) {
    // 提议:每步随机扰动一个球队的 attack 或 defense
    const proposal = proposeUpdate(current, sd);
    const logA = computeLogPosterior(proposal, matches);
    const logB = computeLogPosterior(current, matches);
    const accept = Math.log(Math.random()) < (logA - logB);
    if (accept) {
      Object.assign(current, proposal);
      acceptCount++;
    }
    if (step >= burnIn) {
      samples.push({
        step,
        homeAdvantage: current.homeAdvantage,
        teams: structuredClone(current.teams)
      });
    }
  }

  // 聚合:每个球队取 mean + 80% interval
  const aggregated = {};
  for (const t of teams) {
    const atks = samples.map((s) => s.teams[t].attack);
    const defs = samples.map((s) => s.teams[t].defense);
    aggregated[t] = {
      attack: { mean: round(mean(atks)), q10: round(quantile(atks, 0.1)), q90: round(quantile(atks, 0.9)) },
      defense: { mean: round(mean(defs)), q10: round(quantile(defs, 0.1)), q90: round(quantile(defs, 0.9)) }
    };
  }

  return {
    ok: true,
    steps,
    burnIn,
    acceptRate: round(acceptCount / steps),
    samples: samples.length,
    homeAdvantage: { mean: round(mean(samples.map((s) => s.homeAdvantage))) },
    teams: aggregated,
    /**
     * 用 posterior samples 预测一场比赛的概率分布(蒙特卡洛).
     */
    predictWithUncertainty(home, away) {
      if (!aggregated[home] || !aggregated[away]) return null;
      const wins = { home: 0, draw: 0, away: 0 };
      const sampleSize = Math.min(samples.length, 200);
      for (let i = 0; i < sampleSize; i++) {
        const s = samples[Math.floor(Math.random() * samples.length)];
        const lh = Math.exp(s.homeAdvantage + s.teams[home].attack - s.teams[away].defense);
        const la = Math.exp(s.teams[away].attack - s.teams[home].defense);
        const homeGoals = poissonSample(lh);
        const awayGoals = poissonSample(la);
        if (homeGoals > awayGoals) wins.home++;
        else if (homeGoals === awayGoals) wins.draw++;
        else wins.away++;
      }
      const total = wins.home + wins.draw + wins.away;
      return {
        home: round(wins.home / total),
        draw: round(wins.draw / total),
        away: round(wins.away / total),
        sampleSize
      };
    }
  };
}

function proposeUpdate(current, sd) {
  const teams = Object.keys(current.teams);
  const t = teams[Math.floor(Math.random() * teams.length)];
  const param = Math.random() < 0.5 ? "attack" : "defense";
  const delta = (Math.random() * 2 - 1) * sd;
  const next = {
    homeAdvantage: current.homeAdvantage,
    teams: structuredClone(current.teams)
  };
  next.teams[t][param] += delta;
  return next;
}

function computeLogPosterior(params, matches) {
  let logLike = 0;
  for (const m of matches) {
    if (!params.teams[m.home] || !params.teams[m.away]) continue;
    const hg = Number(m.homeGoals), ag = Number(m.awayGoals);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const lh = Math.exp(params.homeAdvantage + params.teams[m.home].attack - params.teams[m.away].defense);
    const la = Math.exp(params.teams[m.away].attack - params.teams[m.home].defense);
    logLike += poissonLogPMF(hg, lh) + poissonLogPMF(ag, la);
  }
  // 先验:β ~ N(0, 1)
  let logPrior = 0;
  for (const t of Object.values(params.teams)) {
    logPrior += -0.5 * t.attack * t.attack;
    logPrior += -0.5 * t.defense * t.defense;
  }
  logPrior += -2 * Math.pow(params.homeAdvantage - 0.3, 2);  // N(0.3, 0.5)
  return logLike + logPrior;
}

function poissonLogPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(lambda) - lambda - logFact(k);
}

function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  // Normal approximation
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalSample()));
}

function normalSample() {
  const u1 = Math.max(1e-12, Math.random());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
}

function logFact(n) {
  let v = 0;
  for (let i = 2; i <= n; i++) v += Math.log(i);
  return v;
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
}

function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
