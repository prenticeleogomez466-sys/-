#!/usr/bin/env node
// 选择性推荐 hit-vs-coverage 曲线:用真市场赔率回测的 blend 臂(=生产有 prior 时的行为),
// 量化「只推 top-prob ≥ 阈值 的比赛」时,推荐命中率随覆盖率的权衡。
// 诚实用途:命中率越高 → 能推的场次越少。帮你定一个下注阈值,而不是盲目全推。
import { runWalkForwardWithOdds } from "../src/walkforward-backtest-odds.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };

console.log("选择性推荐曲线回测中(football-data 真赔率,blend 臂)...");
const res = await runWalkForwardWithOdds({
  testDates: getNum("--test-dates", 40),
  leagues: args.includes("--leagues") ? args[args.indexOf("--leagues") + 1].split(",") : undefined
});
if (!res.ok) { console.log("回测失败:", res.reason); process.exit(1); }

const sc = res.selectiveCoverage;
const blend = res.arms.blend;
console.log(`\n=== 选择性推荐 hit-vs-coverage(blend 臂,${sc.total} 场带赔率)===`);
console.log(`全推(覆盖100%)命中率基线:${(blend.accuracy * 100).toFixed(1)}%\n`);
console.log("阈值(top-prob≥)  推荐场次   覆盖率    推荐命中率");
for (const r of sc.curve) {
  const hit = r.hitRate == null ? "—" : `${(r.hitRate * 100).toFixed(1)}%`;
  console.log(`  ≥${(r.threshold * 100).toFixed(0)}%`.padEnd(16) + `${r.recommended}`.padEnd(11) + `${(r.coverage * 100).toFixed(1)}%`.padEnd(10) + hit);
}
console.log("\n读法:阈值↑ → 推荐命中率↑ 但覆盖率(能推几场)↓。挑一个你能接受的覆盖率换取更高命中率。");
console.log("诚实:全覆盖命中率天花板≈市场赔率水平(~55%);想更高只能少推高把握场。");
