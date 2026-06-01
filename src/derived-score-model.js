// 从每场 λ 直接构造"真实泊松比分模型"(2026-05-30 用户硬要求:不许兜底,比分/半全场/让球必须真实跑出来)。
//
// 背景:无训练 DC 的场次(冷门/次级联赛/友谊赛),原先比分/半全场落 prediction-engine 的
//   scoreForOutcome / halfFullForOutcome 死表(只按 favoriteStrength 桶返回 1-0/2-0...,不用任何球队数据)。
//   而模型其实每场都从赔率/xG 推了 λ。本模块用该 λ 构造带 Dixon-Coles τ 低分修正的全场比分矩阵,
//   提供与 dcResult 同形状的 { topScores, expectedGoals, probabilities, matrix },
//   直接喂给现成的 scoreFromDcResult / halfFullFromDcResult,使比分/半全场恒由真矩阵派生、永不落死表。
//
// 设计要点:
//   - τ 修正、ρ、MAX_GOALS 全部复用 dixon-coles-engine.scoreMatrix,口径与训练 DC 完全一致;
//   - bestScoreFromMatrix 全矩阵扫描,保证任一 wld 方向(主胜/平/客胜)都能取到真实最高概率比分;
//   - handicapCoverFromMatrix 从矩阵算让球真实覆盖/走盘概率 + 模型公平线,强化让球分析(方向仍由上游锚 wld)。

import { scoreMatrix } from "./dixon-coles-engine.js";

const OUTCOME_BY_CODE = { "3": "home", "1": "draw", "0": "away" };

export function buildDerivedScoreModel(lambdaHome, lambdaAway, opts = {}) {
  const lh = clamp(Number(lambdaHome), 0.15, 5);
  const la = clamp(Number(lambdaAway), 0.15, 5);
  if (!Number.isFinite(lh) || !Number.isFinite(la)) return null;
  const rho = Number(opts.rho ?? process.env.DC_RHO ?? -0.08);
  const tauModel = opts.tauModel ?? process.env.DC_TAU_MODEL ?? "dixon-coles";
  // baseRate=1 + attackHome=λH + attackAway=λA + 其余=1 ⇒ scoreMatrix 内 lambda=λH, mu=λA(显式 λ 入矩阵)
  const { matrix, lambda, mu } = scoreMatrix({
    baseRate: 1, homeAdv: 1,
    attackHome: lh, defenseAway: 1,
    attackAway: la, defenseHome: 1,
    rho, tauModel
  });
  return {
    source: "poisson-derived-from-lambda",
    expectedGoals: { home: round(lambda), away: round(mu) },
    probabilities: matrixOutcomeProbs(matrix),
    topScores: matrixTopScores(matrix, opts.topN ?? 16),
    matrix
  };
}

// 全矩阵扫描:返回符合指定 wld 方向(3/1/0)、未被排除的最高概率比分。永远有解(无硬编码)。
export function bestScoreFromMatrix(matrix, code, excluded = new Set()) {
  if (!Array.isArray(matrix)) return null;
  let best = null;
  let bestProb = -1;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const label = h > a ? "3" : h === a ? "1" : "0";
      if (label !== code) continue;
      const score = `${h}-${a}`;
      if (excluded.has(score)) continue;
      if (matrix[h][a] > bestProb) { bestProb = matrix[h][a]; best = score; }
    }
  }
  return best;
}

// 从全场比分矩阵算"竞彩让球"真实覆盖概率(line 为整数:让 N 球记 home 得分 + line 与 away 比)。
//   homeAdj = h + line;  homeAdj > a → 主队覆盖, == → 走盘, < → 客队覆盖。
// 返回模型对"让球后"主/平/客的真实概率 + 模型公平让球线(使主队覆盖≈0.5 的整数线)。
export function handicapCoverFromMatrix(matrix, line = 0) {
  if (!Array.isArray(matrix)) return null;
  const cover = (l) => {
    let home = 0, push = 0, away = 0;
    for (let h = 0; h < matrix.length; h++) {
      for (let a = 0; a < matrix[h].length; a++) {
        const adj = h + l;
        if (adj > a) home += matrix[h][a];
        else if (adj === a) push += matrix[h][a];
        else away += matrix[h][a];
      }
    }
    return { home: round(home), push: round(push), away: round(away) };
  };
  const atLine = cover(Number(line) || 0);
  // 模型公平线:在 [-3,3] 整数线里挑让球后主队覆盖概率最接近 0.5 的
  let fairLine = 0, bestGap = Infinity;
  for (let l = -3; l <= 3; l++) {
    const c = cover(l);
    const gap = Math.abs(c.home - 0.5);
    if (gap < bestGap) { bestGap = gap; fairLine = l; }
  }
  return { line: Number(line) || 0, cover: atLine, modelFairLine: fairLine };
}

// ── 让球深度强化(2026-06-01):多档盘口覆盖率阶梯 + 模型公平线(国际赛无市场盘口时尤其有用)──
//   对每条标准盘口线算 让球后 主胜/走盘/客胜 覆盖率;半盘(.5)无走盘。返回阶梯 + 公平线 + 推荐线。
export function handicapLadder(matrix, opts = {}) {
  if (!Array.isArray(matrix)) return null;
  const lines = opts.lines ?? [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
  const coverAt = (l) => {
    let home = 0, push = 0, away = 0;
    for (let h = 0; h < matrix.length; h++)
      for (let a = 0; a < matrix[h].length; a++) {
        const adj = h + l;
        if (adj > a) home += matrix[h][a];
        else if (adj === a) push += matrix[h][a];
        else away += matrix[h][a];
      }
    return { line: l, home: round(home), push: round(push), away: round(away) };
  };
  const ladder = lines.map(coverAt);
  // 模型公平线:含半盘,挑 |主覆盖−0.5| 最小(半盘把走盘并入更接近的一侧后比较)。
  let fairLine = 0, bestGap = Infinity;
  for (const c of ladder) {
    const homeSide = c.home + c.push / 2; // 走盘按半算,逼近真实让球后主队不败强度
    const gap = Math.abs(homeSide - 0.5);
    if (gap < bestGap) { bestGap = gap; fairLine = c.line; }
  }
  return { ladder, modelFairLine: fairLine };
}

// ── 比分深度强化(2026-06-01):总进球区间分布 + 比分集中度(信心)──
export function totalGoalsBands(matrix) {
  if (!Array.isArray(matrix)) return null;
  const bands = { "0": 0, "1": 0, "2": 0, "3": 0, "4+": 0 };
  let top = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) {
      const t = h + a;
      bands[t >= 4 ? "4+" : String(t)] += matrix[h][a];
      if (matrix[h][a] > top) top = matrix[h][a];
    }
  for (const k of Object.keys(bands)) bands[k] = round(bands[k]);
  // 集中度:首选比分概率(越高=比分越好猜);<0.10 散、>0.14 集中(经验阈)。
  const concentration = top >= 0.14 ? "集中" : top >= 0.10 ? "中等" : "分散";
  return { bands, topScoreProb: round(top), concentration };
}

// ── 半全场深度强化(2026-06-01):反转风险(HT≠FT 方向)+ 领先被逆转/落后被翻盘 ──
//   hfDist: {"主胜-主胜":p, "平局-主胜":p, ...} 9 类(HT结果-FT结果)。
export function halfFullDepth(hfDist) {
  if (!hfDist || typeof hfDist !== "object") return null;
  const g = (k) => Number(hfDist[k] ?? 0);
  const sameDir = g("主胜-主胜") + g("平局-平局") + g("客胜-客胜"); // 半场=全场方向一致
  // 领先被逆转:HT 领先方最终输(主胜-客胜 / 客胜-主胜)。
  const leadLost = g("主胜-客胜") + g("客胜-主胜");
  // 落后/平被翻成赢:HT 平→FT 非平,或 HT 落后→FT 赢(逆转向上)。
  const comeback = g("平局-主胜") + g("平局-客胜") + g("主胜-客胜") + g("客胜-主胜");
  // 全场打破僵局率:HT 平 → FT 非平。
  const htDraw = g("平局-主胜") + g("平局-平局") + g("平局-客胜");
  const breakDeadlock = htDraw > 0 ? round((g("平局-主胜") + g("平局-客胜")) / htDraw) : null;
  return {
    sameDirection: round(sameDir),
    reversalRisk: round(leadLost),       // 领先被逆转(让球/稳胆要警惕)
    comeback: round(comeback),           // 任意逆转/打破平局向赢
    htDrawBreakRate: breakDeadlock,      // 上半平时下半分出胜负的概率
  };
}

// 从比分矩阵取某个具体比分("2-1")的真实概率;越界/无效返回 null。
export function scoreProbFromMatrix(matrix, score) {
  if (!Array.isArray(matrix) || typeof score !== "string") return null;
  const m = score.match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const h = Number(m[1]); const a = Number(m[2]);
  if (h >= matrix.length || a >= (matrix[h]?.length ?? 0)) return null;
  return round(matrix[h][a]);
}

// 全场比分分布 top-n(按概率,含主胜/平/客胜各类),用于展示真实分布而非单一 argmax。
export function topScoresWithProb(matrix, n = 5) {
  if (!Array.isArray(matrix)) return [];
  const out = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      out.push({ score: `${h}-${a}`, probability: round(matrix[h][a]), outcome: h > a ? "3" : h === a ? "1" : "0" });
    }
  }
  return out.sort((x, y) => y.probability - x.probability).slice(0, n);
}

// 半全场分布:在指定终场方向(code)内,挑首半场与已选不同的最高概率路径(如主胜场的"平局-主胜"慢热反超)。
export function bestDistinctFirstHalfHalfFull(hfDist, code, chosen) {
  if (!hfDist) return null;
  const finalCh = { "3": "主胜", "1": "平局", "0": "客胜" }[code];
  if (!finalCh) return null;
  const chosenFirst = String(chosen ?? "").split("-")[0]?.trim();
  const cands = Object.entries(hfDist)
    .filter(([k]) => k.split("-")[1]?.trim() === finalCh)
    .filter(([k]) => k.split("-")[0]?.trim() !== chosenFirst)
    .sort((a, b) => b[1] - a[1]);
  return cands.length ? { halfFull: cands[0][0], probability: round(cands[0][1]) } : null;
}

// 半全场全分布 top-n(9 路按概率)。
export function topHalfFull(hfDist, n = 4) {
  if (!hfDist) return [];
  return Object.entries(hfDist)
    .map(([halfFull, probability]) => ({ halfFull, probability: round(probability) }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, n);
}

export function matrixOutcomeProbs(matrix) {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      if (h > a) home += matrix[h][a];
      else if (h === a) draw += matrix[h][a];
      else away += matrix[h][a];
    }
  }
  return { home: round(home), draw: round(draw), away: round(away) };
}

function matrixTopScores(matrix, n) {
  const out = [];
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) out.push({ score: `${h}-${a}`, probability: round(matrix[h][a]) });
  }
  return out.sort((x, y) => y.probability - x.probability).slice(0, n);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export { OUTCOME_BY_CODE };
