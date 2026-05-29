#!/usr/bin/env node
import { runLineMovementBacktest } from "../src/line-movement-backtest.js";

console.log("盘口移动回测中(football-data.co.uk 开盘 vs 收盘)...");
const res = await runLineMovementBacktest({ steamThreshold: 0.03 });
if (!res.ok) { console.error("失败:", res.reason); process.exit(1); }

console.log(`\n数据:${res.loadedMatches} 场 | 含收盘 ${res.withClosing} | 含 Pinnacle ${res.withPinnacle} | 开+收齐全 ${res.bothOpenClose}\n`);
console.log("臂              命中率    Brier    LogLoss   n");
const order = [
  ["开盘均赔        ", res.arms.open],
  ["收盘均赔        ", res.arms.close],
  ["Pinnacle 开盘   ", res.arms.pinnacleOpen],
  ["Pinnacle 收盘   ", res.arms.pinnacleClose]
];
for (const [label, a] of order) {
  console.log(`${label}  ${(a.accuracy * 100).toFixed(1)}%   ${a.brier.toFixed(4)}  ${a.logLoss.toFixed(4)}  ${a.tested}`);
}

const dAcc = (res.arms.close.accuracy - res.arms.open.accuracy) * 100;
const dBrier = res.arms.close.brier - res.arms.open.brier;
console.log(`\n收盘 vs 开盘:命中率 ${dAcc >= 0 ? "+" : ""}${dAcc.toFixed(2)}pp,Brier ${dBrier >= 0 ? "+" : ""}${dBrier.toFixed(4)}(负=收盘更准)`);

const s = res.steam;
console.log(`\n盘口移动预测力(总移动 ≥ ${s.threshold},${s.matches} 场显著 steam):`);
console.log(`  跟随盘口移动方向命中率: ${s.steamOutcomeHitRate != null ? (s.steamOutcomeHitRate * 100).toFixed(1) + "%" : "n/a"}`);
console.log(`  开盘 favorite 命中率:   ${s.openFavoriteHitRate != null ? (s.openFavoriteHitRate * 100).toFixed(1) + "%" : "n/a"}`);
console.log(`  steam 方向与开盘 fav 一致: ${s.steamAgreesWithOpenFavRate != null ? (s.steamAgreesWithOpenFavRate * 100).toFixed(1) + "%" : "n/a"}`);
console.log(`\n${res.note}`);
