/**
 * Voting Classifier(soft + hard 双模式)
 * ──────────────────────────────────────────────────
 * 借鉴 sklearn VotingClassifier 接口:
 *   - soft voting: 加权平均概率(我们的 ratings-ensemble 默认是这个)
 *   - hard voting: 每个 estimator argmax 投票,majority 胜
 *
 * 这里加 hard mode + 平局 tie-breaking 规则.
 */

const OUTCOMES = ["home", "draw", "away"];

/**
 * Hard voting:每个 estimator argmax → 票多者胜.
 * 平局时:按 estimator 的 confidence(top-1 概率)加权 fallback.
 *
 * @param {Object} estimatorPredictions { name: { home, draw, away } }
 * @param {Object} opts
 *   weights: 用于平局时的次级 tiebreak
 */
export function hardVote(estimatorPredictions, opts = {}) {
  const valid = Object.entries(estimatorPredictions).filter(([, p]) =>
    p && Number.isFinite(p.home) && Number.isFinite(p.draw) && Number.isFinite(p.away)
  );
  if (!valid.length) return { ok: false };

  const votes = { home: 0, draw: 0, away: 0 };
  const confidenceSum = { home: 0, draw: 0, away: 0 };
  const individual = [];
  for (const [name, probs] of valid) {
    const top = OUTCOMES.reduce((a, b) => probs[a] >= probs[b] ? a : b);
    const w = Number(opts.weights?.[name] ?? 1);
    votes[top] += w;
    confidenceSum[top] += probs[top] * w;
    individual.push({ name, vote: top, confidence: probs[top] });
  }

  // 找最高票
  const maxVotes = Math.max(votes.home, votes.draw, votes.away);
  const winners = OUTCOMES.filter((o) => votes[o] === maxVotes);

  let winner;
  if (winners.length === 1) {
    winner = winners[0];
  } else {
    // tiebreak: 平均 confidence 最高者胜
    winner = winners.reduce((a, b) =>
      (confidenceSum[a] / Math.max(1, votes[a])) >= (confidenceSum[b] / Math.max(1, votes[b])) ? a : b
    );
  }

  // 输出概率分布:每个 outcome 的 hard probability = votes / totalVotes
  const totalVotes = votes.home + votes.draw + votes.away;
  return {
    ok: true,
    mode: "hard",
    winner,
    probabilities: {
      home: round(votes.home / totalVotes),
      draw: round(votes.draw / totalVotes),
      away: round(votes.away / totalVotes)
    },
    voteCounts: votes,
    tied: winners.length > 1,
    tieResolution: winners.length > 1 ? "by-confidence" : null,
    individual
  };
}

/**
 * Soft voting:加权平均概率.
 */
export function softVote(estimatorPredictions, opts = {}) {
  const valid = Object.entries(estimatorPredictions).filter(([, p]) =>
    p && Number.isFinite(p.home) && Number.isFinite(p.draw) && Number.isFinite(p.away)
  );
  if (!valid.length) return { ok: false };

  let totalWeight = 0;
  const accum = { home: 0, draw: 0, away: 0 };
  for (const [name, probs] of valid) {
    const w = Number(opts.weights?.[name] ?? 1);
    accum.home += w * probs.home;
    accum.draw += w * probs.draw;
    accum.away += w * probs.away;
    totalWeight += w;
  }
  if (totalWeight === 0) return { ok: false };
  const out = {
    home: accum.home / totalWeight,
    draw: accum.draw / totalWeight,
    away: accum.away / totalWeight
  };
  // 归一化
  const sum = out.home + out.draw + out.away;
  if (sum > 0) {
    out.home /= sum;
    out.draw /= sum;
    out.away /= sum;
  }
  const winner = OUTCOMES.reduce((a, b) => out[a] >= out[b] ? a : b);
  return {
    ok: true,
    mode: "soft",
    winner,
    probabilities: { home: round(out.home), draw: round(out.draw), away: round(out.away) }
  };
}

/**
 * Hybrid:soft 给概率,hard 给方向.比较两者是否一致 → "强信号" or "矛盾".
 */
export function hybridVote(estimatorPredictions, opts = {}) {
  const soft = softVote(estimatorPredictions, opts);
  const hard = hardVote(estimatorPredictions, opts);
  if (!soft.ok || !hard.ok) return { ok: false };
  return {
    ok: true,
    soft: soft.probabilities,
    hard: hard.probabilities,
    softWinner: soft.winner,
    hardWinner: hard.winner,
    agree: soft.winner === hard.winner,
    confidence: soft.winner === hard.winner ? "强信号 (soft + hard agree)" : "矛盾 (soft argmax 跟 hard majority 不同,推荐谨慎)"
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
