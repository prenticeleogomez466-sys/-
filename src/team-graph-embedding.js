/**
 * 球队相似图 Embedding(轻量 GNN,纯 JS)
 * ──────────────────────────────────────────────────
 * 借鉴 GNN message passing 思想,但**不训练神经网络**,而是用
 * "聚合邻居 → 球队 embedding"的迭代算法.
 *
 * 步骤:
 *   1. 节点 = 球队;边 = 历史交锋(权重 = 交锋次数 × 时间衰减)
 *   2. 初始 embedding = [home_attack, home_defense, away_attack, away_defense, league_id_onehot...]
 *   3. K 轮 message passing:
 *      embedding_v^(t+1) = aggregator(neighbors_messages) + self
 *   4. 输出每个球队的 dense embedding
 *
 * 用途:
 *   - 提升 KNN 找相似球队的精度(原 KNN 只用单点特征,这里用结构化 embedding)
 *   - 识别"风格相近"的球队(防守反击 / 高位逼抢等),即便从未交锋
 *   - 命中率提升:把"看上去无关"的历史样本通过 embedding 找到相似性
 */

const DEFAULT_EMBED_DIM = 8;
const DEFAULT_ROUNDS = 3;
const TIME_DECAY_DAYS = 365;

/**
 * 从历史比赛构建球队图.
 *
 * @param {Array} matches  历史比赛 [{ home, away, homeGoals, awayGoals, date }]
 * @param {Object} opts  embedDim, rounds, decay
 * @returns {Object} { teams: {team: embedding[]}, similarity(t1, t2), nearestTo(team, k) }
 */
export function buildTeamGraphEmbedding(matches, opts = {}) {
  const embedDim = opts.embedDim ?? DEFAULT_EMBED_DIM;
  const rounds = opts.rounds ?? DEFAULT_ROUNDS;
  const decayDays = opts.decayDays ?? TIME_DECAY_DAYS;

  if (!Array.isArray(matches) || matches.length < 5) {
    return { ok: false, reason: "insufficient-matches", teams: {} };
  }

  // 1. 收集球队列表 + 初始统计
  const teamStats = new Map();
  const today = new Date();
  for (const m of matches) {
    if (!m.home || !m.away) continue;
    const hg = Number(m.homeGoals), ag = Number(m.awayGoals);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const date = m.date ? new Date(`${m.date}T00:00:00+08:00`) : today;
    const daysAgo = Math.max(0, (today - date) / 86400000);
    const w = Math.pow(0.5, daysAgo / decayDays);  // 时间衰减
    if (!teamStats.has(m.home)) teamStats.set(m.home, { goalsFor: 0, goalsAgainst: 0, weight: 0, ngc: 0, home: 0 });
    if (!teamStats.has(m.away)) teamStats.set(m.away, { goalsFor: 0, goalsAgainst: 0, weight: 0, ngc: 0, home: 0 });
    const sh = teamStats.get(m.home), sa = teamStats.get(m.away);
    sh.goalsFor += hg * w; sh.goalsAgainst += ag * w; sh.weight += w; sh.home += w;
    sa.goalsFor += ag * w; sa.goalsAgainst += hg * w; sa.weight += w;
    if (hg + ag === 0) { sh.ngc += w; sa.ngc += w; }
  }

  // 2. 初始 embedding:对每队 [attack_rate, defense_rate, home_share, ngc_rate, ...]
  const teams = [...teamStats.keys()];
  const embeddings = new Map();
  for (const t of teams) {
    const s = teamStats.get(t);
    const w = Math.max(1, s.weight);
    const initial = new Array(embedDim).fill(0);
    initial[0] = (s.goalsFor / w) / 1.5;  // 攻击 normalized
    initial[1] = 1.5 - (s.goalsAgainst / w) / 1.5;  // 防守 (越大越好)
    initial[2] = s.home / w;  // 主场比重
    initial[3] = s.ngc / w;  // 0-0 率
    // 剩余维度随机初始化(让 message passing 区分)
    for (let i = 4; i < embedDim; i++) initial[i] = (Math.random() - 0.5) * 0.1;
    embeddings.set(t, initial);
  }

  // 3. 构邻接表:edge weight = 交锋次数 × 时间衰减
  const adj = new Map();
  for (const t of teams) adj.set(t, new Map());
  for (const m of matches) {
    if (!m.home || !m.away) continue;
    const date = m.date ? new Date(`${m.date}T00:00:00+08:00`) : today;
    const daysAgo = Math.max(0, (today - date) / 86400000);
    const w = Math.pow(0.5, daysAgo / decayDays);
    const aH = adj.get(m.home);
    const aA = adj.get(m.away);
    aH.set(m.away, (aH.get(m.away) || 0) + w);
    aA.set(m.home, (aA.get(m.home) || 0) + w);
  }

  // 4. Message passing K 轮(GCN 风格 + skip connection)
  for (let r = 0; r < rounds; r++) {
    const newEmbeddings = new Map();
    for (const t of teams) {
      const neighbors = adj.get(t);
      const agg = new Array(embedDim).fill(0);
      let totalWeight = 0;
      for (const [neighbor, weight] of neighbors.entries()) {
        const nEmb = embeddings.get(neighbor);
        if (!nEmb) continue;
        for (let i = 0; i < embedDim; i++) agg[i] += nEmb[i] * weight;
        totalWeight += weight;
      }
      const self = embeddings.get(t);
      const out = new Array(embedDim);
      for (let i = 0; i < embedDim; i++) {
        const neighborMean = totalWeight > 0 ? agg[i] / totalWeight : 0;
        out[i] = 0.5 * self[i] + 0.5 * neighborMean;  // skip + aggregate
        // tanh-like normalization
        out[i] = Math.tanh(out[i]);
      }
      newEmbeddings.set(t, out);
    }
    for (const t of teams) embeddings.set(t, newEmbeddings.get(t));
  }

  // 5. 暴露查询 API
  return {
    ok: true,
    teamCount: teams.length,
    embedDim,
    rounds,
    embeddings: Object.fromEntries([...embeddings.entries()].map(([t, e]) => [t, e.map(round)])),
    similarity(t1, t2) {
      const e1 = embeddings.get(t1);
      const e2 = embeddings.get(t2);
      if (!e1 || !e2) return null;
      return round(cosineSimilarity(e1, e2));
    },
    nearestTo(team, k = 5) {
      const target = embeddings.get(team);
      if (!target) return [];
      const sims = [];
      for (const [t, e] of embeddings.entries()) {
        if (t === team) continue;
        sims.push({ team: t, similarity: cosineSimilarity(target, e) });
      }
      return sims.sort((a, b) => b.similarity - a.similarity).slice(0, k).map((s) => ({ team: s.team, similarity: round(s.similarity) }));
    }
  };
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
