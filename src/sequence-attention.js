/**
 * Self-Attention 序列加权(轻量 Transformer 思想,纯 JS)
 * ──────────────────────────────────────────────────
 * 给球队近 N 场比赛序列(form sequence)做 self-attention 加权,
 * 而不是简单的"最近 5 场平均".
 *
 * Self-attention 原理:
 *   attention(q_i, k_j) = softmax(q_i · k_j / √d)
 *   weighted_form_i = sum_j attention(q_i, k_j) * v_j
 *
 * 实际效果:
 *   - 同对手类型的历史比赛权重高(对强队的表现 vs 对弱队)
 *   - 同场地条件的比赛权重高(主场表现 vs 客场)
 *   - 时间衰减 + 上下文相关 = 比固定时间窗口更智能
 *
 * 用途:
 *   - 给 Elo / Pi-ratings 提供更精细的"近期 form"输入
 *   - 命中率提升:识别"对当前对手类型最相关的历史样本"
 */

const DEFAULT_LOOKBACK = 10;

/**
 * 给一组近期比赛(query = 当前要预测的对手类型),算 attention-weighted form 指标.
 *
 * @param {Array} recentMatches  最近 N 场 [{ opponent, isHome, gf, ga, opponentRating, date }]
 *   注意 gf/ga 是球队 perspective(无论主客)
 * @param {Object} query  当前对手特征 { opponentRating, isHome }
 * @returns {{ weights, weightedGoalsFor, weightedGoalsAgainst, weightedPoints, attentionTopK }}
 */
export function attentionWeightedForm(recentMatches, query, opts = {}) {
  const lookback = opts.lookback ?? DEFAULT_LOOKBACK;
  const matches = (recentMatches ?? []).slice(-lookback);
  if (!matches.length) return null;

  const targetRating = Number(query.opponentRating ?? 1500);
  const targetHome = query.isHome ? 1 : 0;
  const today = Date.now();

  // 1. 计算 attention scores(基于对手相似度 + 主客场相似度 + 时间)
  const rawScores = matches.map((m) => {
    const mRating = Number(m.opponentRating ?? 1500);
    const ratingDist = Math.abs(targetRating - mRating);
    const ratingSim = Math.exp(-ratingDist / 200);   // 对手 rating 越接近权重越大

    const homeMatch = (m.isHome ? 1 : 0) === targetHome ? 1 : 0.5;  // 主客场一致加权

    const daysAgo = m.date ? Math.max(0, (today - new Date(m.date).getTime()) / 86400000) : 0;
    const timeWeight = Math.exp(-daysAgo / 180);    // 半衰期 180 天

    return ratingSim * homeMatch * timeWeight;
  });

  // 2. Softmax normalize
  const maxScore = Math.max(...rawScores);
  const expScores = rawScores.map((s) => Math.exp(s - maxScore));
  const sumExp = expScores.reduce((s, v) => s + v, 0);
  const weights = expScores.map((e) => e / sumExp);

  // 3. Attention-weighted aggregates
  let wgf = 0, wga = 0, wPoints = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const w = weights[i];
    wgf += w * Number(m.gf ?? 0);
    wga += w * Number(m.ga ?? 0);
    const points = m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0;
    wPoints += w * points;
  }

  // 4. Top-K 最相关的历史比赛
  const topK = matches
    .map((m, i) => ({ match: m, weight: weights[i] }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, opts.topK ?? 3);

  return {
    weights: weights.map(round),
    weightedGoalsFor: round(wgf),
    weightedGoalsAgainst: round(wga),
    weightedPoints: round(wPoints),
    attentionTopK: topK.map((t) => ({
      opponent: t.match.opponent,
      score: `${t.match.gf}-${t.match.ga}`,
      isHome: t.match.isHome,
      weight: round(t.weight)
    })),
    expectedForm: round(wPoints / 3)  // [0, 1] 归一化的"对此类对手的预期得分率"
  };
}

/**
 * 比较两个球队对当前查询的 attention-weighted form.
 */
export function compareTwoTeamsAttention(homeMatches, awayMatches, query) {
  const home = attentionWeightedForm(homeMatches, { ...query, isHome: true });
  const away = attentionWeightedForm(awayMatches, { ...query, isHome: false });
  if (!home || !away) return null;
  return {
    home, away,
    formGap: round((home.expectedForm ?? 0) - (away.expectedForm ?? 0)),
    goalDifferential: round((home.weightedGoalsFor - home.weightedGoalsAgainst) -
                            (away.weightedGoalsFor - away.weightedGoalsAgainst))
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
