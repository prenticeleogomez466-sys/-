/**
 * 三重过滤"金选"(通宵 cycle13)——市场强热门 + 模型同向 + 赔率漂移确认 的交集命中率。
 * 给用户"最稳子集"规则:多信号一致时命中最高(代价=覆盖少)。leak-safe train60/test40。
 * 漂移确认=收盘热门概率≥开盘(钱往热门走)。用法:node scripts/backtest-best-bets-filter.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
const argmax = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date && m.marketHistorical?.closeProbs).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6); const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
const F = { A: { n: 0, h: 0 }, B: { n: 0, h: 0 }, C: { n: 0, h: 0 }, all: { n: 0, h: 0 } };
for (const m of test) {
  const c = m.marketHistorical.closeProbs, o = m.marketHistorical.openProbs;
  const fav = argmax(c), favP = c[fav];
  const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";
  const win = fav === y ? 1 : 0;
  F.all.n++; F.all.h += win;
  if (favP < 0.65) continue;
  F.A.n++; F.A.h += win; // 强热门
  const pred = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away });
  const agree = pred?.probabilities ? argmax(pred.probabilities) === fav : false;
  if (!agree) continue;
  F.B.n++; F.B.h += win; // + 模型同向
  const driftOk = o && Number.isFinite(o[fav]) ? (c[fav] >= o[fav]) : true; // 漂移确认:收盘热门概率≥开盘
  if (!driftOk) continue;
  F.C.n++; F.C.h += win; // + 漂移确认
}
const tot = F.all.n;
console.log(`test ${tot} 场\n`);
console.log("过滤层                          覆盖%    命中%");
console.log("全样本(打市场热门)              100%   " + (F.all.h / F.all.n * 100).toFixed(1) + "%");
console.log("A 强热门≥0.65                  " + (F.A.n / tot * 100).toFixed(0).padStart(4) + "%   " + (F.A.h / F.A.n * 100).toFixed(1) + "%");
console.log("B A+模型同向                    " + (F.B.n / tot * 100).toFixed(0).padStart(4) + "%   " + (F.B.h / F.B.n * 100).toFixed(1) + "%");
console.log("C A+模型同向+漂移确认(金选)      " + (F.C.n / tot * 100).toFixed(0).padStart(4) + "%   " + (F.C.h / F.C.n * 100).toFixed(1) + "%");
console.log(`\n判读:三重过滤(金选)命中 ${(F.C.h / F.C.n * 100).toFixed(1)}% @ 覆盖 ${(F.C.n / tot * 100).toFixed(0)}%。`);
console.log(`vs 仅强热门 ${(F.A.h / F.A.n * 100).toFixed(1)}%:漂移/同向加成 ${((F.C.h / F.C.n - F.A.h / F.A.n) * 100).toFixed(1)}pp ` + ((F.C.h / F.C.n - F.A.h / F.A.n) > 0.01 ? "✓ 三重过滤真提命中(金选规则成立)" : "≈ 加成有限(强热门已够,多滤主要降覆盖)"));
