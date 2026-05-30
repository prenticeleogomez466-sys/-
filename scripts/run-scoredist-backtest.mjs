/**
 * 比分分布经验 · 联赛 vs 全局 留出回测(2026-05-31 学习轮 19)
 * ─────────────────────────────────────────────────────────────
 * 验证经验库 scoreDist(精确比分直方图,封顶4)联赛维度样本外是否比全局准(同轮5/12方法)。
 * big-5 70/30 留出,比分25类(0-0..4-4)multiclass Brier/LogLoss 比 全局 vs 联赛。
 * 用法:node scripts/run-scoredist-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const EPS = 1e-12;
const cap = (x) => Math.min(x, 4);
const scoreKey = (m) => `${cap(m.homeGoals)}-${cap(m.awayGoals)}`;
const CLASSES = [];
for (let h = 0; h <= 4; h++) for (let a = 0; a <= 4; a++) CLASSES.push(`${h}-${a}`);

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`big-5 ${all.length} 场;train ${train.length} / test ${test.length}\n`);

function dist(arr) { const c = new Map(); for (const m of arr) c.set(scoreKey(m), (c.get(scoreKey(m)) ?? 0) + 1); const o = {}; for (const k of CLASSES) o[k] = (c.get(k) ?? 0) / (arr.length || 1); return o; }
const global = dist(train);
const byLeague = new Map();
const grp = new Map();
for (const m of train) { if (!grp.has(m.league)) grp.set(m.league, []); grp.get(m.league).push(m); }
for (const [lg, arr] of grp) if (arr.length >= 40) byLeague.set(lg, dist(arr));

let bG = 0, lG = 0, bL = 0, lL = 0, n = 0;
for (const m of test) {
  const ld = byLeague.get(m.league); if (!ld) continue;
  const y = scoreKey(m);
  for (const c of CLASSES) { bG += (global[c] - (c === y ? 1 : 0)) ** 2; bL += (ld[c] - (c === y ? 1 : 0)) ** 2; }
  lG += -Math.log(Math.max(EPS, global[y])); lL += -Math.log(Math.max(EPS, ld[y])); n++;
}
console.log("样本外比分分布(25类,越低越准):");
console.log(`  A 全局: Brier ${(bG / n).toFixed(4)} | LogLoss ${(lG / n).toFixed(4)}`);
console.log(`  B 联赛: Brier ${(bL / n).toFixed(4)} | LogLoss ${(lL / n).toFixed(4)} (${n}场)`);
console.log(`  → 联赛维度${bL < bG && lL < lG ? "加分 ✅" : bL < bG || lL < lG ? "部分加分" : "未加分 ❌"}`);

const top3 = (d) => CLASSES.map((c) => [c, d[c]]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, p]) => `${c} ${(p * 100).toFixed(0)}%`).join(" / ");
console.log("\n各联赛最常见比分 top-3(train):");
console.log(`  全局: ${top3(global)}`);
for (const [lg, d] of byLeague) console.log(`  ${lg}: ${top3(d)}`);
console.log("\n诚实结论:看联赛 Brier/LogLoss 是否 < 全局(同轮5大小球加分 / 轮12半全场边际微弱 之参照)。");
