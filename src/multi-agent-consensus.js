/**
 * Multi-Agent Consensus 投票框架(借鉴 W-5 Multi-Agent AI)
 * ──────────────────────────────────────────────────
 * 每个评级方法/模型是一个独立 agent,先各自投票,然后聚合.
 *
 * 三种聚合策略:
 *   - majority-vote: 简单多数(每个 agent argmax 一票)
 *   - weighted-majority: 按权重投票(用 RPS 反加权)
 *   - borda-count: 排名平均(每个 agent 排第 i 给 (n-i) 分)
 *
 * 跟 ratings-ensemble 互补:
 *   - ensemble = soft voting(概率加权平均)
 *   - consensus = hard voting(类别投票)
 *
 * 当 ensemble 输出 0.55/0.30/0.15 但所有 agent 都 argmax="home" 时,
 * 这种"全员共识"信号比 soft 概率更稳健.
 */

const OUTCOMES = ["home", "draw", "away"];

/**
 * @param {Object} agentPredictions  { agentName: { home, draw, away } }
 * @param {Object} opts
 *   strategy: "majority" | "weighted" | "borda"
 *   weights: 用于 weighted 策略
 */
export function aggregateConsensus(agentPredictions, opts = {}) {
  const strategy = opts.strategy ?? "majority";
  const valid = Object.entries(agentPredictions).filter(([, p]) => p && Number.isFinite(p.home) && Number.isFinite(p.draw) && Number.isFinite(p.away));
  if (!valid.length) return { ok: false, reason: "no-valid-agents" };

  if (strategy === "majority") return majorityVote(valid);
  if (strategy === "weighted") return weightedMajorityVote(valid, opts.weights ?? {});
  if (strategy === "borda") return bordaCount(valid);
  return { ok: false, reason: `unknown-strategy:${strategy}` };
}

function majorityVote(agents) {
  const votes = { home: 0, draw: 0, away: 0 };
  const individual = [];
  for (const [name, probs] of agents) {
    const top = OUTCOMES.reduce((a, b) => probs[a] >= probs[b] ? a : b);
    votes[top]++;
    individual.push({ agent: name, vote: top, probabilities: probs });
  }
  const total = agents.length;
  const winner = OUTCOMES.reduce((a, b) => votes[a] >= votes[b] ? a : b);
  return {
    ok: true,
    strategy: "majority",
    winner,
    confidence: round(votes[winner] / total),
    voteCounts: votes,
    consensusStrength: votes[winner] === total ? "全员一致" :
                       votes[winner] / total >= 0.66 ? "多数共识" :
                       votes[winner] / total >= 0.5 ? "弱共识" : "分歧",
    individual
  };
}

function weightedMajorityVote(agents, weights) {
  const votes = { home: 0, draw: 0, away: 0 };
  const individual = [];
  let totalWeight = 0;
  for (const [name, probs] of agents) {
    const w = Number(weights[name] ?? 1);
    if (w <= 0) continue;
    const top = OUTCOMES.reduce((a, b) => probs[a] >= probs[b] ? a : b);
    votes[top] += w;
    totalWeight += w;
    individual.push({ agent: name, vote: top, weight: w, probabilities: probs });
  }
  if (totalWeight === 0) return majorityVote(agents);
  const winner = OUTCOMES.reduce((a, b) => votes[a] >= votes[b] ? a : b);
  return {
    ok: true,
    strategy: "weighted-majority",
    winner,
    confidence: round(votes[winner] / totalWeight),
    voteWeights: votes,
    totalWeight,
    individual
  };
}

function bordaCount(agents) {
  const points = { home: 0, draw: 0, away: 0 };
  const individual = [];
  for (const [name, probs] of agents) {
    const ranked = OUTCOMES.slice().sort((a, b) => probs[b] - probs[a]);
    ranked.forEach((outcome, i) => {
      points[outcome] += OUTCOMES.length - i;
    });
    individual.push({ agent: name, ranking: ranked, probabilities: probs });
  }
  const totalPoints = Object.values(points).reduce((s, v) => s + v, 0);
  const winner = OUTCOMES.reduce((a, b) => points[a] >= points[b] ? a : b);
  return {
    ok: true,
    strategy: "borda",
    winner,
    pointShares: {
      home: round(points.home / totalPoints),
      draw: round(points.draw / totalPoints),
      away: round(points.away / totalPoints)
    },
    points,
    individual
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
