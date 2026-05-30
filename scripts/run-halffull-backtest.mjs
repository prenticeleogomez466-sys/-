/**
 * 半全场经验 · 真实留出回测(2026-05-31 学习轮 12)
 * ─────────────────────────────────────────────────────────────
 * 目的:验证经验库的半全场(HT符号-FT符号,9类)分布样本外是否稳定、**联赛维度是否真比全局更准**
 *   (同轮5大小球方法)。遵 feedback-hitrate-closed-loop:数据驱动、不盲建。
 *
 * 方法(leak-safe holdout):football-data big-5 有半场比分的场,按日期 70/30 留出;
 *   train 学 全局 + 各联赛 半全场分布;test 上比 multiclass Brier/LogLoss(A=全局/B=联赛)。
 *   半全场 9 类:主-主/主-平/主-客/平-主/平-平/平-客/客-主/客-平/客-客(HT-FT 各取符号)。
 *
 * 用法:node scripts/run-halffull-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const sign = (h, a) => (h > a ? "主" : h < a ? "客" : "平");
const hfKey = (m) => `${sign(m.halfHome, m.halfAway)}-${sign(m.homeGoals, m.awayGoals)}`;
const CLASSES = ["主-主", "主-平", "主-客", "平-主", "平-平", "平-客", "客-主", "客-平", "客-客"];

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.halfHome != null && m.halfAway != null && m.date);
console.log(`big-5 有半场比分 ${all.length} 场\n`);
const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`train ${train.length}(${train[0].date}~${train.at(-1).date}) / test ${test.length}(${test[0].date}~${test.at(-1).date})\n`);

function learnDist(matches) {
  const dist = (arr) => { const c = new Map(); for (const m of arr) { const k = hfKey(m); c.set(k, (c.get(k) ?? 0) + 1); } const o = {}; for (const cl of CLASSES) o[cl] = (c.get(cl) ?? 0) / (arr.length || 1); return o; };
  const global = dist(matches);
  const byLeague = new Map();
  const grp = new Map();
  for (const m of matches) { if (!grp.has(m.league)) grp.set(m.league, []); grp.get(m.league).push(m); }
  for (const [lg, arr] of grp) if (arr.length >= 40) byLeague.set(lg, dist(arr));
  return { global, byLeague };
}

const { global, byLeague } = learnDist(train);

let brierG = 0, llG = 0, brierL = 0, llL = 0, n = 0;
for (const m of test) {
  const ld = byLeague.get(m.league);
  if (!ld) continue;
  const y = hfKey(m);
  // multiclass Brier = Σ_c (p_c - 1{c=y})^2;LogLoss = -log p_y
  for (const c of CLASSES) {
    brierG += (global[c] - (c === y ? 1 : 0)) ** 2;
    brierL += (ld[c] - (c === y ? 1 : 0)) ** 2;
  }
  llG += -Math.log(Math.max(EPS, global[y]));
  llL += -Math.log(Math.max(EPS, ld[y]));
  n++;
}
console.log("样本外(有联赛分布的场):");
console.log(`  A 全局半全场分布:  Brier ${(brierG / n).toFixed(4)} | LogLoss ${(llG / n).toFixed(4)}`);
console.log(`  B 联赛半全场分布:  Brier ${(brierL / n).toFixed(4)} | LogLoss ${(llL / n).toFixed(4)} (${n}场)`);
console.log(`  → 联赛维度${brierL < brierG && llL < llG ? "加分 ✅" : brierL < brierG || llL < llG ? "部分加分(混合)" : "未加分 ❌"}`);

// 各联赛 top-3 半全场 + 全局对照
console.log("\n各联赛最常见半全场 top-3(train):");
const top3 = (d) => CLASSES.map((c) => [c, d[c]]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, p]) => `${c} ${(p * 100).toFixed(0)}%`).join(" / ");
console.log(`  全局: ${top3(global)}`);
for (const [lg, d] of byLeague) console.log(`  ${lg}: ${top3(d)}`);

// 联赛级 train↔test 稳定性(用主流类 主-主、平-平 的频率差)
console.log("\n联赛级关键类 train↔test 稳定性:");
const testByLeague = new Map();
for (const m of test) { if (!testByLeague.has(m.league)) testByLeague.set(m.league, []); testByLeague.get(m.league).push(m); }
for (const [lg, d] of byLeague) {
  const te = testByLeague.get(lg);
  if (!te || te.length < 30) continue;
  const teHH = te.filter((m) => hfKey(m) === "主-主").length / te.length;
  const teDD = te.filter((m) => hfKey(m) === "平-平").length / te.length;
  console.log(`  ${lg}: 主-主 train ${(d["主-主"] * 100).toFixed(1)}%→test ${(teHH * 100).toFixed(1)}%(差${((teHH - d["主-主"]) * 100).toFixed(1)}pp);平-平 ${(d["平-平"] * 100).toFixed(1)}%→${(teDD * 100).toFixed(1)}%(差${((teDD - d["平-平"]) * 100).toFixed(1)}pp)`);
}
console.log("\n诚实结论:看联赛 Brier/LogLoss 是否 < 全局(联赛维度有效)+ 关键类 train↔test 差是否小(稳定)。");
