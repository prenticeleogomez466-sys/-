#!/usr/bin/env node
// 生成联赛可信度 profile:跑 no-odds walk-forward 回测,把各联赛 DC 命中率落成
// league-reliability.json,供 daily-report 对弱联赛的下注分级降级/加⚠️。
// 数据驱动、诚实:样本<20 标 reliable:false,生产只对『可靠且明显偏弱』的联赛降级。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runWalkForwardBacktest } from "../src/walkforward-backtest.js";
import { getProfilesDir } from "../src/paths.js";

const args = process.argv.slice(2);
const getNum = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };

console.log("回测中(收集各联赛命中率)...");
const res = runWalkForwardBacktest({ testDates: getNum("--test-dates", 50) });
const leagues = {};
for (const l of res.byLeague || []) {
  leagues[l.league] = { accuracy: l.accuracy, total: l.total, hit: l.hit, reliable: l.reliable };
}
const profile = {
  usable: true,
  source: "no-odds walk-forward DC arm",
  testDatesUsed: res.testDatesUsed,
  weakThreshold: 0.42, // 可靠且命中<此值 → 弱联赛(降级)
  leagues
};
// 2026-06-10 缺陷#14:profile 迁出 exports 根(16:01 计划任务清空史)→ 持久 profiles 目录。
mkdirSync(getProfilesDir(), { recursive: true });
const p = join(getProfilesDir(), "league-reliability.json");
writeFileSync(p, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

console.log(`\n✅ 已写 → ${p}`);
const weak = Object.entries(leagues).filter(([, v]) => v.reliable && v.accuracy < profile.weakThreshold).map(([k, v]) => `${k}(${(v.accuracy * 100).toFixed(0)}%)`);
console.log(`弱联赛(可靠样本且命中<${profile.weakThreshold * 100}%,将在下注分级降级):${weak.length ? weak.join(", ") : "无"}`);
