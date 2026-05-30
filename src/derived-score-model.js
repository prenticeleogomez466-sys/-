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
