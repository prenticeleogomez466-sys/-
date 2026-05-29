#!/usr/bin/env node
import { runSignalAblation } from "../src/walkforward-backtest.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};

console.log("逐信号消融回测中(leave-one-out,只复用一次 DC 拟合/日)...");
const res = runSignalAblation({
  testDates: getNum("--test-dates", 50),
  minTrainMatches: getNum("--min-train", 200),
  maxDates: getNum("--max-dates", 240)
});

console.log(`\n=== 信号消融:边际贡献(测试日 ${res.testDatesUsed} | 场次 ${res.tested})===`);
console.log(`全融合基线:命中 ${(res.full.accuracy * 100).toFixed(1)}%  Brier ${res.full.brier}  LogLoss ${res.full.logLoss}\n`);
console.log("信号                fire数  命中Δ    BrierΔ    LogLossΔ   裁决");
console.log("(Δ=关掉后−它fire时;BrierΔ>0=该信号有用,<0=在害校准)");
for (const s of res.signals) {
  const f = (v, w = 8) => (v >= 0 ? "+" : "") + String(v).padEnd(w);
  console.log(
    `${s.signal.padEnd(20)}${String(s.firedSamples).padEnd(7)}${f((s.hitDelta * 100).toFixed(1) + "pp")}${f(s.brierDelta)}${f(s.logLossDelta)}${s.verdict}`
  );
}
const hurts = res.signals.filter((s) => s.verdict === "HURTS");
if (hurts.length) {
  console.log(`\n⚠️ 害校准的信号(建议弱化/剔除):${hurts.map((s) => s.signal).join(", ")}`);
} else {
  console.log("\n✅ 无明显害校准信号。");
}
