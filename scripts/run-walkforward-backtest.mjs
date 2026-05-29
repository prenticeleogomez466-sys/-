#!/usr/bin/env node
import { runWalkForwardBacktest } from "../src/walkforward-backtest.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};

console.log("Walk-forward 回测中(按时间前向、防数据泄漏)...");
const res = runWalkForwardBacktest({
  testDates: getNum("--test-dates", 50),
  minTrainMatches: getNum("--min-train", 200),
  maxDates: getNum("--max-dates", 240)
});

console.log("\n=== Walk-forward 三臂对比 ===");
console.log(`测试日数 ${res.testDatesUsed}(跳过 ${res.skippedDates})| 测试场次 ${res.tested} | 融合 fire 率 ${(res.fusionAppliedRate * 100).toFixed(1)}%\n`);
const arms = [
  ["A 纯 DC          ", res.arms.dc],
  ["B +信号融合      ", res.arms.fusion],
  ["C +校准(65%+收缩)", res.arms.calibrated]
];
console.log("臂                  命中率    Brier    RPS     LogLoss");
for (const [label, a] of arms) {
  console.log(`${label}  ${(a.accuracy * 100).toFixed(1)}%   ${a.brier.toFixed(4)}  ${a.rps.toFixed(4)}  ${a.logLoss.toFixed(4)}`);
}
const dA = res.arms.dc, dB = res.arms.fusion, dC = res.arms.calibrated;
console.log(`\n边际:融合命中率 ${((dB.accuracy - dA.accuracy) * 100).toFixed(2)}pp,RPS ${(dB.rps - dA.rps).toFixed(4)};校准再 ${((dC.accuracy - dB.accuracy) * 100).toFixed(2)}pp,RPS ${(dC.rps - dB.rps).toFixed(4)}`);

console.log("\n65%+ 强热门校准(治过度自信):");
for (const [label, a] of arms) {
  const b = a.reliability["65-101"];
  if (b?.samples) console.log(`  ${label}: n=${b.samples}, 预测=${b.predicted}, 实际=${b.actual}, 偏差=${b.gap}`);
}
console.log(`\n${res.note}`);
