/**
 * 一次性订正(2026-06-15):清除已结算行残留的 pendingReason 字段。
 * ──────────────────────────────────────────────
 * 根因:daily-recap.js 结算成功时 settled={...row} 把上一次未开赛时写的 pendingReason
 *   原样带进 settled 行 → "已结算却显示未开赛"自相矛盾残留(已在源头修:settled 显式
 *   置 pendingReason:undefined)。本脚本订正历史已落盘的残留行。
 *
 * 安全:只 delete pendingReason,绝不碰 actual/actualScore/hit 等真实赛果字段。
 * 默认 dry-run;加 --apply 才写盘,并先备份。
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";

const apply = process.argv.includes("--apply");
const ledgerPath = join(getExportDir(), "recommendation-ledger.json");
const rows = JSON.parse(readFileSync(ledgerPath, "utf8"));

const isSettled = (r) => r.actualStatus === "settled" || Boolean(r.actual);
const targets = rows.filter((r) => isSettled(r) && typeof r.pendingReason === "string" && r.pendingReason.trim());

console.log(`总行: ${rows.length} | 已结算: ${rows.filter(isSettled).length} | 已结算却带 pendingReason 残留: ${targets.length}`);
for (const r of targets.slice(0, 5)) {
  console.log(`  ${r.date} ${r.match} | actual=${r.actual} score=${r.actualScore} hit=${r.hit} | 待清: "${(r.pendingReason || "").slice(0, 36)}"`);
}
if (targets.length > 5) console.log(`  …其余 ${targets.length - 5} 行`);

if (!apply) {
  console.log("\n[dry-run] 未写盘。加 --apply 执行(会先备份)。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${ledgerPath}.bak-${stamp}`;
copyFileSync(ledgerPath, backup);
let cleaned = 0;
for (const r of rows) {
  if (isSettled(r) && typeof r.pendingReason === "string") { delete r.pendingReason; cleaned++; }
}
writeFileSync(ledgerPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`\n✅ 已清 ${cleaned} 行残留 pendingReason(赛果字段未动)。备份: ${backup}`);
