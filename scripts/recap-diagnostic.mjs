#!/usr/bin/env node
/**
 * 诊断型复盘 CLI(核心逻辑在 src/recap-diagnostic.js,daily-recap 自动并入 master)。
 * 只读 ledger + market store,绝不改线上数据/模型。
 * 用法:node scripts/recap-diagnostic.mjs [--date=YYYY-MM-DD 仅看某天 | 默认全 ledger]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir, getDataDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { buildRecapDiagnostic } from "../src/recap-diagnostic.js";

const onlyDate = process.argv.find((a) => a.startsWith("--date="))?.slice(7) ?? null;
const ledger = JSON.parse(readFileSync(join(getExportDir(), "recommendation-ledger.json"), "utf8"));
const { stats, perMatch, summaryRows, detailRows } = buildRecapDiagnostic(ledger, { dataDir: getDataDir(), onlyDate });

console.log(`\n═══ 诊断型复盘 ${onlyDate || "全 ledger"} ═══`);
console.log(`已结算(带真实比分):${stats.total}(原始 ${stats.rawCount} 行,去重 ${stats.dupRemoved} 重复推荐)`);
console.log(`\n【1】模型主推 vs 盘口热门 头对头(同 ${stats.bothCount} 场两边都可判)`);
console.log(`   模型主推命中:${stats.modelHit}/${stats.bothCount} = ${stats.modelRate}`);
console.log(`   盘口热门命中:${stats.marketHit}/${stats.bothCount} = ${stats.marketRate}`);
console.log(`   差值(模型-盘口):${stats.edgePp}pp`);
console.log(`\n【2】中了怎么中的(全 ${stats.total} 场):主选 ${stats.primaryHit} · 次选/双选救回 ${stats.secondaryRescue}(双选 ${stats.doubleChanceRescue})· 合计 ${stats.comboRate}`);
console.log(`\n【3】未中归因:`);
for (const [k, v] of Object.entries(stats.missAttr).sort((a, b) => b[1] - a[1])) console.log(`   ${v}场  ${k}`);
console.log(`\n【4】逐场诊断:`);
for (const r of perMatch) {
  console.log(`  ${r.date} ${r.match}(${r.comp})`);
  console.log(`     模型:${r.model}${r.sec ? "/次" + r.sec : ""}${r.dc ? "(双选" + r.dc + ")" : ""} ｜ 盘口热门:${r.marketFav} ${r.marketHit} ｜ 实际:${r.actual} ${r.score} → ${r.hitLevel} ｜ 比分${r.scoreHit} 半全场${r.hfHit}`);
  if (r.miss) console.log(`     未中归因:${r.miss}`);
}

const outDir = join("C:/Users/Administrator/Desktop/足球推荐", new Date().toISOString().slice(0, 10));
try {
  const outPath = join(outDir, `神选-诊断复盘-${onlyDate || "全量"}.xlsx`);
  writeXlsxWorkbook(outPath, [{ name: "复盘诊断汇总", rows: summaryRows }, { name: "逐场诊断", rows: detailRows }]);
  console.log(`\n✅ xlsx: ${outPath}`);
} catch (e) { console.log(`\n⚠️ xlsx 写出失败(不影响控制台诊断): ${e.message}`); }
