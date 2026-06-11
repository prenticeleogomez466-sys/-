#!/usr/bin/env node
/**
 * store 全量"同场跨文件比分矛盾"自检(2026-06-11 ledger-settlement-2 / store-hygiene-2 复发探针)。
 *
 * 背景:同一场物理比赛会出现在多个业务日的 store 文件里(14场公告期/竞彩在售期各留一份副本)。
 * 06-10 事故同源残留:sporttery 公告页错配把"摩洛哥4-0挪威"等假赛果写进 06-02..06-05 四份副本,
 * 而真值 1-1 只回填进 06-06/06-07 份 ⇒ 同场比分互斥共存。这类坏值:
 *   - kickoff 已过 → audit-premature-results.mjs("未开赛带 result"不变量)永远抓不到;
 *   - backfill-results 跳过已有 result → 永不自愈;
 *   - dixon-coles fitFromFixtureStore 全量吃 store → 假赛果 4 倍灌入拟合(挪威 attack 被压到 0.35)。
 *
 * 本脚本提供常驻检测口(只读不写,fail-loud):
 *   - 扫描域 = fixture store 全部日期文件(listStoreDates);
 *   - 判据   = findCrossFileResultConflicts:同(真实赛日|主|客)键下已结算比分集合 size>1;
 *   - 发现矛盾 → 逐组打印 + exit 1;干净 → exit 0。
 *   - 处置:node scripts/detox-store-conflicts-2026-06-11.mjs --dry 先核(ESPN 权威源仲裁),再去 --dry 实清洗。
 *
 * 用法:node scripts/audit-store-result-conflicts.mjs
 */
import "../src/env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir } from "../src/fixture-store.js";
import { findCrossFileResultConflicts, listStoreDates } from "../src/result-sanity.js";

const storeDates = listStoreDates(fixtureDir);
const entries = [];
let parseFail = 0;

for (const d of storeDates) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(join(fixtureDir, `${d}.json`), "utf8"));
  } catch (e) {
    console.error(`⚠️ ${d}.json 解析失败(${e.message})——人工核查`);
    parseFail++;
    continue;
  }
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  for (const f of fixtures) entries.push({ storeDate: d, fixture: f });
}

const conflicts = findCrossFileResultConflicts(entries);
console.log(`store 跨文件比分矛盾自检:扫描 ${storeDates.length} 个日期文件 / ${entries.length} 行`);

if (conflicts.length > 0 || parseFail > 0) {
  for (const c of conflicts) {
    console.error(`⚔️ ${c.key} 比分互斥 {${c.scores.join(" vs ")}}:`);
    for (const cp of c.copies) {
      console.error(`    ${cp.storeDate} → ${cp.score}  [${cp.competition ?? "?"}]  ${String(cp.source ?? "").slice(0, 60)}`);
    }
  }
  console.error(`\n☠️ 发现 ${conflicts.length} 组同场跨文件比分矛盾——至少一份是假赛果/错配,DC 拟合/球队画像正在消费。`);
  console.error(`   处置:node scripts/detox-store-conflicts-2026-06-11.mjs --dry 先核(ESPN 仲裁),再去 --dry 实清洗(带备份)。`);
  process.exit(1);
}
console.log("✅ 无矛盾:store 全部日期文件满足『同场跨文件比分一致』不变量。");
