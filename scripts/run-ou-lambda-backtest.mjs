/**
 * 用大小球(O/U 2.5)赔率校准 λ 总量 · 决策回测(2026-05-31)
 * ─────────────────────────────────────────────────────────────
 * 遵 feedback-hitrate-closed-loop / feedback-no-fabrication:赢了才接生产。
 *
 * 假设:odds-only 场 λ 总量现行只由「联赛历史均进球」给(estimateGoalLambdas 的 experience 路径),
 *   没用上大小球盘口。大小球 P(over2.5) 直接含市场对**进球总量**的预期 —— 把它解成 λ_total,
 *   理应比"联赛均值"更贴近本场,从而同时改善 比分 / 半全场 / 大小球。
 *
 * 两臂(同一 edge split + 同一 DC-τ 矩阵,只换 λ_total 来源):
 *   A 现行基线:λ_total = 该联赛 train 历史均进球(模拟 experience 路径)
 *   B O/U校准: λ_total = 由收盘 P(over2.5) 泊松数值反解(market 进球总量预期)
 * 指标:正确比分命中% + 实际比分 LogLoss;半全场 9类 LogLoss/Brier;大小球2.5 校准(Brier)。
 *
 * leak-safe:λ_total_A 用 train(测试期之前)联赛均值;B 用本场盘口(盘口是赛前已知、非未来信息)。
 * 用法:node scripts/run-ou-lambda-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { buildDerivedScoreModel } from "../src/derived-score-model.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const sign = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
const CLASSES = ["主-主", "主-平", "主-客", "平-主", "平-平", "平-客", "客-主", "客-平", "客-客"];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const monthKey = (d) => String(d).slice(0, 7);

// P(总进球>2.5)= 1 - e^-λ(1+λ+λ²/2);单调,二分反解 λ_total。
function lambdaFromOver(p) {
  const pOver = (lam) => 1 - Math.exp(-lam) * (1 + lam + lam * lam / 2);
  let lo = 0.3, hi = 6.5;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (pOver(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const pOverFromLambda = (lam) => 1 - Math.exp(-lam) * (1 + lam + lam * lam / 2);
// 由 wld 隐含概率把 λ_total 拆成主客(复刻 estimateGoalLambdas 的 edge split 口径)
function splitLambda(total, probs) {
  const edge = (probs?.home ?? 0.4) - (probs?.away ?? 0.33);
  const homeShare = clamp(0.5 + edge * 0.75, 0.25, 0.75);
  return { lh: clamp(total * homeShare, 0.15, 5), la: clamp(total * (1 - homeShare), 0.15, 5) };
}
function scoreArgmax(matrix) {
  let best = "0-0", bp = -1;
  for (let h = 0; h < matrix.length; h++) for (let a = 0; a < matrix[h].length; a++) if (matrix[h][a] > bp) { bp = matrix[h][a]; best = `${h}-${a}`; }
  return best;
}
const cellProb = (m, h, a) => (h < m.length && a < (m[h]?.length ?? 0) ? m[h][a] : 0);

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && Number.isFinite(m.halfHome) && Number.isFinite(m.halfAway) && m.date && m.odds);
const withOU = all.filter((m) => Number.isFinite(m.overProb ?? m.overProbClose));
console.log(`big-5 有半场+赔率 ${all.length} 场;其中有大小球盘口 ${withOU.length} 场(${(withOU.length / all.length * 100).toFixed(1)}%)`);

const months = [...new Set(all.map((m) => monthKey(m.date)))].sort();
const testStart = months[Math.floor(months.length * 0.5)];
// 联赛 train 均进球(基线 λ_total_A)
const leagueAvg = {};
{
  const acc = {};
  for (const m of all) { if (monthKey(m.date) >= testStart) continue; (acc[m.league] ??= { g: 0, n: 0 }); acc[m.league].g += m.homeGoals + m.awayGoals; acc[m.league].n++; }
  for (const lg in acc) leagueAvg[lg] = acc[lg].g / acc[lg].n;
}
console.log(`测试期从 ${testStart};联赛均进球基线:`, Object.fromEntries(Object.entries(leagueAvg).map(([k, v]) => [k, v.toFixed(2)])), "\n");

const acc = { A_hit: 0, B_hit: 0, A_ll: 0, B_ll: 0, hfA_ll: 0, hfB_ll: 0, hfA_br: 0, hfB_br: 0, ouA_br: 0, ouB_br: 0, n: 0 };
for (const m of all) {
  if (monthKey(m.date) < testStart) continue;
  const over = m.overProbClose ?? m.overProb;
  if (!Number.isFinite(over) || over <= 0.02 || over >= 0.98) continue; // 只在有真实盘口的场比(公平对比)
  const totalA = clamp(leagueAvg[m.league] ?? 2.6, 1.4, 4.2);
  const totalB = clamp(lambdaFromOver(over), 1.4, 4.6);
  const A = splitLambda(totalA, m.odds), B = splitLambda(totalB, m.odds);
  const mA = buildDerivedScoreModel(A.lh, A.la)?.matrix, mB = buildDerivedScoreModel(B.lh, B.la)?.matrix;
  if (!mA || !mB) continue;
  const realScore = `${m.homeGoals}-${m.awayGoals}`;
  if (scoreArgmax(mA) === realScore) acc.A_hit++;
  if (scoreArgmax(mB) === realScore) acc.B_hit++;
  acc.A_ll += -Math.log(Math.max(EPS, cellProb(mA, m.homeGoals, m.awayGoals)));
  acc.B_ll += -Math.log(Math.max(EPS, cellProb(mB, m.homeGoals, m.awayGoals)));
  // 半全场(halfFullProbsFromLambdas 的 key 是 主胜/平局/客胜 全称)
  const LAB = { "主": "主胜", "平": "平局", "客": "客胜" };
  const y = `${LAB[sign(m.halfHome, m.halfAway)]}-${LAB[sign(m.homeGoals, m.awayGoals)]}`;
  const pA = halfFullProbsFromLambdas(A.lh, A.la), pB = halfFullProbsFromLambdas(B.lh, B.la);
  acc.hfA_ll += -Math.log(Math.max(EPS, pA[y])); acc.hfB_ll += -Math.log(Math.max(EPS, pB[y]));
  for (const c of Object.keys(pA)) { const t = c === y ? 1 : 0; acc.hfA_br += (pA[c] - t) ** 2; acc.hfB_br += (pB[c] - t) ** 2; }
  // 大小球2.5 校准(sanity:B 应明显更准)
  const realOver = (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0;
  acc.ouA_br += (pOverFromLambda(totalA) - realOver) ** 2; acc.ouB_br += (pOverFromLambda(totalB) - realOver) ** 2;
  acc.n++;
}

const n = acc.n;
console.log(`样本外(有大小球盘口)${n} 场\n`);
console.log("【比分】正确比分命中% / 实际比分 LogLoss(越低越好):");
console.log(`  A 联赛均值λ:   命中 ${(acc.A_hit / n * 100).toFixed(2)}%  LogLoss ${(acc.A_ll / n).toFixed(4)}`);
console.log(`  B O/U校准λ:    命中 ${(acc.B_hit / n * 100).toFixed(2)}%  LogLoss ${(acc.B_ll / n).toFixed(4)}`);
console.log("【半全场】9类 LogLoss / Brier(越低越好):");
console.log(`  A 联赛均值λ:   LogLoss ${(acc.hfA_ll / n).toFixed(4)}  Brier ${(acc.hfA_br / n).toFixed(4)}`);
console.log(`  B O/U校准λ:    LogLoss ${(acc.hfB_ll / n).toFixed(4)}  Brier ${(acc.hfB_br / n).toFixed(4)}`);
console.log("【大小球2.5校准】Brier(sanity,越低越好):");
console.log(`  A 联赛均值:    Brier ${(acc.ouA_br / n).toFixed(4)}`);
console.log(`  B O/U校准:     Brier ${(acc.ouB_br / n).toFixed(4)}`);
const scoreWin = acc.B_ll < acc.A_ll, hfWin = acc.hfB_ll < acc.hfA_ll;
console.log(`\n裁决:比分 ${scoreWin ? "B更优✅" : "B不优❌"} | 半全场 ${hfWin ? "B更优✅" : "B不优❌"} | 大小球 ${acc.ouB_br < acc.ouA_br ? "B更优✅" : "B不优❌"}`);
console.log(`→ ${scoreWin && hfWin ? "O/U校准λ 双赢,接生产(有盘口时优先)" : scoreWin || hfWin ? "部分优,需权衡" : "不优,保留现行联赛均值λ"}`);
