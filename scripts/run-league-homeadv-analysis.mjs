/**
 * 各联赛主场优势离散度分析(2026-05-31 学习轮 11,先测后建)
 * ─────────────────────────────────────────────────────────────
 * 决策依据:per-league homeAdvantage 要改 fit()(较 invasive)。先量各联赛**经验主场优势**
 *   的离散度——若联赛间差异大(主胜率/主客进球比跨度宽),per-league 值得建;若都贴近全局,
 *   全局 1.24 够用。遵 feedback-hitrate-closed-loop:数据驱动、不盲建。
 *
 * 指标(全 football-data big-5 + 13 扩展联赛,全历史):主胜%/平%/客胜% + 主客场均进球比
 *   + 隐含 HA 乘子估计(home/away 场均进球比,≈ fit 里 homeAdvantage 的经验对应)。
 *
 * 用法:node scripts/run-league-homeadv-analysis.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES, LEAGUE_LABELS } from "../src/footballdata-loader.js";

const res = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null);
console.log(`football-data ${ALL_LEAGUES.length} 联赛,共 ${all.length} 场\n`);

const byLeague = new Map();
for (const m of all) {
  if (!byLeague.has(m.league)) byLeague.set(m.league, { n: 0, hw: 0, dr: 0, aw: 0, hg: 0, ag: 0 });
  const b = byLeague.get(m.league);
  b.n++;
  if (m.homeGoals > m.awayGoals) b.hw++;
  else if (m.homeGoals === m.awayGoals) b.dr++;
  else b.aw++;
  b.hg += m.homeGoals;
  b.ag += m.awayGoals;
}

const rows = [];
for (const [lg, b] of byLeague) {
  if (b.n < 200) continue;
  const homeRate = b.hw / b.n;
  const haMult = b.ag > 0 ? b.hg / b.ag : null; // 主客场均进球比 ≈ 经验主场乘子
  rows.push({ lg: LEAGUE_LABELS[lg] ?? lg, n: b.n, homeRate, drawRate: b.dr / b.n, awayRate: b.aw / b.n, haMult });
}
rows.sort((a, b) => b.haMult - a.haMult);

console.log("联赛        | 场数  | 主胜%  | 平%   | 客胜%  | 主客进球比(≈HA乘子)");
for (const r of rows) {
  console.log(`  ${r.lg.padEnd(8)} | ${String(r.n).padStart(4)} | ${(r.homeRate * 100).toFixed(1)}% | ${(r.drawRate * 100).toFixed(1)}% | ${(r.awayRate * 100).toFixed(1)}% | ${r.haMult.toFixed(3)}`);
}

const haMults = rows.map((r) => r.haMult);
const homeRates = rows.map((r) => r.homeRate);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
console.log(`\nHA乘子:均 ${mean(haMults).toFixed(3)},标准差 ${sd(haMults).toFixed(3)},范围 [${Math.min(...haMults).toFixed(3)}, ${Math.max(...haMults).toFixed(3)}]`);
console.log(`主胜率:均 ${(mean(homeRates) * 100).toFixed(1)}%,标准差 ${(sd(homeRates) * 100).toFixed(1)}pp,范围 [${(Math.min(...homeRates) * 100).toFixed(1)}%, ${(Math.max(...homeRates) * 100).toFixed(1)}%]`);
const spread = Math.max(...haMults) - Math.min(...haMults);
console.log(`\n诚实结论:HA乘子跨联赛范围 ${spread.toFixed(3)}。${spread > 0.25 ? "差异大 → per-league homeAdvantage 值得建(改 fit 按联赛估,样本足单独估、不足退全局)。" : "差异不大 → 全局 1.24 够用,per-league 收益有限,优先级降低。"}`);
