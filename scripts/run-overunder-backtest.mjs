/**
 * 大小球经验 · 真实留出回测(2026-05-31 学习轮 5)
 * ─────────────────────────────────────────────────────────────
 * 目的:验证学习轮 1 加进经验库的"联赛大小球(over2.5)率"在**样本外**是否稳定,
 *       且**联赛维度是否真比全局更准**(否则按联赛分桶无意义)。遵 feedback-hitrate-closed-loop。
 *
 * 方法(诚实留出):
 *   1. football-data big-5,按日期 70/30 时间切分(train 在前 / test 在后)。
 *   2. 在 train 学:全局 over2.5 率、各联赛 over2.5 率、各(联赛+热门档)over2.5 率。
 *   3. 在 test(样本外)上比 Brier:predictor A=全局率 / B=联赛率 / C=联赛+热门档率。
 *      Brier 越低越准;若 B<A,联赛维度真的加分(轮1 分桶有意义)。
 *   4. 报各联赛 train↔test over2.5 率差(稳定性)。
 *
 * 用法:node scripts/run-overunder-backtest.mjs
 */
import { loadFootballDataMatches, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { frameOf } from "../src/experience-library.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const FAV_BANDS = [
  [0.33, 0.42, "弱热"], [0.42, 0.5, "小热"], [0.5, 0.6, "中热"],
  [0.6, 0.7, "强热"], [0.7, 0.82, "大热"], [0.82, 1.01, "超热"],
];
function favBand(p) { for (const [lo, hi, l] of FAV_BANDS) if (p >= lo && p < hi) return l; return "弱热"; }
const isOver25 = (m) => m.homeGoals + m.awayGoals >= 3;
const favTierKey = (m) => {
  const prob = m.oddsClose || m.odds; if (!prob) return null;
  const f = frameOf(prob); if (!f) return null;
  return `${m.league}|${f.side}|${favBand(f.favProb)}`;
};

// 学:计数 → 率
function learnRates(matches) {
  const g = { n: 0, o: 0 };
  const byLeague = new Map();
  const byTier = new Map();
  for (const m of matches) {
    const over = isOver25(m);
    g.n++; if (over) g.o++;
    const lk = m.league;
    if (!byLeague.has(lk)) byLeague.set(lk, { n: 0, o: 0 });
    const lb = byLeague.get(lk); lb.n++; if (over) lb.o++;
    const tk = favTierKey(m);
    if (tk) { if (!byTier.has(tk)) byTier.set(tk, { n: 0, o: 0 }); const tb = byTier.get(tk); tb.n++; if (over) tb.o++; }
  }
  return {
    global: g.o / g.n,
    league: (lg) => (byLeague.has(lg) && byLeague.get(lg).n >= 40 ? byLeague.get(lg).o / byLeague.get(lg).n : null),
    tier: (m) => { const k = favTierKey(m); return k && byTier.has(k) && byTier.get(k).n >= 30 ? byTier.get(k).o / byTier.get(k).n : null; },
    _byLeague: byLeague, _global: g.o / g.n,
  };
}

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null);
const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`big-5 ${all.length} 场;train ${train.length}(${train[0]?.date}~${train.at(-1)?.date}) / test ${test.length}(${test[0]?.date}~${test.at(-1)?.date})\n`);

const R = learnRates(train);

// 样本外 Brier(三 predictor)。公平比较:每对在**同一子集**上比。
let bgAll = 0;                       // A 全局,全 test
let bgL = 0, blL = 0, nL = 0;        // A vs B,在"有联赛率"子集
let blT = 0, btT = 0, nT = 0;        // B vs C,在"有热门档率"子集
for (const m of test) {
  const y = isOver25(m) ? 1 : 0;
  bgAll += (R.global - y) ** 2;
  const pl = R.league(m.league);
  const pt = R.tier(m);
  if (pl != null) { bgL += (R.global - y) ** 2; blL += (pl - y) ** 2; nL++; }
  if (pl != null && pt != null) { blT += (pl - y) ** 2; btT += (pt - y) ** 2; nT++; }
}
console.log("样本外 Brier(越低越准,每对同子集比):");
console.log(`  A 全局率(${(R.global * 100).toFixed(1)}%)全test:  ${(bgAll / test.length).toFixed(4)} (${test.length}场)`);
console.log(`  A 全局 vs B 联赛(同子集):  A=${(bgL / nL).toFixed(4)} / B=${(blL / nL).toFixed(4)} (${nL}场)  → 联赛维度${blL < bgL ? "加分 ✅" : "未加分 ❌"}`);
console.log(`  B 联赛 vs C 联赛+热门档(同子集): B=${(blT / nT).toFixed(4)} / C=${(btT / nT).toFixed(4)} (${nT}场)  → 热门档${btT < blT ? "再加分 ✅" : "不再加分(过拟合/无关)"}`);

console.log("\n各联赛 over2.5 率 train↔test 稳定性:");
for (const lg of BIG5) {
  const tr = R._byLeague.get(lg);
  const te = test.filter((m) => m.league === lg);
  if (!tr || te.length < 30) continue;
  const trR = tr.o / tr.n, teR = te.filter(isOver25).length / te.length;
  console.log(`  ${LEAGUE_LABELS[lg] ?? lg}: train ${(trR * 100).toFixed(1)}% → test ${(teR * 100).toFixed(1)}%  [差 ${((teR - trR) * 100).toFixed(1)}pp]`);
}
console.log("\n诚实结论:看联赛 Brier 是否 < 全局(联赛维度有效)+ train↔test 差是否小(率稳定)。");
