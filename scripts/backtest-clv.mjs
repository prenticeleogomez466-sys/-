/**
 * CLV(Closing Line Value)回测(2026-05-31)——分析师共识的"真 edge"指标。
 * ════════════════════════════════════════════════════════════════════
 * [[reference_top_analyst_essence]]/[[reference_signal_backtest_findings]]:
 *   真 edge = 击败收盘线(CLV)非命中率。公开数据打不过收盘线 → 命中率是错的 KPI。
 * fixture-store 富集后现有 33k 场带 开盘+收盘 去 vig 隐含(marketHistorical.openProbs/closeProbs)。
 *
 * 本回测 leak-safe 测:**纯模型(DC,不看市场)的 pick,是否被收盘线证明有价值**——
 *   你在开盘价下注模型 pick,收盘线若朝该 pick 移动(closeProb>openProb)= 正 CLV = 模型抢先市场。
 *   CLV% = (closeProb[pick]/openProb[pick] − 1)×100(>0 = 拿到优于收盘的价)。
 * 对照:开盘热门(市场自身 pick)的 CLV 应≈0(市场对自己无 edge)。
 * 模型 pick 平均 CLV%>0 且显著 = 真 edge;≈0 或<0 = 诚实承认无 edge(符合公开数据先验)。
 *
 * 用法:node scripts/backtest-clv.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const all = collectHistoricalMatches(4000)
  .filter((m) => m.homeGoals != null && m.awayGoals != null && m.date
    && m.marketHistorical?.openProbs && m.marketHistorical?.closeProbs)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
console.log(`带开盘+收盘隐含的场 ${all.length}`);
if (all.length < 500) { console.error("样本不足"); process.exit(1); }

const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
const fitted = fitFromMatches(train);
console.log(`train ${train.length} / test ${test.length} | DC teams ${Object.keys(fitted.teams || {}).length}`);

const OUT = ["home", "draw", "away"];
const argmaxKey = (p) => OUT.reduce((b, k) => (p[k] > p[b] ? k : b), "home");

// 模型 pick CLV、开盘热门 CLV、模型 pick 命中率(对照:CLV 与命中率脱钩)
const agg = {
  model: { clv: 0, pos: 0, n: 0, hit: 0 },
  marketFav: { clv: 0, pos: 0, n: 0, hit: 0 },
};
// 仅当模型 pick ≠ 开盘热门时,模型才表达了与市场不同的观点 → 看这部分 CLV(模型真分歧的价值)
const disagree = { clv: 0, pos: 0, n: 0, hit: 0 };

for (const m of test) {
  const op = m.marketHistorical.openProbs, cp = m.marketHistorical.closeProbs;
  if (!Number.isFinite(op.home) || !Number.isFinite(cp.home)) continue;
  const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.probabilities) continue;
  const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";

  const mPick = argmaxKey(pred.probabilities);
  const fav = argmaxKey(op);
  const clvOf = (k) => (op[k] > 0 ? (cp[k] / op[k] - 1) * 100 : 0);

  const cm = clvOf(mPick);
  agg.model.clv += cm; if (cm > 0) agg.model.pos++; if (mPick === y) agg.model.hit++; agg.model.n++;

  const cf = clvOf(fav);
  agg.marketFav.clv += cf; if (cf > 0) agg.marketFav.pos++; if (fav === y) agg.marketFav.hit++; agg.marketFav.n++;

  if (mPick !== fav) {
    disagree.clv += cm; if (cm > 0) disagree.pos++; if (mPick === y) disagree.hit++; disagree.n++;
  }
}

const row = (name, a) => console.log(
  name.padEnd(22),
  String(a.n).padStart(6),
  (a.clv / a.n).toFixed(3).padStart(9) + "%",
  (a.pos / a.n * 100).toFixed(1).padStart(8) + "%",
  (a.hit / a.n * 100).toFixed(1).padStart(7) + "%");

console.log("\n臂                      样本   平均CLV%   击败收盘率  命中率");
row("模型 DC pick", agg.model);
row("开盘热门(市场自身)", agg.marketFav);
row("模型≠市场(真分歧)", disagree);

const mClv = agg.model.clv / agg.model.n;
const dClv = disagree.n ? disagree.clv / disagree.n : 0;
console.log("\n判读:");
console.log(`  开盘热门平均 CLV ${(agg.marketFav.clv / agg.marketFav.n).toFixed(3)}%(应≈0,市场对自己无 edge——校验本回测口径)`);
console.log(`  模型 pick 平均 CLV ${mClv.toFixed(3)}% | 模型真分歧场 CLV ${dClv.toFixed(3)}%`);
if (mClv > 0.5 && disagree.n > 100 && dClv > 0.5) {
  console.log(`  → 模型 pick 被收盘线证明有正 CLV 价值(尤其真分歧场 ${dClv.toFixed(2)}%)= 真 edge 信号。`);
} else {
  console.log(`  → 模型 pick 无显著正 CLV(≤0.5%)。诚实结论:纯历史模型打不过收盘线`);
  console.log(`     ([[reference_signal_backtest_findings]] 一致)。命中率不是 edge,真增益要靠市场未定价的实时私有信息。`);
}
