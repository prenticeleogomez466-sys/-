/**
 * 胜负平 10 路集成 leak-safe 回测 + 前向逐步凸组合学权重(2026-06-01)。
 * ════════════════════════════════════════════════════════════════════
 * 三分时间切分(防泄漏):train 60% 拟合模型 / val 20% 学融合权重 / test 20% 评估。
 * "吸取最有用的" = 前向逐步:从 val 上最强单路起,每轮只纳入能再降 val RPS 的路+混合比,
 *   没用/冗余的路自然进不来(权重 0)。再用冻结权重在 test 上对比 最强单路/等权/市场。
 * 诚实:融合超不过市场就如实说(公开数据上限)。
 * 用法:node scripts/backtest-ensemble-1x2.mjs [--apply]
 */
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches } from "../src/dixon-coles-engine.js";
import { fitBivariatePoisson } from "../src/bivariate-poisson.js";
import { fitPiRatings } from "../src/pi-ratings.js";
import { fitMasseyRatings } from "../src/massey-ratings.js";
import { fitColleyRatings } from "../src/colley-ratings.js";
import { buildOneX2Producers, buildEmpiricalTables, PRODUCER_KEYS } from "../src/ensemble-producers.js";
import { getExportDir } from "../src/paths.js";

const APPLY = process.argv.includes("--apply");
const rps = (p, y) => {
  const c1 = p.home - (y === "home" ? 1 : 0);
  const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0);
  return 0.5 * (c1 * c1 + c2 * c2);
};
const outcomeOf = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away");
const top = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const marketProbOf = (m) => m.marketHistorical?.openProbs ?? null;

// 按权重向量融合一场的可用 producer(权重在可用集上重归一)
function fuse(prodMap, weights) {
  let tw = 0; const s = { home: 0, draw: 0, away: 0 };
  for (const k of PRODUCER_KEYS) {
    const p = prodMap[k], w = weights[k] ?? 0;
    if (!p || w <= 0) continue;
    tw += w; s.home += w * p.home; s.draw += w * p.draw; s.away += w * p.away;
  }
  if (tw <= 0) return null;
  return { home: s.home / tw, draw: s.draw / tw, away: s.away / tw };
}
const meanRps = (rows, weights) => {
  let sum = 0, n = 0;
  for (const r of rows) { const f = fuse(r.prod, weights); if (f) { sum += rps(f, r.y); n++; } }
  return n ? sum / n : Infinity;
};

const all = collectHistoricalMatches(4000)
  .filter((m) => m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const c1 = Math.floor(all.length * 0.6), c2 = Math.floor(all.length * 0.8);
const train = all.slice(0, c1), val = all.slice(c1, c2), test = all.slice(c2);
console.log(`store ${all.length} | train ${train.length} / val ${val.length} / test ${test.length}`);

console.log("拟合 5 路模型…");
const fits = {
  dc: fitFromMatches(train), bvp: fitBivariatePoisson(train),
  pi: fitPiRatings(train), massey: fitMasseyRatings(train), colley: fitColleyRatings(train),
  eloPredict: null,
};
console.log(`  massey ok=${fits.massey.ok} teams=${Object.keys(fits.massey.teams || {}).length}`);
const tables = buildEmpiricalTables(train, marketProbOf);

const prep = (rows) => rows.map((m) => ({
  y: outcomeOf(m),
  prod: buildOneX2Producers(fits, { home: m.home, away: m.away, league: m.league, marketProbs: marketProbOf(m) }, tables),
}));
const valR = prep(val), testR = prep(test);

// 逐路 val RPS
const perVal = {};
for (const k of PRODUCER_KEYS) {
  let s = 0, n = 0;
  for (const r of valR) if (r.prod[k]) { s += rps(r.prod[k], r.y); n++; }
  perVal[k] = { rps: n ? s / n : Infinity, cov: n / valR.length };
}
console.log("\n逐路 val 表现:");
for (const [k, v] of Object.entries(perVal).sort((a, b) => a[1].rps - b[1].rps))
  console.log(`  ${k.padEnd(12)} cov ${(v.cov * 100).toFixed(0).padStart(3)}%  RPS ${Number.isFinite(v.rps) ? v.rps.toFixed(4) : "(无)"}`);

// —— 前向逐步凸组合(在 val 上)——
const eligible = PRODUCER_KEYS.filter((k) => Number.isFinite(perVal[k].rps) && perVal[k].cov >= 0.5);
let weights = {};
const best0 = eligible.sort((a, b) => perVal[a].rps - perVal[b].rps)[0];
weights[best0] = 1;
let curRps = meanRps(valR, weights);
const trail = [`${best0}(基)`];
const ALPHAS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4];
for (let iter = 0; iter < 8; iter++) {
  let bestGain = 0, bestK = null, bestA = 0;
  for (const k of eligible) {
    for (const a of ALPHAS) {
      const w = {}; for (const m of PRODUCER_KEYS) w[m] = (weights[m] ?? 0) * (1 - a);
      w[k] = (w[k] ?? 0) + a;
      const r = meanRps(valR, w);
      if (curRps - r > bestGain + 1e-6) { bestGain = curRps - r; bestK = k; bestA = a; }
    }
  }
  if (!bestK || bestGain < 0.0002) break;
  for (const m of PRODUCER_KEYS) weights[m] = (weights[m] ?? 0) * (1 - bestA);
  weights[bestK] = (weights[bestK] ?? 0) + bestA;
  curRps = meanRps(valR, weights);
  trail.push(`+${bestK}×${bestA}(val RPS→${curRps.toFixed(4)})`);
}
// 清理极小权重并归一
let wsum = 0; for (const k of PRODUCER_KEYS) { if ((weights[k] ?? 0) < 0.01) delete weights[k]; else wsum += weights[k]; }
for (const k of Object.keys(weights)) weights[k] = Math.round(weights[k] / wsum * 1000) / 1000;

console.log("\n前向逐步选择过程:", trail.join("  →  "));
console.log("学到的融合权重(吸取最有用的,其余=0):");
Object.entries(weights).sort((a, b) => b[1] - a[1]).forEach(([k, w]) => console.log(`  ${k.padEnd(12)} ${(w * 100).toFixed(1)}%`));

// —— test 评估 ——
const evalArm = (rows, weightFn) => {
  let s = 0, h = 0, n = 0;
  for (const r of rows) { const f = weightFn(r.prod); if (f) { s += rps(f, r.y); if (top(f) === r.y) h++; n++; } }
  return { rps: s / n, hit: h / n, n };
};
const eqW = Object.fromEntries(eligible.map((k) => [k, 1]));
const learned = evalArm(testR, (p) => fuse(p, weights));
const equal = evalArm(testR, (p) => fuse(p, eqW));
const market = evalArm(testR, (p) => p.market ?? null);
const bestSingleKey = Object.entries(perVal).filter(([, v]) => Number.isFinite(v.rps)).sort((a, b) => a[1].rps - b[1].rps)[0][0];
const bestSingle = evalArm(testR, (p) => p[bestSingleKey] ?? null);

console.log("\ntest 臂对比(RPS 越低越好):");
console.log(`  最强单路(${bestSingleKey})  RPS ${bestSingle.rps.toFixed(4)} 命中 ${(bestSingle.hit * 100).toFixed(1)}%`);
console.log(`  等权可用路集成          RPS ${equal.rps.toFixed(4)} 命中 ${(equal.hit * 100).toFixed(1)}%`);
console.log(`  学权集成(前向逐步)     RPS ${learned.rps.toFixed(4)} 命中 ${(learned.hit * 100).toFixed(1)}%`);
console.log(`  市场单路                RPS ${market.rps.toFixed(4)} 命中 ${(market.hit * 100).toFixed(1)}%`);

console.log("\n诚实裁决(全样本):");
console.log(`  学权 vs 最强单路:Δ${(bestSingle.rps - learned.rps).toFixed(4)} ${learned.rps < bestSingle.rps - 0.0003 ? "✓集成更优" : "≈持平(有市场时融合=市场)"}`);
console.log(`  学权 vs 市场:Δ${(market.rps - learned.rps).toFixed(4)} ${learned.rps < market.rps - 0.0003 ? "✓更优(罕见)" : "✗打不过市场(预期内)"}`);

// ════ 无盘口段:这才是 10 路模型融合的真实落点(冷门场/无赔率,市场 producer 缺席)════
const noMktProducers = PRODUCER_KEYS.filter((k) => k !== "market");
const valNM = valR.filter((r) => !r.prod.market);
const testNM = testR.filter((r) => !r.prod.market);
console.log(`\n── 无盘口段(冷门场):val ${valNM.length} / test ${testNM.length} ──`);
// 该段逐路 val RPS
const perNM = {};
for (const k of noMktProducers) { let s = 0, n = 0; for (const r of valNM) if (r.prod[k]) { s += rps(r.prod[k], r.y); n++; } perNM[k] = { rps: n ? s / n : Infinity, cov: n / valNM.length }; }
const eligNM = noMktProducers.filter((k) => Number.isFinite(perNM[k].rps) && perNM[k].cov >= 0.5);
// 前向逐步(无市场)
let wNM = {}; const best0NM = eligNM.sort((a, b) => perNM[a].rps - perNM[b].rps)[0];
wNM[best0NM] = 1; let curNM = meanRps(valNM, wNM); const trailNM = [`${best0NM}(基)`];
for (let it = 0; it < 8; it++) {
  let bg = 0, bk = null, ba = 0;
  for (const k of eligNM) for (const a of ALPHAS) {
    const w = {}; for (const m of noMktProducers) w[m] = (wNM[m] ?? 0) * (1 - a); w[k] = (w[k] ?? 0) + a;
    const r = meanRps(valNM, w); if (curNM - r > bg + 1e-6) { bg = curNM - r; bk = k; ba = a; }
  }
  if (!bk || bg < 0.0002) break;
  for (const m of noMktProducers) wNM[m] = (wNM[m] ?? 0) * (1 - ba); wNM[bk] = (wNM[bk] ?? 0) + ba;
  curNM = meanRps(valNM, wNM); trailNM.push(`+${bk}×${ba}`);
}
let sNM = 0; for (const k of noMktProducers) { if ((wNM[k] ?? 0) < 0.01) delete wNM[k]; else sNM += wNM[k]; }
for (const k of Object.keys(wNM)) wNM[k] = Math.round(wNM[k] / sNM * 1000) / 1000;
const bestNMKey = eligNM.sort((a, b) => perNM[a].rps - perNM[b].rps)[0];
const learnedNM = evalArm(testNM, (p) => fuse(p, wNM));
const bestSingleNM = evalArm(testNM, (p) => p[bestNMKey] ?? null);
const equalNM = evalArm(testNM, (p) => fuse(p, Object.fromEntries(eligNM.map((k) => [k, 1]))));
console.log("  选择过程:", trailNM.join(" → "));
console.log("  权重:", Object.entries(wNM).sort((a, b) => b[1] - a[1]).map(([k, w]) => `${k} ${(w * 100).toFixed(0)}%`).join(" / "));
console.log(`  最强单模型(${bestNMKey}) RPS ${bestSingleNM.rps.toFixed(4)} 命中 ${(bestSingleNM.hit * 100).toFixed(1)}%`);
console.log(`  等权模型集成          RPS ${equalNM.rps.toFixed(4)} 命中 ${(equalNM.hit * 100).toFixed(1)}%`);
console.log(`  学权模型集成          RPS ${learnedNM.rps.toFixed(4)} 命中 ${(learnedNM.hit * 100).toFixed(1)}%`);
const nmGain = bestSingleNM.rps - learnedNM.rps;
console.log(`  → 学权集成 vs 最强单模型:Δ${nmGain.toFixed(4)} ${nmGain > 0.0003 ? "✓ 集成在无盘口段真增益(10路融合落点)" : "≈持平"}`);

if (APPLY) {
  const profile = {
    schema: "ensemble-weights-1x2", generatedAt: new Date().toISOString(), usable: true,
    split: { train: train.length, val: val.length, test: test.length },
    perProducerValRps: Object.fromEntries(Object.entries(perVal).map(([k, v]) => [k, Number.isFinite(v.rps) ? Math.round(v.rps * 1e4) / 1e4 : null])),
    weights, selectionTrail: trail,
    testArms: { bestSingle: { method: bestSingleKey, rps: Math.round(bestSingle.rps * 1e4) / 1e4 }, equal: Math.round(equal.rps * 1e4) / 1e4, learned: Math.round(learned.rps * 1e4) / 1e4, market: Math.round(market.rps * 1e4) / 1e4 },
    // 无盘口段(冷门场)权重 = 10 路模型融合的真实生产落点(市场缺席时用)
    noMarket: {
      weights: wNM, selectionTrail: trailNM, bestSingle: bestNMKey,
      testArms: { bestSingle: Math.round(bestSingleNM.rps * 1e4) / 1e4, equal: Math.round(equalNM.rps * 1e4) / 1e4, learned: Math.round(learnedNM.rps * 1e4) / 1e4 },
      gainVsBestSingle: Math.round((bestSingleNM.rps - learnedNM.rps) * 1e4) / 1e4,
    },
  };
  const out = join(getExportDir(), "ensemble-weights-1x2-profile.json");
  if (existsSync(out)) copyFileSync(out, out + ".bak");
  writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", "utf8");
  console.log(`\n已写 ${out}`);
} else console.log("\n(加 --apply 落 profile)");
