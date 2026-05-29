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

console.log("\n=== 纯 Dixon-Coles 模型核心 walk-forward 命中率 ===");
console.log(`测试日数        : ${res.testDatesUsed}(跳过 ${res.skippedDates} 个训练不足的日)`);
console.log(`测试场次        : ${res.tested}`);
console.log(`胜平负命中率    : ${(res.accuracy * 100).toFixed(1)}%  (随机基线 33%)`);
console.log(`Brier           : ${res.brier}  (越低越好,完美=0)`);
console.log(`RPS             : ${res.rps}`);
console.log(`LogLoss         : ${res.logLoss}`);
console.log(`冷启动预测占比  : ${(res.coldStartPredRate * 100).toFixed(1)}%`);
console.log("\n校准可靠性(预测置信分桶 → 实际命中):");
for (const [k, v] of Object.entries(res.reliability)) {
  if (!v.samples) continue;
  console.log(`  ${k}%: n=${v.samples}, 预测均值=${v.predicted}, 实际=${v.actual}, 偏差=${v.gap}`);
}
console.log(`\n${res.note}`);
