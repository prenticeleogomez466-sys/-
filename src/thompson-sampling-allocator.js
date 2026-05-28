/**
 * Thompson Sampling 资金分配器
 * ──────────────────────────────────────────────────
 * 当一天多场比赛可投时,Thompson Sampling 用 Bayesian 后验自动分配资金:
 *   - 每场维护一个 Beta(α, β) 后验(从历史 hit rate 学到)
 *   - 决策时从每个 Beta 抽样 → 用抽样后的概率算凯利仓位
 *   - 自然平衡 exploration(尝试 unknown 比赛) vs exploitation(押已知靠谱的)
 *
 * 适合的场景:今天 5 场都正 EV 但仓位有限,怎么分?
 * 简单做法:按 EV 比例.Thompson:按 hit rate 后验抽样,更稳健.
 *
 * 参考:Wikipedia Thompson sampling + Kelly portfolio applications.
 */

const DEFAULT_PRIOR_ALPHA = 1;
const DEFAULT_PRIOR_BETA = 1;
const DEFAULT_SAMPLES = 100;

/**
 * 给一组候选(每个有 prior + 推荐凯利 + 赔率),用 Thompson Sampling 分配仓位.
 *
 * @param {Array} candidates [{ id, betaAlpha, betaBeta, odds, modelProb }]
 *   betaAlpha/Beta: 后验分布参数(从历史 hit rate 累加)
 *   modelProb: 模型给的概率(用作 fallback 当 alpha+beta < min)
 *   odds: 下注赔率
 * @param {number} totalBankroll 可用总资金
 * @param {Object} opts
 *   samples: 抽样次数,默认 100
 *   kellyFraction: 1/4 Kelly,默认 0.25
 */
export function allocateThompson(candidates, totalBankroll, opts = {}) {
  const samples = opts.samples ?? DEFAULT_SAMPLES;
  const kellyFraction = opts.kellyFraction ?? 0.25;
  const minPosterior = opts.minPosterior ?? 5;  // alpha+beta < 5 时用 modelProb

  if (!Array.isArray(candidates) || !candidates.length) return { ok: false, reason: "no-candidates" };

  // 累积每个 candidate 的"被选中次数"(Thompson 抽样投票)
  const tally = new Map(candidates.map((c) => [c.id, { votes: 0, sumProb: 0 }]));

  for (let s = 0; s < samples; s++) {
    let best = null;
    let bestEV = -Infinity;
    for (const c of candidates) {
      // 从后验抽一个概率
      const alpha = Number(c.betaAlpha ?? DEFAULT_PRIOR_ALPHA);
      const beta = Number(c.betaBeta ?? DEFAULT_PRIOR_BETA);
      const sampledP = (alpha + beta) >= minPosterior
        ? sampleBeta(alpha, beta)
        : (Number(c.modelProb) || sampleBeta(alpha + 1, beta + 1));
      const ev = sampledP * Number(c.odds) - 1;
      if (ev > bestEV) {
        bestEV = ev;
        best = c;
      }
      // 累积平均抽样概率
      tally.get(c.id).sumProb += sampledP;
    }
    if (best) tally.get(best.id).votes += 1;
  }

  // 投票比例 → 仓位
  const allocations = candidates.map((c) => {
    const t = tally.get(c.id);
    const votingShare = t.votes / samples;
    const avgSampledProb = t.sumProb / samples;
    // 用 avgSampledProb + 赔率算凯利,再乘投票比例 + kellyFraction
    const b = Number(c.odds) - 1;
    const fullKelly = b > 0 ? (avgSampledProb * b - (1 - avgSampledProb)) / b : 0;
    const adjustedFraction = Math.max(0, fullKelly * kellyFraction);
    const baseStake = totalBankroll * adjustedFraction;
    // Thompson 调整:乘投票比例(被选频率高 → 加权)
    const stake = baseStake * (votingShare + 0.1);  // 加 0.1 避免零仓
    return {
      id: c.id,
      votingShare: round(votingShare),
      sampledMeanProb: round(avgSampledProb),
      fullKelly: round(fullKelly),
      adjustedKellyFraction: round(adjustedFraction),
      stake: round(stake),
      odds: c.odds
    };
  });

  // 归一化:总仓位不超过 totalBankroll × kellyFraction × 2
  const maxTotalStake = totalBankroll * kellyFraction * 2;
  const currentTotal = allocations.reduce((s, a) => s + a.stake, 0);
  if (currentTotal > maxTotalStake) {
    const scale = maxTotalStake / currentTotal;
    for (const a of allocations) a.stake = round(a.stake * scale);
  }

  return {
    ok: true,
    samples,
    totalBankroll,
    totalStake: round(allocations.reduce((s, a) => s + a.stake, 0)),
    allocations: allocations.sort((a, b) => b.stake - a.stake)
  };
}

/**
 * Beta 分布抽样:从 Beta(α, β) 抽一个 [0,1] 之间的概率
 * 用 Gamma 法:Beta(α,β) ~ X/(X+Y), X~Gamma(α), Y~Gamma(β)
 */
export function sampleBeta(alpha, beta) {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

// Marsaglia & Tsang Gamma sampler(α≥1 时用,α<1 时 boost)
export function sampleGamma(shape) {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = normalSample();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample() {
  // Box-Muller
  const u1 = Math.max(1e-12, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 从历史 ledger 算每个 method/outcome 的 Beta(α, β) 后验
 */
export function buildBetaPosteriorsFromLedger(rows, opts = {}) {
  const priorAlpha = opts.priorAlpha ?? DEFAULT_PRIOR_ALPHA;
  const priorBeta = opts.priorBeta ?? DEFAULT_PRIOR_BETA;
  const buckets = new Map();
  for (const row of rows ?? []) {
    if (typeof row.hit !== "boolean") continue;
    const key = row.method ?? row.bucket ?? "global";
    if (!buckets.has(key)) buckets.set(key, { alpha: priorAlpha, beta: priorBeta, n: 0 });
    const b = buckets.get(key);
    if (row.hit) b.alpha += 1;
    else b.beta += 1;
    b.n += 1;
  }
  const out = {};
  for (const [k, b] of buckets.entries()) {
    out[k] = { ...b, hitRate: b.alpha / (b.alpha + b.beta) };
  }
  return out;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
