#!/usr/bin/env node
/**
 * 训练 calibration profile 并写盘(W 档)。
 * 用法:
 *   npm run calibration:train                      # 默认全量五大联赛×3赛季
 *   npm run calibration:train -- --start 2024-01-01  # 只用此日期后做测试集(加速)
 *   npm run calibration:train -- --refit 14 --dry    # 14 天重拟合一次,只看不写盘
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { trainCalibrationProfile } from "../src/calibration-trainer.js";
import { getExportDir } from "../src/paths.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getStr = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const getNum = (f, d) => { const v = getStr(f, null); return v == null ? d : Number(v); };

const profilePath = join(getExportDir(), "backtest-calibration-profile.json");
const dryRun = has("--dry");

console.log("训练 calibration profile(football-data.co.uk walk-forward,leak-safe)...");
const res = await trainCalibrationProfile({
  startDate: getStr("--start", null),
  refitEvery: getNum("--refit", 7),
  minTrainMatches: getNum("--min-train", 400),
  maxTrainMatches: getNum("--max-train", 2000),
  minSamples: getNum("--min-samples", 200)
});

if (!res.ok) { console.error("失败:", res.reason); process.exit(1); }

const p = res.profile;
console.log(`\n数据:${res.loaded.matches} 场(含赔率 ${res.loaded.withOdds})`);
console.log(`测试日 ${p.meta.testDatesUsed}(跳过 ${p.meta.skippedDates})| DC 样本 ${p.meta.dcSamples} | 市场样本 ${p.meta.marketSamples} | refit 每 ${p.meta.refitEvery} 天`);
console.log(`usable: ${p.usable}(${p.reason})`);

function printReliability(title, rel) {
  console.log(`\n${title} 分桶可靠性(预测 vs 实际命中,gap 负=过度自信):`);
  for (const [k, v] of Object.entries(rel)) {
    if (v.samples) console.log(`  ${k.padEnd(7)} n=${String(v.samples).padStart(4)}  预测=${v.predicted}  实际=${v.actual}  gap=${v.gap}`);
  }
}
printReliability("纯模型(isotonicMap)", p.reliability);
printReliability("市场先验 blend(isotonicMapMarket)", p.marketReliability);

console.log(`\nisotonic 映射:模型路径 ${p.isotonicMap ? p.isotonicMap.knots.length + " knots / " + p.isotonicMap.samples + " 样本" : "未训练(样本不足)"}`);
console.log(`             市场路径 ${p.isotonicMapMarket ? p.isotonicMapMarket.knots.length + " knots / " + p.isotonicMapMarket.samples + " 样本" : "未训练(样本不足)"}`);

if (dryRun) {
  console.log("\n[--dry] 仅预览,未写盘。");
  process.exit(0);
}
if (!p.usable) {
  console.error("\nprofile 不可用(样本不足),拒绝覆盖线上文件。");
  process.exit(1);
}

p.generatedAt = new Date().toISOString();
if (existsSync(profilePath)) {
  const bak = profilePath.replace(/\.json$/, `.bak.json`);
  copyFileSync(profilePath, bak);
  console.log(`\n已备份旧 profile → ${bak}`);
}
writeFileSync(profilePath, JSON.stringify(p, null, 2), "utf8");
console.log(`已写入 ${profilePath}`);
