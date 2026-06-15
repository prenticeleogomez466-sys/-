#!/usr/bin/env node
// 探针(2026-06-15):recommendation-ledger 已结算行不得残留 pendingReason。
// settled↔"未开赛"自相矛盾即红。exit0=干净;exit1=有残留,拒绝交付。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";
import { findSettledWithPendingResidue } from "../src/result-sanity.js";

const ledgerPath = join(getExportDir(), "recommendation-ledger.json");
if (!existsSync(ledgerPath)) {
  console.log("⏭️ ledger 不存在,跳过(冷启动)");
  process.exit(0);
}
const rows = JSON.parse(readFileSync(ledgerPath, "utf8"));
const bad = findSettledWithPendingResidue(rows);
if (bad.length) {
  console.error(`🔴 ${bad.length} 行已结算却残留 pendingReason(settled↔未开赛自相矛盾):`);
  for (const r of bad.slice(0, 8)) console.error(`  ${r.date} ${r.match}: "${String(r.pendingReason).slice(0, 40)}"`);
  console.error("修复: node scripts/fix-settled-pendingreason-residue.mjs --apply");
  process.exit(1);
}
console.log(`✅ ledger ${rows.length} 行: 无 settled↔pendingReason 矛盾`);
process.exit(0);
