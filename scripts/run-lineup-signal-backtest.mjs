#!/usr/bin/env node
/**
 * 跑 lineup 信号增益回测。先 npm run backfill:formations 回填数据。
 * 用法:npm run backtest:lineup
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeLineupSignal } from "../src/lineup-signal-backtest.js";
import { getDataSubdir } from "../src/paths.js";

const cachePath = join(getDataSubdir("formations"), "espn-formations.json");
if (!existsSync(cachePath)) {
  console.error(`未找到回填数据 ${cachePath}\n先跑:npm run backfill:formations -- --from 2026-01-01 --to 2026-05-31`);
  process.exit(1);
}
const cache = JSON.parse(readFileSync(cachePath, "utf8"));
const records = Object.values(cache.records ?? {});
const rep = analyzeLineupSignal(records);
if (!rep.ok) { console.error("回测失败:", rep.reason); process.exit(1); }

console.log("═".repeat(64));
console.log("Lineup 信号增益回测(ESPN 历史首发 + 真实赛果)");
console.log("═".repeat(64));
console.log(`样本:${rep.sampleSize} 场 | 全局 3 路:主 ${rep.globalRates.home} / 平 ${rep.globalRates.draw} / 客 ${rep.globalRates.away}`);
console.log("");
console.log("① 方向验证(平局轴)");
const d = rep.direction.bothDefensive, a = rep.direction.bothAttacking;
console.log(`  双摆防:${d.n} 场,平局率 ${d.drawRate}(95%CI ${d.ci.lo}~${d.ci.hi}),对全局 ${d.vsGlobalDraw >= 0 ? "+" : ""}${d.vsGlobalDraw} → ${d.confirmed ? "✅显著高" : "未显著"}`);
console.log(`  双压上:${a.n} 场,平局率 ${a.drawRate}(95%CI ${a.ci.lo}~${a.ci.hi}),对全局 ${a.vsGlobalDraw >= 0 ? "+" : ""}${a.vsGlobalDraw} → ${a.confirmed ? "✅显著低" : "未显著"}`);
console.log(`  中性(不 fire):${rep.direction.neutralN} 场`);
console.log("");
console.log("② 概率增益(fire 子集,baseline=全局经验 base rate,保守对照)");
const g = rep.probabilisticGain;
console.log(`  fire:${g.firedN} 场(${(g.firedRate * 100).toFixed(1)}%)`);
console.log(`  LogLoss:baseline ${g.logLoss.baseline} → signal ${g.logLoss.signal}(Δ ${g.logLoss.delta >= 0 ? "+" : ""}${g.logLoss.delta},越负越好)`);
console.log(`  Brier  :baseline ${g.brier.baseline} → signal ${g.brier.signal}(Δ ${g.brier.delta >= 0 ? "+" : ""}${g.brier.delta})`);
console.log("");
console.log("裁决:", rep.verdict);
console.log("═".repeat(64));
