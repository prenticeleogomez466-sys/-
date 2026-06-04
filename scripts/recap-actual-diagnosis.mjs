/**
 * 近期实际命中率诊断(2026-06-04,用户「按近期实际命中率调整升级」)。
 * 读生产 recommendation-ledger 已结算行,按【玩法 × 联赛 × 信心档 × 赔率热度】拆解真实命中,
 * 定位系统性弱点。纯只读聚合,不改模型;产出驱动 league-reliability 降权与诚实诊断。
 * 用法:node scripts/recap-actual-diagnosis.mjs [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "../src/paths.js";

const LEDGER = join(getExportDir(), "recommendation-ledger.json");
const raw = JSON.parse(readFileSync(LEDGER, "utf8"));
const rows = (Array.isArray(raw) ? raw : raw.rows || []).filter((x) => x.actualStatus === "settled");
const rate = (arr, k) => (arr.length ? +(100 * arr.filter((x) => x[k] === true).length / arr.length).toFixed(1) : null);
const group = (keyFn) => { const m = {}; for (const x of rows) (m[keyFn(x)] ??= []).push(x); return m; };

console.log(`=== 近期实际结算 ${rows.length} 场(${rows[0]?.date} ~ ${rows[rows.length - 1]?.date})===`);
const hfCov = +(100 * rows.filter((x) => x.actualHalfFull).length / rows.length).toFixed(1);
console.log(`1X2主选 ${rate(rows, "hit")}% | 1X2次选 ${rate(rows, "secondaryHit")}% | 比分主选 ${rate(rows, "scoreHit")}% | 半全场 ${rate(rows, "halfFullHit")}%(半场数据覆盖${hfCov}%)| 让球胜平负 ${rate(rows, "handicapWldHit")}%`);
if (hfCov < 20) console.log(`⚠️ 半场比分覆盖仅 ${hfCov}% → 半全场玩法无法判定(免费赛果源不带 HT,测量盲区非模型差)。`);

console.log(`\n按联赛 1X2 命中(样本≥8,升序):`);
const byLg = group((x) => x.competition);
Object.entries(byLg).filter(([, v]) => v.length >= 8).sort((a, b) => rate(a[1], "hit") - rate(b[1], "hit"))
  .forEach(([k, v]) => console.log(`  ${k.padEnd(8)} ${rate(v, "hit")}% (${v.filter((x) => x.hit).length}/${v.length})`));

console.log(`\n按信心档 tier 1X2 命中(验证选择性是否真有效):`);
const byT = group((x) => x.tier || "?");
Object.entries(byT).sort((a, b) => (a[1].reduce((s, x) => s + (x.confidence || 0), 0) / a[1].length) - (b[1].reduce((s, x) => s + (x.confidence || 0), 0) / b[1].length))
  .forEach(([k, v]) => console.log(`  ${String(k).padEnd(14)} ${rate(v, "hit")}% (${v.length}场,均信心${(v.reduce((s, x) => s + (x.confidence || 0), 0) / v.length).toFixed(0)})`));

const outArg = process.argv.indexOf("--json");
if (outArg >= 0 && process.argv[outArg + 1]) {
  const out = { settled: rows.length, overall: { wld: rate(rows, "hit"), score: rate(rows, "scoreHit"), halfFull: rate(rows, "halfFullHit"), halfFullCoverage: hfCov },
    byLeague: Object.fromEntries(Object.entries(byLg).map(([k, v]) => [k, { n: v.length, wld: rate(v, "hit") }])),
    byTier: Object.fromEntries(Object.entries(byT).map(([k, v]) => [k, { n: v.length, wld: rate(v, "hit") }])) };
  writeFileSync(process.argv[outArg + 1], JSON.stringify(out, null, 1));
  console.log(`\n已写 ${process.argv[outArg + 1]}`);
}
