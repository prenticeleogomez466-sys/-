export function buildMonteCarloSimulation(fixture, probabilities, options = {}) {
  const iterations = wholeNumber(options.iterations, 20000);
  const seed = hash(`${fixture.id}-${fixture.kickoff}-${fixture.homeTeam}-${fixture.awayTeam}`);
  const rng = mulberry32(seed);
  const lambdas = estimateGoalLambdas(probabilities, options.xg);
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

function estimateGoalLambdas(probabilities, xg) {
  const homeXg = finiteNumber(xg?.home?.xg ?? xg?.homeXg, null);
  const awayXg = finiteNumber(xg?.away?.xg ?? xg?.awayXg, null);
  if (homeXg !== null && awayXg !== null && homeXg >= 0 && awayXg >= 0) {
    return { home: round(clamp(homeXg, 0.2, 4.2)), away: round(clamp(awayXg, 0.2, 4.2)), source: "xg" };
  }
  const homeEdge = (probabilities.home ?? 0.33) - (probabilities.away ?? 0.33);
  const drawPressure = probabilities.draw ?? 0.27;
  const totalGoals = clamp(2.65 - Math.max(0, drawPressure - 0.25) * 1.2 + Math.abs(homeEdge) * 0.55, 1.7, 3.6);
  const homeShare = clamp(0.5 + homeEdge * 0.75, 0.25, 0.75);
  return {
    home: round(totalGoals * homeShare),
    away: round(totalGoals * (1 - homeShare)),
    source: "probability-derived"
  };
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
