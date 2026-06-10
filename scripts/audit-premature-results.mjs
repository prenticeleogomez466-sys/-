#!/usr/bin/env node
/**
 * store 全量"赛果先于开赛"矛盾自检(2026-06-10 对抗审计 T1 配套告警)。
 *
 * 背景:backfill-results 跳过已有 result 的场(noResult 过滤)→ 假赛果对回填链
 * "不可见、永不自愈";一次性 detox 又只在跑它那一刻清洗。任何写者(授权源 merge/
 * 抓取链)再塞进"未开赛却带 result"的场,会静默沉底直到被某个扫全 store 的消费者
 * 当真消费(wc-recap 下界一改即中)。本脚本提供常驻检测口:
 *
 *   - 扫描域 = fixture store 全部日期文件(listStoreDates,绝不只扫 ledger 日期);
 *   - 判据   = findPrematureResults:有 result 但 hasKickedOff=false
 *              (kickoff 缺失/不可解析也算——无法证明已开赛的 result 不可信);
 *   - 发现矛盾 → 逐条打印 + exit 1(fail-loud,供调度链/人工立刻发现),
 *     处置命令一并给出(node scripts/detox-ledger-2026-06-10.mjs);
 *   - 干净 → exit 0。
 *
 * 只读不写,不做任何"自动修复"(清洗动作集中在 detox 脚本,双备份照旧)。
 * 用法:node scripts/audit-premature-results.mjs
 */
import "../src/env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "../src/fixture-store.js";
import { findPrematureResults, listStoreDates } from "../src/result-sanity.js";

const now = Date.now();
const storeDates = listStoreDates(fixtureDir);
let bad = 0;
const lines = [];

for (const d of storeDates) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(join(fixtureDir, `${d}.json`), "utf8"));
  } catch (e) {
    lines.push(`⚠️ ${d}.json 解析失败(${e.message})——人工核查`);
    bad++;
    continue;
  }
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  for (const f of findPrematureResults(fixtures, now)) {
    bad++;
    lines.push(
      `☠️ ${d} #${f.sequence ?? "?"} ${f.homeTeam ?? f.home ?? "?"} vs ${f.awayTeam ?? f.away ?? "?"} ` +
      `kickoff=${JSON.stringify(f.kickoff ?? "")} 却已有 result=${f.result?.home}-${f.result?.away}(未开赛口径下不可信)`
    );
  }
}

console.log(`store 矛盾自检:扫描 ${storeDates.length} 个日期文件(全目录)`);
if (bad > 0) {
  for (const l of lines) console.error(l);
  console.error(`\n☠️ 发现 ${bad} 条"赛果先于开赛"矛盾——假赛果/错配嫌疑,backfill 不会自愈。`);
  console.error(`   处置:node scripts/detox-ledger-2026-06-10.mjs --dry 先核,再去 --dry 实清洗(双备份)。`);
  process.exit(1);
}
console.log("✅ 无矛盾:store 全部日期文件满足『开赛前无赛果』不变量。");
