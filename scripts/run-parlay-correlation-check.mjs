/**
 * 同赛日赛果相关性检验(2026-05-31 学习轮 21)
 * ─────────────────────────────────────────────────────────────
 * 14场/串关联合命中率=各腿概率连乘的前提是"各场独立"。本检验用 big-5 实测:同一比赛日多场
 * 主胜结果是否正相关(若强正相关→连乘高估联合命中,parlay-correlation-adjuster 才有必要)。
 * 方法:每个比赛日数主胜场数,比"实测方差" vs "独立假设(泊松-二项)方差";比值≈1=独立。
 * 用法:node scripts/run-parlay-correlation-check.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.date);

// 按比赛日分组(≥3 场才有意义)
const byDate = new Map();
for (const m of all) { if (!byDate.has(m.date)) byDate.set(m.date, []); byDate.get(m.date).push(m); }

let days = 0, sumK = 0, sumN = 0, obsVarNum = 0, indepVarNum = 0, totalMatches = 0, homeWins = 0;
// 也算 pairwise:同日两场都主胜 vs 期望
for (const [, ms] of byDate) {
  if (ms.length < 3) continue;
  const n = ms.length;
  const k = ms.filter((m) => m.homeGoals > m.awayGoals).length;
  days++; sumK += k; sumN += n;
  totalMatches += n; homeWins += k;
}
const pBar = homeWins / totalMatches; // 总体主胜率
// 实测:每日主胜比例的方差 vs 独立二项方差 p(1-p)/n,聚合(加权 n)
let obsW = 0, indepW = 0, wsum = 0;
for (const [, ms] of byDate) {
  if (ms.length < 3) continue;
  const n = ms.length, k = ms.filter((m) => m.homeGoals > m.awayGoals).length;
  const frac = k / n;
  obsW += n * (frac - pBar) ** 2;       // 实测离差
  indepW += n * (pBar * (1 - pBar) / n); // 独立预期方差×n
  wsum += n;
}
const obsVar = obsW / wsum, indepVar = indepW / wsum;
const ratio = obsVar / indepVar;
console.log(`big-5:${days} 个比赛日(≥3场),共 ${totalMatches} 场,总体主胜率 ${(pBar * 100).toFixed(1)}%\n`);
console.log(`同赛日主胜比例方差:实测 ${obsVar.toFixed(5)} vs 独立假设 ${indepVar.toFixed(5)}`);
console.log(`方差比(实测/独立)= ${ratio.toFixed(3)}  (≈1=独立;>1.2=显著正相关)`);
console.log(`\n诚实结论:${ratio < 1.2 ? "同赛日赛果≈独立 → 14场/串关连乘联合命中率假设成立,parlay-correlation-adjuster 的同日修正属保守兜底(实测相关性弱)。" : "同赛日正相关显著 → 连乘高估联合命中,相关性修正必要。"}`);
console.log("(注:真正强相关在'同场不同玩法'SGP,本检验针对14场/串关的'不同场'腿,结论=不同场基本独立。)");
