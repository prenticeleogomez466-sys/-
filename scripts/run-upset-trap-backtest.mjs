// 爆冷/诱盘检测回测验证(过夜 L2)——用 football-data 开盘+收盘隐含概率,验证:
//   ① 被加注热门 vs 退烧热门 的真实胜率差(实证锚:56.4% vs 45.5%);
//   ② 模块 upsetRisk 的方向校准(加注档真实爆冷率应低于退烧档)。
// 纯市场验证(无模型),leak-safe 无需(只用同场开收盘→赛果,不跨场拟合)。
//
// 跑法:node scripts/run-upset-trap-backtest.mjs
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { analyzeUpsetTrap, favoriteUpset } from "../src/upset-trap-detector.js";

const { matches, withClosing, byLeague } = await loadFootballDataMatches();
const usable = matches.filter((m) => m.odds && m.oddsClose && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals));
console.log(`样本:${matches.length} 场,带开+收盘 ${withClosing},可用 ${usable.length}`);

const buckets = {
  加注: { n: 0, favWon: 0 },
  退烧: { n: 0, favWon: 0 },
  平稳: { n: 0, favWon: 0 },
};
const byLevel = {}; // upsetLevel → {n, favWon}
const tierAgg = {};  // tier → {n, favWon}

let riskSum = 0, riskN = 0, upsetActual = 0;
for (const m of usable) {
  const a = analyzeUpsetTrap({ opening: m.odds, closing: m.oddsClose });
  if (!a) continue;
  const u = favoriteUpset(m.oddsClose, { home: m.homeGoals, away: m.awayGoals });
  if (!u) continue;
  const moved = a.movement.favoriteDrift;
  const key = moved > 0.02 ? "加注" : moved < -0.02 ? "退烧" : "平稳";
  buckets[key].n++; if (u.won) buckets[key].favWon++;
  (byLevel[a.upsetLevel] ??= { n: 0, favWon: 0 }).n++; if (u.won) byLevel[a.upsetLevel].favWon++;
  (tierAgg[a.tier] ??= { n: 0, favWon: 0 }).n++; if (u.won) tierAgg[a.tier].favWon++;
  // upsetRisk 校准:预测爆冷率 vs 实际爆冷率(热门未胜)
  riskSum += a.upsetRisk; riskN++; if (!u.won) upsetActual++;
}

const pct = (w, n) => (n ? `${(100 * w / n).toFixed(1)}%` : "—");
console.log("\n=== 盘口移动 → 热门真实胜率 ===");
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: n=${v.n}  热门胜率=${pct(v.favWon, v.n)}`);
const aWin = buckets.加注.favWon / Math.max(1, buckets.加注.n);
const dWin = buckets.退烧.favWon / Math.max(1, buckets.退烧.n);
console.log(`  方向验证:加注(${pct(buckets.加注.favWon, buckets.加注.n)}) − 退烧(${pct(buckets.退烧.favWon, buckets.退烧.n)}) = ${((aWin - dWin) * 100).toFixed(1)}pp ${aWin > dWin ? "✓ 与实证同向" : "✗ 反向"}`);

console.log("\n=== 热门强度档 → 真实胜率 ===");
for (const [k, v] of Object.entries(tierAgg)) console.log(`  ${k}: n=${v.n}  胜率=${pct(v.favWon, v.n)}`);

console.log("\n=== 模块 upsetLevel 档 → 实际爆冷率(热门未胜) ===");
for (const lvl of ["低", "中", "高"]) {
  const v = byLevel[lvl]; if (!v) continue;
  console.log(`  风险${lvl}: n=${v.n}  实际爆冷率=${pct(v.n - v.favWon, v.n)}`);
}

console.log(`\nupsetRisk 平均预测爆冷率=${(100 * riskSum / Math.max(1, riskN)).toFixed(1)}%  实际爆冷率=${(100 * upsetActual / Math.max(1, riskN)).toFixed(1)}%  (越接近越准)`);
console.log("\n联赛分布:", JSON.stringify(byLeague));
