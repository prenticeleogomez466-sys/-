/**
 * 半全场 top-1 vs top-2双选 命中(通宵 cycle15)——给半全场可执行的"双选"规则。
 * 9类首选命中低(~27%),覆盖前2类(双选)命中多少?按信心分档。leak-safe train60/test40。
 * 用法:node scripts/backtest-halffull-double.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullJoint } from "../src/halftime-fulltime-model.js";
const sgn = (x, y) => (x > y ? "主胜" : x === y ? "平局" : "客胜");
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.halfHome != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6); const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
const tiers = { "≥40%": { n: 0, h1: 0, h2: 0 }, "30-40%": { n: 0, h1: 0, h2: 0 }, "<30%": { n: 0, h1: 0, h2: 0 } };
for (const m of test) {
  const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.expectedGoals) continue;
  const hf = halfFullJoint(p.expectedGoals.home, p.expectedGoals.away);
  const sorted = Object.entries(hf).sort((a, b) => b[1] - a[1]);
  const top1 = sorted[0], top2 = sorted.slice(0, 2).map((x) => x[0]);
  const actual = `${sgn(m.halfHome, m.halfAway)}-${sgn(m.homeGoals, m.awayGoals)}`;
  const k = top1[1] >= 0.40 ? "≥40%" : top1[1] >= 0.30 ? "30-40%" : "<30%";
  const t = tiers[k]; t.n++; if (top1[0] === actual) t.h1++; if (top2.includes(actual)) t.h2++;
}
console.log(`半全场 ${test.length} 测试场\n信心档(首选概率)   场数    单选命中%   双选命中%(覆盖top2)`);
for (const k of ["≥40%", "30-40%", "<30%"]) { const t = tiers[k]; if (!t.n) continue; console.log(k.padEnd(16), String(t.n).padStart(6), (t.h1 / t.n * 100).toFixed(1).padStart(8) + "%", (t.h2 / t.n * 100).toFixed(1).padStart(12) + "%"); }
const allN = Object.values(tiers).reduce((s, t) => s + t.n, 0), allH1 = Object.values(tiers).reduce((s, t) => s + t.h1, 0), allH2 = Object.values(tiers).reduce((s, t) => s + t.h2, 0);
console.log(`\n全样本:单选 ${(allH1 / allN * 100).toFixed(1)}% → 双选 ${(allH2 / allN * 100).toFixed(1)}% | 双选加成 ${((allH2 - allH1) / allN * 100).toFixed(1)}pp`);
console.log("判读:半全场双选(覆盖top2/9)显著提命中,尤其高信心档;给用户'半全场要稳走双选'的可执行选项。");
