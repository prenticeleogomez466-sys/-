/**
 * 半全场多路集成 leak-safe 回测 + 前向逐步学权重(2026-06-01)。
 * train60/val20/test20。富集后 store 有 10万+ 真实半场 → 经验 HT-FT 频率成强 producer。
 * 6 路:halfFullJoint默认 / chase=0 / rho=0 / 旧固定0.46 / 数据拟合比例 / 经验频率(联赛)。
 * 前向逐步最小化 val 9类 logloss,test 验 logloss+命中 vs 现行(halfFullJoint默认)。诚实裁决。
 * 用法:node scripts/backtest-ensemble-halffull.mjs [--apply]
 */
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullJoint, fitHalfFullParams } from "../src/halftime-fulltime-model.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";
import { getExportDir } from "../src/paths.js";

const APPLY = process.argv.includes("--apply");
const EPS = 1e-12;
const CLASSES = ["HH", "HD", "HA", "DH", "DD", "DA", "AH", "AD", "AA"];
const CN = { 主胜: "H", 平局: "D", 客胜: "A" };
const sign = (x, y) => (x > y ? "H" : x === y ? "D" : "A");
const toCode = (dict) => { if (!dict) return null; const o = {}; let s = 0; for (const [k, v] of Object.entries(dict)) { const [ht, ft] = k.split("-"); const c = (CN[ht] ?? "") + (CN[ft] ?? ""); if (CLASSES.includes(c) && Number.isFinite(v)) { o[c] = (o[c] ?? 0) + v; s += v; } } if (s <= 0) return null; for (const c of CLASSES) o[c] = (o[c] ?? 0) / s; return o; };

const KEYS = ["model_default", "model_indep", "model_notau", "old_fixed", "model_fitted", "empirical"];
const fuse = (prod, w) => { const o = Object.fromEntries(CLASSES.map((c) => [c, 0])); let tw = 0; for (const k of KEYS) { const p = prod[k], ww = w[k] ?? 0; if (!p || ww <= 0) continue; tw += ww; for (const c of CLASSES) o[c] += ww * p[c]; } if (tw <= 0) return null; for (const c of CLASSES) o[c] /= tw; return o; };
const ll = (rows, w) => { let s = 0, n = 0; for (const r of rows) { const f = fuse(r.prod, w); if (!f) continue; s += -Math.log(Math.max(f[r.y], EPS)); n++; } return n ? s / n : Infinity; };
const hit = (rows, w) => { let h = 0, n = 0; for (const r of rows) { const f = fuse(r.prod, w); if (!f) continue; const t = CLASSES.reduce((b, c) => (f[c] > f[b] ? c : b), CLASSES[0]); if (t === r.y) h++; n++; } return n ? h / n : 0; };

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.awayGoals != null && m.halfHome != null && m.halfAway != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const c1 = Math.floor(all.length * 0.6), c2 = Math.floor(all.length * 0.8);
const train = all.slice(0, c1), val = all.slice(c1, c2), test = all.slice(c2);
console.log(`带真实半场 ${all.length} | train ${train.length} / val ${val.length} / test ${test.length}`);
const dc = fitFromMatches(train);
const R = fitHalfFullParams(train); // 数据拟合半场比例
console.log(`DC teams ${Object.keys(dc.teams || {}).length} | ${R.note}`);

// 经验 HT-FT 频率(联赛,laplace)+ 全局
const empByLeague = new Map(); const empGlobal = Object.fromEntries(CLASSES.map((c) => [c, 1]));
for (const m of train) { const c = sign(m.halfHome, m.halfAway) + sign(m.homeGoals, m.awayGoals); empGlobal[c]++; const lg = m.league ?? "?"; let e = empByLeague.get(lg); if (!e) { e = Object.fromEntries(CLASSES.map((x) => [x, 1])); empByLeague.set(lg, e); } e[c]++; }
const normEmp = (e) => { const t = CLASSES.reduce((s, c) => s + e[c], 0); return Object.fromEntries(CLASSES.map((c) => [c, e[c] / t])); };
const empGlobalN = normEmp(empGlobal); const empLeagueN = new Map(); for (const [lg, e] of empByLeague) { const n = CLASSES.reduce((s, c) => s + e[c], 0) - 9; if (n >= 200) empLeagueN.set(lg, normEmp(e)); }

const prep = (rows) => rows.map((m) => {
  const pred = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away });
  const lh = pred?.expectedGoals?.home, la = pred?.expectedGoals?.away;
  const ok = Number.isFinite(lh) && Number.isFinite(la);
  return {
    y: sign(m.halfHome, m.halfAway) + sign(m.homeGoals, m.awayGoals),
    prod: {
      model_default: ok ? toCode(halfFullJoint(lh, la)) : null,
      model_indep: ok ? toCode(halfFullJoint(lh, la, { chase: 0 })) : null,
      model_notau: ok ? toCode(halfFullJoint(lh, la, { rho: 0 })) : null,
      old_fixed: ok ? toCode(halfFullProbsFromLambdas(lh, la, 0.46)) : null,
      model_fitted: ok ? toCode(halfFullJoint(lh, la, { firstHalfRatioHome: R.firstHalfRatioHome, firstHalfRatioAway: R.firstHalfRatioAway })) : null,
      empirical: empLeagueN.get(m.league) ?? empGlobalN,
    },
  };
});
const valR = prep(val), testR = prep(test);

const perVal = {}; for (const k of KEYS) { let s = 0, n = 0; for (const r of valR) if (r.prod[k]) { s += -Math.log(Math.max(r.prod[k][r.y], EPS)); n++; } perVal[k] = { ll: n ? s / n : Infinity, cov: n / valR.length }; }
console.log("\n逐路 val(9类 logloss):");
for (const [k, v] of Object.entries(perVal).sort((a, b) => a[1].ll - b[1].ll)) console.log(`  ${k.padEnd(14)} cov ${(v.cov * 100).toFixed(0).padStart(3)}%  LL ${v.ll.toFixed(4)}`);

const elig = KEYS.filter((k) => Number.isFinite(perVal[k].ll) && perVal[k].cov >= 0.5);
let w = {}; const b0 = elig.sort((a, b) => perVal[a].ll - perVal[b].ll)[0]; w[b0] = 1; let cur = ll(valR, w); const trail = [`${b0}(基)`]; const ALPHAS = [0.05, 0.1, 0.2, 0.3, 0.4];
for (let it = 0; it < 6; it++) { let bg = 0, bk = null, ba = 0; for (const k of elig) for (const al of ALPHAS) { const ww = {}; for (const m of KEYS) ww[m] = (w[m] ?? 0) * (1 - al); ww[k] = (ww[k] ?? 0) + al; const r = ll(valR, ww); if (cur - r > bg + 1e-6) { bg = cur - r; bk = k; ba = al; } } if (!bk || bg < 0.0003) break; for (const m of KEYS) w[m] = (w[m] ?? 0) * (1 - ba); w[bk] = (w[bk] ?? 0) + ba; cur = ll(valR, w); trail.push(`+${bk}×${ba}`); }
let ws = 0; for (const k of KEYS) { if ((w[k] ?? 0) < 0.01) delete w[k]; else ws += w[k]; } for (const k of Object.keys(w)) w[k] = Math.round(w[k] / ws * 1000) / 1000;
console.log("\n前向逐步:", trail.join(" → "));
console.log("权重(吸取最有用的):", Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(" / "));

const curKey = "model_default"; const curW = { model_default: 1 };
const llCur = ll(testR, curW), llLearn = ll(testR, w);
console.log("\ntest 评估:");
console.log(`  现行(halfFullJoint默认)  LL ${llCur.toFixed(4)} 命中 ${(hit(testR, curW) * 100).toFixed(2)}%`);
console.log(`  等权集成                  LL ${ll(testR, Object.fromEntries(elig.map((k) => [k, 1]))).toFixed(4)} 命中 ${(hit(testR, Object.fromEntries(elig.map((k) => [k, 1]))) * 100).toFixed(2)}%`);
console.log(`  学权集成                  LL ${llLearn.toFixed(4)} 命中 ${(hit(testR, w) * 100).toFixed(2)}%`);
console.log(`\n诚实裁决:学权集成 vs 现行 LL Δ${(llCur - llLearn).toFixed(4)} ${llLearn < llCur - 0.001 ? "✓集成更优(经验频率补足)" : "≈持平(半全场近顶,印证 AL档)"}`);

if (APPLY) {
  const profile = { schema: "ensemble-weights-halffull", generatedAt: new Date().toISOString(), usable: true, eligible: elig, weights: w, selectionTrail: trail, perProducerValLogloss: Object.fromEntries(Object.entries(perVal).map(([k, v]) => [k, Number.isFinite(v.ll) ? Math.round(v.ll * 1e4) / 1e4 : null])), testArms: { current: Math.round(llCur * 1e4) / 1e4, learned: Math.round(llLearn * 1e4) / 1e4, gain: Math.round((llCur - llLearn) * 1e4) / 1e4 } };
  const out = join(getExportDir(), "ensemble-weights-halffull-profile.json");
  if (existsSync(out)) copyFileSync(out, out + ".bak");
  writeFileSync(out, JSON.stringify(profile, null, 2) + "\n", "utf8");
  console.log(`\n已写 ${out}`);
} else console.log("\n(加 --apply 落 profile)");
