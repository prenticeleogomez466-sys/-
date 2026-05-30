/**
 * λ 量级 + provenance 实时体检(2026-05-31 学习轮 22)
 * ─────────────────────────────────────────────────────────────
 * AG档 λ 闸门的主动体检版:对某日实时推荐逐场核 λ 量级(防比分假数据爆炸)+ provenance
 * (防 data-missing 编造方向)。遵"禁止假编·实时跑通"。用法:node scripts/check-lambda-sanity.mjs [YYYY-MM-DD]
 */
import { recommendFixtures } from "../src/prediction-engine.js";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const rec = recommendFixtures(date);
const preds = rec.predictions || [];
let bad = 0, warn = 0, fabricated = 0, maxTot = 0;
for (const p of preds) {
  const eg = p.dixonColes?.expectedGoals || p.simulation?.lambdas;
  const tot = eg ? (eg.home + eg.away) : null;
  if (tot != null) {
    if (eg.home > 4.0 || eg.away > 4.0 || tot > 5.5) bad++;
    else if (eg.home > 3.3 || eg.away > 3.3 || tot > 4.6) warn++;
    if (tot > maxTot) maxTot = tot;
  }
  const prov = p.provenance || "";
  if (/data-missing|unpredictable|seeded/.test(prov)) fabricated++;
}
console.log(`${date} 实时推荐 ${preds.length} 场 + 未预测剔除 ${(rec.unpredictable || []).length} 场`);
console.log(`λ:爆炸 ${bad} / 偏高警告 ${warn} / 最大总λ ${maxTot.toFixed(2)};provenance 造假/缺失 ${fabricated}`);
const ok = bad === 0 && fabricated === 0;
console.log(ok ? "✅ 体检通过:无λ爆炸假数据、无编造方向,所有进推荐场可追溯真实先验。" : "❌ 发现问题,需排查(λ爆炸或provenance造假)。");
process.exitCode = ok ? 0 : 1;
