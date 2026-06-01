/**
 * 双选(双重机会)命中率 by 信心档(通宵 cycle12)——给低信心场可执行的"双选"规则。
 * 高信心场单关、低信心场弃 之外:低信心场覆盖市场最可能的2个结果(双选)命中率仍高。
 * 按市场热门强度分桶,看 双选(覆盖top2) 命中率 + 单选命中率,量化"低信心→双选"价值。
 * 用法:node scripts/backtest-double-chance.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
const argmax = (p) => (p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away");
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.marketHistorical?.closeProbs);
const bk = (f) => f >= 0.65 ? "强热门≥0.65" : f >= 0.55 ? "中倾向0.55-0.65" : f >= 0.45 ? "弱倾向0.45-0.55" : "均势<0.45";
const T = {};
for (const m of all) {
  const p = m.marketHistorical.closeProbs;
  const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";
  const fav = argmax(p), favP = Math.max(p.home, p.draw, p.away);
  // 双选=覆盖概率最高的2个结果;其漏掉的=最低那个
  const lowest = ["home", "draw", "away"].sort((a, b) => p[a] - p[b])[0];
  const dcHit = y !== lowest ? 1 : 0; // 双选命中=实际不是被舍弃的最低项
  const single = fav === y ? 1 : 0;
  const k = bk(favP); T[k] = T[k] ?? { n: 0, s: 0, d: 0 }; T[k].n++; T[k].s += single; T[k].d += dcHit;
}
console.log(`${all.length} 场带收盘赔率\n`);
console.log("信心档              场数    单选命中%   双选命中%(覆盖top2)");
for (const k of ["强热门≥0.65", "中倾向0.55-0.65", "弱倾向0.45-0.55", "均势<0.45"]) {
  const t = T[k]; if (!t) continue;
  console.log(k.padEnd(18), String(t.n).padStart(6), (t.s / t.n * 100).toFixed(1).padStart(8) + "%", (t.d / t.n * 100).toFixed(1).padStart(12) + "%");
}
console.log("\n判读:低信心(均势/弱倾向)场单选命中低,但双选(双重机会)命中仍高 → 可执行规则:");
console.log("  强热门→单关(命中最高);弱/均势→双选(双重机会,命中显著拉回,代价是赔率低)。");
