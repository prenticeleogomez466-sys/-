/**
 * 比分多路集成 leak-safe 回测 + 前向逐步学权重(2026-06-01)。
 * train60/val20/test20。前向逐步最小化 val exact-score logloss(吸取最有用的),
 * test 验 exact-score 命中 + logloss vs 最强单模型。诚实报实际独立路数与裁决。
 * 用法:node scripts/backtest-ensemble-score.mjs [--apply]
 */
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches } from "../src/dixon-coles-engine.js";
import { fitBivariatePoisson } from "../src/bivariate-poisson.js";
import { buildScoreProducers, buildScoreFreqTable, SCORE_PRODUCER_KEYS } from "../src/score-ensemble-producers.js";
import { getExportDir } from "../src/paths.js";

const APPLY = process.argv.includes("--apply");
const G = 6, EPS = 1e-12;
const invLambdaFromOver = (pOver) => { // 二分:P(total>2.5)=pOver → λtotal
  if (!(pOver > 0.02 && pOver < 0.98)) return null;
  let lo = 0.5, hi = 6;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; const p0 = Math.exp(-m); const po = 1 - p0 - p0 * m - p0 * m * m / 2; if (po < pOver) lo = m; else hi = m; }
  return (lo + hi) / 2;
};
const fuseMat = (prod, weights) => {
  const m = Array.from({ length: G + 1 }, () => new Array(G + 1).fill(0)); let tw = 0;
  for (const k of SCORE_PRODUCER_KEYS) { const M = prod[k], w = weights[k] ?? 0; if (!M || w <= 0) continue; tw += w; for (let h = 0; h <= G; h++) for (let a = 0; a <= G; a++) m[h][a] += w * M[h][a]; }
  if (tw <= 0) return null;
  for (let h = 0; h <= G; h++) for (let a = 0; a <= G; a++) m[h][a] /= tw;
  return m;
};
const loglossOf = (rows, weights) => { let s = 0, n = 0; for (const r of rows) { const m = fuseMat(r.prod, weights); if (!m) continue; s += -Math.log(Math.max(m[r.h][r.a], EPS)); n++; } return n ? s / n : Infinity; };
const topHit = (rows, weights) => { let h = 0, n = 0; for (const r of rows) { const m = fuseMat(r.prod, weights); if (!m) continue; let bi = 0, bj = 0, bv = -1; for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) if (m[i][j] > bv) { bv = m[i][j]; bi = i; bj = j; } if (bi === r.h && bj === r.a) h++; n++; } return n ? h / n : 0; };

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.awayGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const c1 = Math.floor(all.length * 0.6), c2 = Math.floor(all.length * 0.8);
const train = all.slice(0, c1), val = all.slice(c1, c2), test = all.slice(c2);
console.log(`store ${all.length} | train ${train.length} / val ${val.length} / test ${test.length}`);
const fits = { dc: fitFromMatches(train), bvp: fitBivariatePoisson(train) };
const tables = buildScoreFreqTable(train);

const prep = (rows) => rows.map((m) => {
  const ouL = m.marketHistorical?.overProb != null ? invLambdaFromOver(m.marketHistorical.overProb) : null;
  return { h: Math.min(m.homeGoals, G), a: Math.min(m.awayGoals, G), prod: buildScoreProducers(fits, { home: m.home, away: m.away, league: m.league, marketHistorical: m.marketHistorical, ouLambda: ouL }, tables) };
});
const valR = prep(val), testR = prep(test);

// 逐路 val logloss
const perVal = {};
for (const k of SCORE_PRODUCER_KEYS) { let s = 0, n = 0; for (const r of valR) if (r.prod[k]) { s += -Math.log(Math.max(r.prod[k][r.h][r.a], EPS)); n++; } perVal[k] = { ll: n ? s / n : Infinity, cov: n / valR.length }; }
console.log("\n逐路 val(exact-score logloss):");
for (const [k, v] of Object.entries(perVal).sort((a, b) => a[1].ll - b[1].ll)) console.log(`  ${k.padEnd(13)} cov ${(v.cov * 100).toFixed(0).padStart(3)}%  LL ${Number.isFinite(v.ll) ? v.ll.toFixed(4) : "(无)"}`);

const elig = SCORE_PRODUCER_KEYS.filter((k) => Number.isFinite(perVal[k].ll) && perVal[k].cov >= 0.5);
let w = {}; const best0 = elig.sort((a, b) => perVal[a].ll - perVal[b].ll)[0]; w[best0] = 1;
let cur = loglossOf(valR, w); const trail = [`${best0}(基)`]; const ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.4];
for (let it = 0; it < 6; it++) {
  let bg = 0, bk = null, ba = 0;
  for (const k of elig) for (const al of ALPHAS) { const ww = {}; for (const m of SCORE_PRODUCER_KEYS) ww[m] = (w[m] ?? 0) * (1 - al); ww[k] = (ww[k] ?? 0) + al; const r = loglossOf(valR, ww); if (cur - r > bg + 1e-6) { bg = cur - r; bk = k; ba = al; } }
  if (!bk || bg < 0.0005) break;
  for (const m of SCORE_PRODUCER_KEYS) w[m] = (w[m] ?? 0) * (1 - ba); w[bk] = (w[bk] ?? 0) + ba; cur = loglossOf(valR, w); trail.push(`+${bk}×${ba}`);
}
let ws = 0; for (const k of SCORE_PRODUCER_KEYS) { if ((w[k] ?? 0) < 0.01) delete w[k]; else ws += w[k]; } for (const k of Object.keys(w)) w[k] = Math.round(w[k] / ws * 1000) / 1000;
console.log("\n前向逐步:", trail.join(" → "));
console.log("权重(吸取最有用的):", Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" / "));

const bestKey = elig.sort((a, b) => perVal[a].ll - perVal[b].ll)[0];
const bestSingleW = { [bestKey]: 1 };
console.log("\ntest 评估:");
console.log(`  最强单模型(${bestKey})  LL ${loglossOf(testR, bestSingleW).toFixed(4)} | exact命中 ${(topHit(testR, bestSingleW) * 100).toFixed(2)}%`);
console.log(`  等权集成              LL ${loglossOf(testR, Object.fromEntries(elig.map((k) => [k, 1]))).toFixed(4)} | exact命中 ${(topHit(testR, Object.fromEntries(elig.map((k) => [k, 1]))) * 100).toFixed(2)}%`);
const llLearn = loglossOf(testR, w), hitLearn = topHit(testR, w), llBest = loglossOf(testR, bestSingleW);
console.log(`  学权集成              LL ${llLearn.toFixed(4)} | exact命中 ${(hitLearn * 100).toFixed(2)}%`);
console.log(`\n诚实裁决(全样本):学权 vs 最强单模型 LL Δ${(llBest - llLearn).toFixed(4)} ${llLearn < llBest - 0.001 ? "✓集成更优" : "≈持平(有市场→marketLambda 最优,与生产 O/U λ 校准一致)"}`);

// 无盘口段:模型融合的真实落点(marketLambda 缺席)
const nmKeys = SCORE_PRODUCER_KEYS.filter((k) => k !== "marketLambda");
const valNM = valR.filter((r) => !r.prod.marketLambda), testNM = testR.filter((r) => !r.prod.marketLambda);
const perNM = {}; for (const k of nmKeys) { let s = 0, n = 0; for (const r of valNM) if (r.prod[k]) { s += -Math.log(Math.max(r.prod[k][r.h][r.a], EPS)); n++; } perNM[k] = { ll: n ? s / n : Infinity, cov: n / valNM.length }; }
const eligNM = nmKeys.filter((k) => Number.isFinite(perNM[k].ll) && perNM[k].cov >= 0.5);
let wNM = {}; const b0 = eligNM.sort((a, b) => perNM[a].ll - perNM[b].ll)[0]; wNM[b0] = 1; let curNM = loglossOf(valNM, wNM); const trNM = [`${b0}(基)`];
for (let it = 0; it < 6; it++) { let bg = 0, bk = null, ba = 0; for (const k of eligNM) for (const al of ALPHAS) { const ww = {}; for (const m of nmKeys) ww[m] = (wNM[m] ?? 0) * (1 - al); ww[k] = (ww[k] ?? 0) + al; const r = loglossOf(valNM, ww); if (curNM - r > bg + 1e-6) { bg = curNM - r; bk = k; ba = al; } } if (!bk || bg < 0.0005) break; for (const m of nmKeys) wNM[m] = (wNM[m] ?? 0) * (1 - ba); wNM[bk] = (wNM[bk] ?? 0) + ba; curNM = loglossOf(valNM, wNM); trNM.push(`+${bk}×${ba}`); }
let wsNM = 0; for (const k of nmKeys) { if ((wNM[k] ?? 0) < 0.01) delete wNM[k]; else wsNM += wNM[k]; } for (const k of Object.keys(wNM)) wNM[k] = Math.round(wNM[k] / wsNM * 1000) / 1000;
const bNMkey = eligNM.sort((a, b) => perNM[a].ll - perNM[b].ll)[0]; const bNMw = { [bNMkey]: 1 };
const llNMlearn = loglossOf(testNM, wNM), llNMbest = loglossOf(testNM, bNMw);
console.log(`\n── 无盘口段(冷门场):test ${testNM.length} ──`);
console.log("  选择:", trNM.join(" → "), "| 权重:", Object.entries(wNM).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join("/"));
console.log(`  最强单模型(${bNMkey}) LL ${llNMbest.toFixed(4)} 命中 ${(topHit(testNM, bNMw) * 100).toFixed(2)}% | 学权集成 LL ${llNMlearn.toFixed(4)} 命中 ${(topHit(testNM, wNM) * 100).toFixed(2)}%`);
console.log(`  → 无盘口段 学权 vs 最强单模型 LL Δ${(llNMbest - llNMlearn).toFixed(4)} ${llNMlearn < llNMbest - 0.001 ? "✓集成真增益(融合落点)" : "≈持平"}`);
console.log(`\n独立路数:${elig.length}/${SCORE_PRODUCER_KEYS.length} 有效(免费数据无 10 路独立比分模型,不硬凑)`);

if (APPLY) {
  const profile = { schema: "ensemble-weights-score", generatedAt: new Date().toISOString(), usable: true, eligible: elig, weights: w, selectionTrail: trail, perProducerValLogloss: Object.fromEntries(Object.entries(perVal).map(([k, v]) => [k, Number.isFinite(v.ll) ? Math.round(v.ll * 1e4) / 1e4 : null])), testArms: { bestSingle: { method: bestKey, ll: Math.round(llBest * 1e4) / 1e4 }, learned: Math.round(llLearn * 1e4) / 1e4, learnedHit: Math.round(hitLearn * 1e4) / 1e4 },
    noMarket: { weights: wNM, bestSingle: bNMkey, testLL: { bestSingle: Math.round(llNMbest * 1e4) / 1e4, learned: Math.round(llNMlearn * 1e4) / 1e4 }, gain: Math.round((llNMbest - llNMlearn) * 1e4) / 1e4 } };
  const out = join(getExportDir(), "ensemble-weights-score-profile.json");
  if (existsSync(out)) copyFileSync(out, out + ".bak");
  writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", "utf8");
  console.log(`\n已写 ${out}`);
} else console.log("\n(加 --apply 落 profile)");
