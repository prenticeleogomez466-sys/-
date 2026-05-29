#!/usr/bin/env node
import { runWalkForwardWithOdds } from "../src/walkforward-backtest-odds.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };

console.log("赔率版 walk-forward 回测中(football-data.co.uk,实战级全融合)...");
const res = await runWalkForwardWithOdds({
  testDates: getNum("--test-dates", 40),
  minTrainMatches: getNum("--min-train", 300),
  maxTrainMatches: getNum("--max-train", 1500)
});

if (!res.ok) { console.error("失败:", res.reason); process.exit(1); }

console.log(`\n数据:${res.loadedMatches} 场(含赔率 ${res.withOdds})| 联赛 ${JSON.stringify(res.byLeague)}`);
console.log(`测试日 ${res.testDatesUsed}(跳过 ${res.skippedDates})| 无赔率场次 ${res.noOddsMatches} | 融合 fire 率 ${(res.fusionAppliedRate * 100).toFixed(1)}% | 盘口移动 fire 率 ${((res.lineMoveFiredRate ?? 0) * 100).toFixed(1)}%\n`);

const order = [
  ["market 市场赔率   ", res.arms.market],
  ["dc 纯模型         ", res.arms.dc],
  ["blend 赔率+DC     ", res.arms.blend],
  ["blend+融合        ", res.arms.blendFusion],
  ["blend+融合+校准   ", res.arms.blendFusionCal],
  ["+盘口移动(开→收) ", res.arms.blendFusionLineMove]
];
console.log("臂                  命中率    Brier    RPS     LogLoss   n");
for (const [label, a] of order) {
  console.log(`${label}  ${(a.accuracy * 100).toFixed(1)}%   ${a.brier.toFixed(4)}  ${a.rps.toFixed(4)}  ${a.logLoss.toFixed(4)}  ${a.tested}`);
}

const mk = res.arms.market, bf = res.arms.blendFusionCal;
console.log(`\n对市场基准:命中率 ${((bf.accuracy - mk.accuracy) * 100).toFixed(2)}pp,RPS ${(bf.rps - mk.rps).toFixed(4)}(RPS 负=比市场好)`);
console.log("\n65%+ 强热门校准:");
for (const [label, a] of order) {
  const b = a.reliability["65-101"];
  if (b?.samples) console.log(`  ${label}: n=${b.samples}, 预测=${b.predicted}, 实际=${b.actual}, 偏差=${b.gap}`);
}
console.log(`\n${res.note}`);
