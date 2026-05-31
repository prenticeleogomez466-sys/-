export function buildMonteCarloSimulation(fixture, probabilities, options = {}) {
  const iterations = wholeNumber(options.iterations, 20000);
  const seed = hash(`${fixture.id}-${fixture.kickoff}-${fixture.homeTeam}-${fixture.awayTeam}`);
  const rng = mulberry32(seed);
  const lambdas = estimateGoalLambdas(probabilities, options.xg, options.experienceBaseline, options.marketTotal);
  const outcomes = { home: 0, draw: 0, away: 0 };
  const scores = new Map();
  for (let index = 0; index < iterations; index += 1) {
    const homeGoals = Math.min(6, poisson(lambdas.home, rng));
    const awayGoals = Math.min(6, poisson(lambdas.away, rng));
    if (homeGoals > awayGoals) outcomes.home += 1;
    else if (homeGoals === awayGoals) outcomes.draw += 1;
    else outcomes.away += 1;
    const key = `${homeGoals}-${awayGoals}`;
    scores.set(key, (scores.get(key) ?? 0) + 1);
  }
  const outcomeProbabilities = {
    home: round(outcomes.home / iterations),
    draw: round(outcomes.draw / iterations),
    away: round(outcomes.away / iterations)
  };
  return {
    version: "seeded-monte-carlo-v1",
    iterations,
    seed,
    lambdas,
    outcomeProbabilities,
    topScores: [...scores.entries()]
      .map(([score, count]) => ({ score, probability: round(count / iterations) }))
      .sort((left, right) => right.probability - left.probability)
      .slice(0, 8)
  };
}

function estimateGoalLambdas(probabilities, xg, experienceBaseline = null, marketTotal = null) {
  const homeEdge = (probabilities.home ?? 0.33) - (probabilities.away ?? 0.33);
  const drawPressure = probabilities.draw ?? 0.27;
  // 1) 真实 per-team xG(最佳)。但 advanced-data 的「market-implied-xg-proxy」是用粗公式造的代理,
  //    不算真 xG,不能遮蔽下面更准的大小球校准 → 带 proxy 字样的 source 跳过本分支。
  const homeXg = finiteNumber(xg?.home?.xg ?? xg?.homeXg, null);
  const awayXg = finiteNumber(xg?.away?.xg ?? xg?.awayXg, null);
  const xgSrc = `${xg?.home?.source ?? ""}${xg?.away?.source ?? ""}`;
  if (homeXg !== null && awayXg !== null && homeXg >= 0 && awayXg >= 0 && !/proxy/i.test(xgSrc)) {
    return { home: round(clamp(homeXg, 0.2, 4.2)), away: round(clamp(awayXg, 0.2, 4.2)), source: "xg" };
  }
  // 2) 大小球(O/U)校准 λ 总量(2026-05-31,回测证实优于联赛均值:比分命中 +0.84pp、半全场 LogLoss -0.46%)。
  //    market 对进球总量的预期 = λ_total,胜负平给主客差 → split。仅在有真实盘口时用,缺则降级。
  const ouTotal = finiteNumber(marketTotal?.lambdaTotal, null);
  if (ouTotal !== null && ouTotal >= 1.2 && ouTotal <= 5) {
    const homeShare = clamp(0.5 + homeEdge * 0.75, 0.25, 0.75);
    return {
      home: round(clamp(ouTotal * homeShare, 0.15, 5)),
      away: round(clamp(ouTotal * (1 - homeShare), 0.15, 5)),
      source: `over-under-calibrated:${marketTotal.source ?? "ou"}`
    };
  }
  // 经验库基线(2026-05-30 修"比分像模仿"):用该联赛该热门档历史真实场均进球当 λ 总量,
  // 替代"只看概率差"的通用公式 —— 芬超(高进球)与欧冠(低进球)不再因 wld 相同而 λ 相同。
  // 总量取自经验库(联赛真实进球水平),主客分配仍按本场概率差(同档内不同赔率仍有区分)。
  const expHome = finiteNumber(experienceBaseline?.avgGoals?.home, null);
  const expAway = finiteNumber(experienceBaseline?.avgGoals?.away, null);
  if (expHome !== null && expAway !== null && expHome + expAway > 0.5) {
    const expTotal = clamp(expHome + expAway, 1.4, 4.2);
    // 经验桶自带方向(side+favProb 档),其 home/away 已含主场倾向;再按本场精确概率差微调分配,
    // 避免同桶不同赔率完全雷同。基准分配 = 经验桶分配,叠加本场 edge 偏移(阻尼)。
    const expShare = expHome / (expHome + expAway);
    const homeShare = clamp(expShare + homeEdge * 0.25, 0.2, 0.8);
    return {
      home: round(expTotal * homeShare),
      away: round(expTotal * (1 - homeShare)),
      source: `experience-library:${experienceBaseline.source ?? "?"}`,
      experienceN: experienceBaseline.n ?? null
    };
  }
  const totalGoals = clamp(2.65 - Math.max(0, drawPressure - 0.25) * 1.2 + Math.abs(homeEdge) * 0.55, 1.7, 3.6);
  const homeShare = clamp(0.5 + homeEdge * 0.75, 0.25, 0.75);
  return {
    home: round(totalGoals * homeShare),
    away: round(totalGoals * (1 - homeShare)),
    source: "probability-derived"
  };
}

// 由大小球盘口算 λ 总量:① 有两路赔率(over/under)→ 数值反解使 P(总进球>line)=去vig后的P(over);
// ② 只有线 → 用线作 λ_total 代理(线≈市场预期总量)。返回 { lambdaTotal, source } 或 null。
export function lambdaTotalFromMarket(marketTotal) {
  if (!marketTotal) return null;
  const line = finiteNumber(marketTotal.line, null);
  const overProb = finiteNumber(marketTotal.overProb, null);
  if (overProb !== null && overProb > 0.02 && overProb < 0.98 && line !== null && line > 0.5) {
    // P(N > line) = 1 - Σ_{k<k0} pois(k);X.5线→k0=ceil(line),整数线→over=N>line→k0=line+1。单调增于λ→二分
    const k0 = Number.isInteger(line) ? line + 1 : Math.ceil(line);
    const pOver = (lam) => { let cdf = 0, t = Math.exp(-lam); for (let k = 0; k < k0; k++) { cdf += t; t *= lam / (k + 1); } return 1 - cdf; };
    let lo = 0.3, hi = 6.5;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (pOver(mid) < overProb) lo = mid; else hi = mid; }
    return { lambdaTotal: round((lo + hi) / 2), source: "over-prob" };
  }
  if (line !== null && line >= 1.2 && line <= 5) return { lambdaTotal: round(line), source: "line-proxy" };
  return null;
}

function poisson(lambda, rng) {
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= rng();
  } while (product > limit);
  return count - 1;
}

function mulberry32(seed) {
  return function next() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(value) {
  let result = 0;
  for (const char of String(value)) result = (result * 31 + char.charCodeAt(0)) >>> 0;
  return result || 1;
}

function wholeNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1000, Math.floor(parsed)) : fallback;
}

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
