/**
 * 比分 + 半全场模型升级 · 决策回测(2026-05-31)
 * ─────────────────────────────────────────────────────────────
 * 遵 feedback-hitrate-closed-loop / feedback-no-fabrication:新模型必须样本外赢过现行才替换。
 *
 * 比分臂:
 *   A = DC-τ(现行 buildDerivedScoreModel,Dixon-Coles 只修4个低分格)
 *   B = 双变量泊松 BVP(Karlis-Ntzoufras,共同分量 λ3 全盘建相关性)
 * 半全场臂(9类 HT符号-FT符号):
 *   A = 现行 halfFullProbsFromLambdas(λH,λA,0.46 固定 + 独立 plain Poisson 半场)
 *   B = DC-τ 半场卷积(两半各 DC-τ 矩阵,halfShare 拟合)
 *   C = BVP 半场卷积(两半各 BVP 矩阵,halfShare 拟合)
 *
 * leak-safe:逐月块用「严格早于该月」的历史拟合 BVP(取 λH/λA/λ3);halfShare 用 train 经验首半场进球占比。
 * 指标:比分=正确比分命中% + 实际比分 LogLoss;半全场=9类 LogLoss + multiclass Brier。
 *
 * 用法:node scripts/run-bvp-score-halffull-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitBivariatePoisson, bivariatePoissonMatrix } from "../src/bivariate-poisson.js";
import { scoreMatrix } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const MAXG = 6;          // 全场比分矩阵上限
const HMAX = 5;          // 半场矩阵上限
const RHO = -0.08;
const sign = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
const CLASSES = ["主-主", "主-平", "主-客", "平-主", "平-平", "平-客", "客-主", "客-平", "客-客"];

// ---- 矩阵构造 ----
function dcMatrix(lh, la, maxGoals = MAXG) {
  const { matrix } = scoreMatrix({ baseRate: 1, homeAdv: 1, attackHome: clamp(lh, 0.05, 6), defenseAway: 1, attackAway: clamp(la, 0.05, 6), defenseHome: 1, rho: RHO, tauModel: "dixon-coles", maxGoals });
  return matrix;
}
function bvpMatrix(lh, la, l3, maxGoals = MAXG) {
  const lambda1 = Math.max(0.01, lh - l3), lambda2 = Math.max(0.01, la - l3);
  return bivariatePoissonMatrix(lambda1, lambda2, Math.max(0, l3), maxGoals);
}

// ---- 比分指标 ----
function scoreArgmax(matrix) {
  let best = "0-0", bp = -1;
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) if (matrix[h][a] > bp) { bp = matrix[h][a]; best = `${h}-${a}`; }
  return best;
}
const cellProb = (matrix, h, a) => (h < matrix.length && a < (matrix[h]?.length ?? 0) ? matrix[h][a] : 0);

// ---- 半全场:两半矩阵卷积 → 9类概率 ----
function halfFullConv(buildHalf, lh, la, s, l3) {
  const M1 = buildHalf(lh * s, la * s, l3 * s, HMAX);
  const M2 = buildHalf(lh * (1 - s), la * (1 - s), l3 * (1 - s), HMAX);
  const probs = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (let h1 = 0; h1 <= HMAX; h1++) for (let a1 = 0; a1 <= HMAX; a1++) {
    const p1 = M1[h1][a1]; if (!p1) continue;
    const half = sign(h1, a1);
    for (let h2 = 0; h2 <= HMAX; h2++) for (let a2 = 0; a2 <= HMAX; a2++) {
      const p2 = M2[h2][a2]; if (!p2) continue;
      probs[`${half}-${sign(h1 + h2, a1 + a2)}`] += p1 * p2;
    }
  }
  const tot = Object.values(probs).reduce((x, y) => x + y, 0) || 1;
  for (const c of CLASSES) probs[c] /= tot;
  return probs;
}
// 现行半全场(独立 plain Poisson + 固定 0.46)—— 复刻 prediction-engine.halfFullProbsFromLambdas
function halfFullCurrent(lh, la, halfRatio = 0.46) {
  const pd = (lam, mx) => { const e = Math.exp(-lam); const o = []; let t = 1; for (let k = 0; k <= mx; k++) { o[k] = k === 0 ? e : (t *= lam / k, e * t); } return o; };
  const lH1 = lh * halfRatio, lA1 = la * halfRatio, lH2 = lh - lH1, lA2 = la - lA1;
  const dH1 = pd(lH1, HMAX), dA1 = pd(lA1, HMAX), dH2 = pd(lH2, HMAX), dA2 = pd(lA2, HMAX);
  const probs = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (let h1 = 0; h1 <= HMAX; h1++) for (let a1 = 0; a1 <= HMAX; a1++) {
    const p1 = dH1[h1] * dA1[a1]; const half = sign(h1, a1);
    for (let h2 = 0; h2 <= HMAX; h2++) for (let a2 = 0; a2 <= HMAX; a2++) {
      probs[`${half}-${sign(h1 + h2, a1 + a2)}`] += p1 * dH2[h2] * dA2[a2];
    }
  }
  const tot = Object.values(probs).reduce((x, y) => x + y, 0) || 1;
  for (const c of CLASSES) probs[c] /= tot;
  return probs;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function monthKey(d) { return String(d).slice(0, 7); }

// ============ 主流程 ============
const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.home && m.away && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && Number.isFinite(m.halfHome) && Number.isFinite(m.halfAway) && m.date);
console.log(`big-5 有半场比分 ${all.length} 场`);

const months = [...new Set(all.map((m) => monthKey(m.date)))].sort();
const testStart = months[Math.floor(months.length * 0.65)];
const trainAll = all.filter((m) => monthKey(m.date) < testStart);
// halfShare = train 首半场进球 / 全场进球
const fhGoals = trainAll.reduce((s, m) => s + m.halfHome + m.halfAway, 0);
const ftGoals = trainAll.reduce((s, m) => s + m.homeGoals + m.awayGoals, 0);
const halfShare = clamp(fhGoals / (ftGoals || 1), 0.3, 0.6);
// 全局 λ3(method-of-moments cov,train)
const mH = trainAll.reduce((s, m) => s + m.homeGoals, 0) / trainAll.length;
const mA = trainAll.reduce((s, m) => s + m.awayGoals, 0) / trainAll.length;
const cov = trainAll.reduce((s, m) => s + (m.homeGoals - mH) * (m.awayGoals - mA), 0) / trainAll.length;
console.log(`训练期 ${trainAll.length} 场 → halfShare=${halfShare.toFixed(4)}(现行硬编码 0.46), 全局cov(home,away)=${cov.toFixed(4)}`);
console.log(`测试期 从 ${testStart} 起\n逐月 leak-safe 重拟合 BVP...\n`);

// 条件分布模型:用 train(全在测试期之前,leak-safe)+ train-fit 的 λ 学按档 9 类频率
const trainFit = fitBivariatePoisson(trainAll, { homeAdvantage: 1.24, iterations: 50 });
const condLambda = (m) => {
  if (!trainFit?.ok) return null;
  const p = trainFit.predict(m.home, m.away);
  if (p.coldStart) return null;
  return { lh: clamp(p.expectedGoals.home, 0.15, 5), la: clamp(p.expectedGoals.away, 0.15, 5) };
};
const condModel = learnConditional(trainAll, condLambda);

// ---- 臂 D:数据驱动条件分布(按 λ 档直接学历史 9 类频率,不假设泊松/独立)----
//   bucket = 总进球档(低<2.4/中/高>3.0)× 主客倾向档(主强/均势/客强,按 λH-λA)
function lambdaBucket(lh, la) {
  const tot = lh + la, diff = lh - la;
  const t = tot < 2.4 ? "L" : tot > 3.0 ? "H" : "M";
  const d = diff > 0.5 ? "Hf" : diff < -0.5 ? "Af" : "B";
  return `${t}-${d}`;
}
function learnConditional(matches, fitForLambda) {
  const buckets = new Map();
  for (const m of matches) {
    const p = fitForLambda(m);
    if (!p) continue;
    const b = lambdaBucket(p.lh, p.la);
    if (!buckets.has(b)) buckets.set(b, Object.fromEntries(CLASSES.map((c) => [c, 1]))); // 拉普拉斯平滑+1
    const dist = buckets.get(b);
    dist[`${sign(m.halfHome, m.halfAway)}-${sign(m.homeGoals, m.awayGoals)}`] += 1;
  }
  for (const [, dist] of buckets) { const t = Object.values(dist).reduce((x, y) => x + y, 0); for (const c of CLASSES) dist[c] /= t; }
  // 全局兜底
  const global = Object.fromEntries(CLASSES.map((c) => [c, 1]));
  for (const m of matches) global[`${sign(m.halfHome, m.halfAway)}-${sign(m.homeGoals, m.awayGoals)}`] += 1;
  const gt = Object.values(global).reduce((x, y) => x + y, 0); for (const c of CLASSES) global[c] /= gt;
  return { buckets, global };
}

let fit = null, fitMonth = null;
const acc = {
  score: { A_hit: 0, B_hit: 0, A_ll: 0, B_ll: 0 },
  hf: { A_ll: 0, B_ll: 0, C_ll: 0, D_ll: 0, A_br: 0, B_br: 0, C_br: 0, D_br: 0 },
  n: 0
};
for (const m of all) {
  const mk = monthKey(m.date);
  if (mk < testStart) continue;
  if (mk !== fitMonth) {
    const hist = all.filter((x) => x.date < `${mk}-01`);
    fit = fitBivariatePoisson(hist, { homeAdvantage: 1.24, iterations: 50 });
    fitMonth = mk;
  }
  if (!fit?.ok) continue;
  const pred = fit.predict(m.home, m.away);
  if (pred.coldStart) continue; // 两队都需在训练集出现过(公平)
  const lh = clamp(pred.expectedGoals.home, 0.15, 5), la = clamp(pred.expectedGoals.away, 0.15, 5);
  const l3 = clamp(fit.lambda3 ?? 0, 0, Math.min(lh, la) - 0.05);

  // ---- 比分 ----
  const mA_dc = dcMatrix(lh, la);
  const mB_bvp = bvpMatrix(lh, la, l3);
  const realScore = `${m.homeGoals}-${m.awayGoals}`;
  if (scoreArgmax(mA_dc) === realScore) acc.score.A_hit++;
  if (scoreArgmax(mB_bvp) === realScore) acc.score.B_hit++;
  acc.score.A_ll += -Math.log(Math.max(EPS, cellProb(mA_dc, m.homeGoals, m.awayGoals)));
  acc.score.B_ll += -Math.log(Math.max(EPS, cellProb(mB_bvp, m.homeGoals, m.awayGoals)));

  // ---- 半全场 ----
  const y = `${sign(m.halfHome, m.halfAway)}-${sign(m.homeGoals, m.awayGoals)}`;
  const pA = halfFullCurrent(lh, la);
  const pB = halfFullConv((a, b, _c, mx) => dcMatrix(a, b, mx), lh, la, halfShare, 0);
  const pC = halfFullConv((a, b, c, mx) => bvpMatrix(a, b, c, mx), lh, la, halfShare, l3);
  const pD = condModel.buckets.get(lambdaBucket(lh, la)) ?? condModel.global;
  acc.hf.A_ll += -Math.log(Math.max(EPS, pA[y])); acc.hf.B_ll += -Math.log(Math.max(EPS, pB[y])); acc.hf.C_ll += -Math.log(Math.max(EPS, pC[y])); acc.hf.D_ll += -Math.log(Math.max(EPS, pD[y]));
  for (const c of CLASSES) { const t = c === y ? 1 : 0; acc.hf.A_br += (pA[c] - t) ** 2; acc.hf.B_br += (pB[c] - t) ** 2; acc.hf.C_br += (pC[c] - t) ** 2; acc.hf.D_br += (pD[c] - t) ** 2; }
  acc.n++;
}

const n = acc.n;
console.log(`样本外 ${n} 场(两队均在训练集中)\n`);
console.log("【比分】正确比分命中% / 实际比分 LogLoss(越低越好):");
console.log(`  A 现行 DC-τ:      命中 ${(acc.score.A_hit / n * 100).toFixed(2)}%  LogLoss ${(acc.score.A_ll / n).toFixed(4)}`);
console.log(`  B 双变量泊松BVP:  命中 ${(acc.score.B_hit / n * 100).toFixed(2)}%  LogLoss ${(acc.score.B_ll / n).toFixed(4)}`);
const scoreWin = (acc.score.B_hit > acc.score.A_hit) && (acc.score.B_ll < acc.score.A_ll);
console.log(`  → 比分:BVP ${scoreWin ? "命中+LogLoss双赢 ✅ 替换" : (acc.score.B_hit >= acc.score.A_hit || acc.score.B_ll < acc.score.A_ll ? "部分优(需权衡)" : "不及DC-τ ❌ 保留现行")}\n`);

console.log("【半全场】9类 LogLoss / multiclass Brier(越低越好):");
console.log(`  A 现行(0.46+独立):  LogLoss ${(acc.hf.A_ll / n).toFixed(4)}  Brier ${(acc.hf.A_br / n).toFixed(4)}`);
console.log(`  B DC-τ半场卷积:      LogLoss ${(acc.hf.B_ll / n).toFixed(4)}  Brier ${(acc.hf.B_br / n).toFixed(4)}`);
console.log(`  C BVP半场卷积:       LogLoss ${(acc.hf.C_ll / n).toFixed(4)}  Brier ${(acc.hf.C_br / n).toFixed(4)}`);
console.log(`  D 数据驱动条件分布:  LogLoss ${(acc.hf.D_ll / n).toFixed(4)}  Brier ${(acc.hf.D_br / n).toFixed(4)}`);
const arms = [["A 现行", acc.hf.A_ll], ["B DC-τ卷积", acc.hf.B_ll], ["C BVP卷积", acc.hf.C_ll], ["D 条件分布", acc.hf.D_ll]].sort((x, y2) => x[1] - y2[1]);
console.log(`  → 半全场最优(LogLoss):${arms[0][0]}\n`);
console.log("诚实裁决:仅当新臂样本外严格更优才替换生产;否则保留现行并如实记录(不造假改善)。");
