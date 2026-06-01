/**
 * 负二项(过离散)边际 vs 泊松 比分模型回测(通宵 cycle3,SOTA文献:Sarmanov族/过离散2025)。
 * 真实进球方差>均值(过离散),DC 用泊松边际可能低估高分尾/错配低分。测:同 λ 下
 * 负二项(NegBin, mean=λ,离散 r)边际 + DC τ vs 泊松边际 + DC τ,在 exact-score logloss。
 * 网格搜 r(train),test 验。r→∞=泊松。leak-safe train60/test40。
 * 用法:node scripts/backtest-negbin-score.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const G = 6, EPS = 1e-12;
const lg = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
const lgamma = (x) => { // Lanczos
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let xx = x, y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y++; ser += g[j] / y; } return -tmp + Math.log(2.5066282746310005 * ser / xx);
};
const poiPmf = (k, l) => (l > 0 ? Math.exp(k * Math.log(l) - l - lg(k)) : (k === 0 ? 1 : 0));
const nbPmf = (k, mean, r) => { // 负二项 mean=mean, 离散 r(方差=mean+mean^2/r)
  if (!(mean > 0)) return k === 0 ? 1 : 0;
  const p = r / (r + mean);
  return Math.exp(lgamma(k + r) - lgamma(r) - lg(k) + r * Math.log(p) + k * Math.log(1 - p));
};
const tau = (h, a, l, m, rho) => h === 0 && a === 0 ? 1 - l * m * rho : h === 0 && a === 1 ? 1 + l * rho : h === 1 && a === 0 ? 1 + m * rho : h === 1 && a === 1 ? 1 - rho : 1;
function matrix(lh, la, r, rho = -0.08) {
  const pm = (k, mn) => (r >= 9999 ? poiPmf(k, mn) : nbPmf(k, mn, r));
  const m = []; let tot = 0;
  for (let h = 0; h <= G; h++) { m[h] = []; for (let a = 0; a <= G; a++) { const p = Math.max(pm(h, lh) * pm(a, la) * tau(h, a, lh, la, rho), 0); m[h][a] = p; tot += p; } }
  for (let h = 0; h <= G; h++) for (let a = 0; a <= G; a++) m[h][a] /= tot; return m;
}

const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6);
const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
console.log(`store ${all.length} | train ${train.length}/test ${test.length} | DC teams ${Object.keys(dc.teams || {}).length}`);

// 预存每场 λ
const prep = (rows) => rows.map((m) => { const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); return p?.expectedGoals ? { lh: p.expectedGoals.home, la: p.expectedGoals.away, h: Math.min(m.homeGoals, G), a: Math.min(m.awayGoals, G) } : null; }).filter(Boolean);
const trainP = prep(train), testP = prep(test);
const ll = (rows, r) => { let s = 0, n = 0; for (const x of rows) { const mt = matrix(x.lh, x.la, r); s += -Math.log(Math.max(mt[x.h][x.a], EPS)); n++; } return s / n; };

console.log("\nr(离散)   train_LL   test_LL   (r=9999即泊松)");
const Rs = [3, 5, 8, 12, 20, 40, 9999];
let best = null;
for (const r of Rs) { const tr = ll(trainP, r), te = ll(testP, r); if (!best || tr < best.tr) best = { r, tr, te }; console.log(String(r === 9999 ? "泊松" : r).padStart(7), tr.toFixed(4).padStart(10), te.toFixed(4).padStart(9)); }
const poiTest = ll(testP, 9999);
const bestTest = ll(testP, best.r);
console.log(`\n训练最优 r=${best.r === 9999 ? "泊松" : best.r} | test LL ${bestTest.toFixed(4)} vs 泊松 ${poiTest.toFixed(4)} | Δ${(poiTest - bestTest).toFixed(4)}`);
console.log(best.r !== 9999 && poiTest - bestTest > 0.001 ? `→ 负二项(r=${best.r})显著优于泊松,值得接进比分矩阵` : "→ 负二项未显著优于泊松(差异噪声内),保留泊松(诚实)");
