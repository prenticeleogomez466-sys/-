/**
 * 比分多路集成 producer(2026-06-01)——各路出比分概率矩阵,折到统一 7×7(0..6,6=6+)。
 * ════════════════════════════════════════════════════════════════════
 * 用户:"比分 10 层融合吸取最有用的。" 诚实:免费数据上比分真正独立的子模型有限,
 * 这里收编 6 路(DC-τ / 双变量泊松 / Markov / 独立泊松 / 经验频率 / 市场λ反推),
 * 前向逐步择优,不硬凑 10 路近重复(违 no-fabrication)。
 */
import { predictFromFitted } from "./dixon-coles-engine.js";
import { markovScoreMatrix } from "./markov-match-simulator.js";

const G = 6; // 0..6,≥6 折入 6
const poiPmf = (k, l) => { if (!(l > 0)) return k === 0 ? 1 : 0; let lf = 0; for (let i = 2; i <= k; i++) lf += Math.log(i); return Math.exp(k * Math.log(l) - l - lf); };

// 任意矩阵折到 (G+1)×(G+1) 并归一
export function fold(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return null;
  const m = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(0));
  let tot = 0;
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < (matrix[h]?.length ?? 0); a++) {
    const p = Number(matrix[h][a]); if (!Number.isFinite(p) || p < 0) continue;
    m[Math.min(h, G)][Math.min(a, G)] += p; tot += p;
  }
  if (tot <= 0) return null;
  for (let h = 0; h <= G; h++) for (let a = 0; a <= G; a++) m[h][a] /= tot;
  return m;
}
function indepMatrix(lh, la) {
  if (!(lh > 0) || !(la > 0)) return null;
  const m = []; let tot = 0;
  for (let h = 0; h <= G; h++) { m[h] = []; for (let a = 0; a <= G; a++) { const p = poiPmf(h, lh) * poiPmf(a, la); m[h][a] = p; tot += p; } }
  for (let h = 0; h <= G; h++) for (let a = 0; a <= G; a++) m[h][a] /= tot;
  return m;
}

export const SCORE_PRODUCER_KEYS = ["dc", "bvp", "markov", "indep", "empirical", "marketLambda"];

export function buildScoreProducers(fits, match, tables = {}) {
  const { home, away, league } = match;
  const out = {};
  const dc = fits.dc ? predictFromFitted(fits.dc, { homeTeam: home, awayTeam: away }) : null;
  out.dc = dc?.matrix ? fold(dc.matrix) : null;
  out.bvp = (() => { try { return fold(fits.bvp?.predict?.(home, away)?.matrix); } catch { return null; } })();
  out.markov = dc?.expectedGoals ? (() => { try { return fold(markovScoreMatrix(dc.expectedGoals.home, dc.expectedGoals.away)); } catch { return null; } })() : null;
  out.indep = dc?.expectedGoals ? indepMatrix(dc.expectedGoals.home, dc.expectedGoals.away) : null;
  out.empirical = tables.scoreFreq?.get(league) ?? tables.scoreFreq?.get("__global__") ?? null;
  // 市场 λ 反推:用历史大小球+亚盘隐含的总进球/净胜推 λ(冷门场常缺→null)
  out.marketLambda = (() => {
    const mh = match.marketHistorical; if (!mh) return null;
    const line = Number(mh.asian?.line); const ou = match.ouLambda;
    if (!Number.isFinite(ou) || ou <= 0) return null;
    const lh = Math.max(0.2, (ou - (Number.isFinite(line) ? line : 0)) / 2);
    const la = Math.max(0.2, (ou + (Number.isFinite(line) ? line : 0)) / 2);
    return indepMatrix(lh, la);
  })();
  return out;
}

/** 训练集 league → 比分频率矩阵(拉普拉斯平滑)+ 全局兜底。leak-safe。 */
export function buildScoreFreqTable(trainMatches) {
  const byLeague = new Map(); const global = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(1)); // laplace
  for (const m of trainMatches) {
    if (m.homeGoals == null || m.awayGoals == null) continue;
    const h = Math.min(m.homeGoals, G), a = Math.min(m.awayGoals, G);
    global[h][a]++;
    const lg = m.league ?? "?";
    let mat = byLeague.get(lg); if (!mat) { mat = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(1)); byLeague.set(lg, mat); }
    mat[h][a]++;
  }
  const normMat = (mat, n) => { const t = mat.flat().reduce((s, v) => s + v, 0); return mat.map((r) => r.map((v) => v / t)); };
  const scoreFreq = new Map();
  for (const [lg, mat] of byLeague) { const n = mat.flat().reduce((s, v) => s + v, 0) - (G + 1) * (G + 1); if (n >= 200) scoreFreq.set(lg, normMat(mat)); }
  scoreFreq.set("__global__", normMat(global));
  return { scoreFreq };
}
