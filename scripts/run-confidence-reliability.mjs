/**
 * 信心可靠性(复盘校准)· 留出回测(2026-05-31 学习轮 20)
 * ─────────────────────────────────────────────────────────────
 * 用户复盘核心问:"信心高的命中是否真高?"。生产 ledger 仅2行结算(冷启动/未赛),无法分析 →
 * 改在样本外真数据(big-5)上答:按 pick 信心(max wld 概率)分桶,看每桶**实际命中率 vs 预测信心**。
 * 对角=校准好(信心诚实)。用市场+DC blend 近似生产 prior(市场为主)。
 * 用法:node scripts/run-confidence-reliability.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const monthKey = (d) => d.slice(0, 7);

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.date && (m.oddsClose || m.odds));
const test = all.filter((m) => m.date >= "2025-01-01");
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();

// blend: 市场隐含(主) + DC(辅 0.25),近似生产 prior
function blend(market, dc) {
  if (!dc) return market;
  return { home: 0.75 * market.home + 0.25 * dc.home, draw: 0.75 * market.draw + 0.25 * dc.draw, away: 0.75 * market.away + 0.25 * dc.away };
}
const real = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");

const bins = new Map(); // 信心档(0.05宽)→ {n, hit, confSum}
for (const mk of months) {
  const mm = test.filter((m) => monthKey(m.date) === mk);
  const history = all.filter((m) => m.date < mm[0].date);
  if (history.length < 200) continue;
  const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: mm[0].date, shrinkageK: 2 });
  for (const m of mm) {
    const mkt = m.oddsClose || m.odds;
    let dc = null;
    if (fitted?.usable) { const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away }); dc = p?.probabilities ?? null; }
    const pr = blend(mkt, dc);
    const pick = pr.home >= pr.draw && pr.home >= pr.away ? "home" : pr.away >= pr.draw ? "away" : "draw";
    const conf = pr[pick];
    const hit = pick === real(m);
    const b = Math.min(0.95, Math.floor(conf / 0.05) * 0.05);
    if (!bins.has(b)) bins.set(b, { n: 0, hit: 0, confSum: 0 });
    const bb = bins.get(b); bb.n++; if (hit) bb.hit++; bb.confSum += conf;
  }
}
console.log(`信心可靠性(big-5 测试期 ${test.length} 场;blend 市场0.75+DC0.25):\n`);
console.log("信心档    | 场数 | 平均预测信心 | 实际命中率 | 偏差(实际-预测)");
let totN = 0, totHit = 0, totConf = 0, eceSum = 0;
for (const b of [...bins.keys()].sort((a, c) => a - c)) {
  const x = bins.get(b);
  const predC = x.confSum / x.n, actC = x.hit / x.n;
  totN += x.n; totHit += x.hit; totConf += x.confSum; eceSum += x.n * Math.abs(actC - predC);
  if (x.n < 20) continue;
  const gap = (actC - predC) * 100;
  console.log(`  ${(b * 100).toFixed(0)}-${(b * 100 + 5).toFixed(0)}%  | ${String(x.n).padStart(4)} | ${(predC * 100).toFixed(1)}%      | ${(actC * 100).toFixed(1)}%    | ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp`);
}
console.log(`\n总体:平均信心 ${(totConf / totN * 100).toFixed(1)}% vs 实际命中 ${(totHit / totN * 100).toFixed(1)}%;ECE(加权平均校准误差)${(eceSum / totN * 100).toFixed(2)}pp`);
console.log("诚实结论:各档|偏差|小=信心诚实(高信心确实高命中);ECE<3pp 算校准良好。");
