#!/usr/bin/env node
/**
 * 诊断型复盘 CLI(核心逻辑在 src/recap-diagnostic.js,daily-recap 自动并入 master)。
 * 只读 ledger + market store,绝不改线上数据/模型。
 * 用法:node scripts/recap-diagnostic.mjs [--date=YYYY-MM-DD 仅看某天 | 默认全 ledger]
 */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getExportDir, getDataDir } from "../src/paths.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { buildRecapDiagnostic } from "../src/recap-diagnostic.js";
import { decomposeMatch, minePatterns, mineConditionalOutcomes } from "../src/recap-decomposition.js";

const onlyDate = process.argv.find((a) => a.startsWith("--date="))?.slice(7) ?? null;
const ledger = JSON.parse(readFileSync(join(getExportDir(), "recommendation-ledger.json"), "utf8"));
const { stats, perMatch, summaryRows, detailRows } = buildRecapDiagnostic(ledger, { dataDir: getDataDir(), onlyDate });

// ── 深度信息拆解 + 跨场规律(2026-06-15:复盘不光看命中率,拆所有信息维度+找规律指导下次) ──
const settledForDecomp = (() => {
  const raw = ledger.filter((r) => (r.actualStatus === "settled" || r.actual) && r.actualScore && r.primary && (!onlyDate || r.date === onlyDate));
  const dedup = new Map();
  for (const r of [...raw].sort((a, b) => String(a.date).localeCompare(String(b.date)))) dedup.set(`${r.match}|${r.actualScore}`, r);
  return [...dedup.values()];
})();
const decomp = settledForDecomp.map(decomposeMatch);
const pat = minePatterns(settledForDecomp);
const cond = mineConditionalOutcomes(settledForDecomp);

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

console.log(`\n【5】跨场规律(🔶观测性·样本n;基线命中 ${pat.baseHit ?? "—"}%·n≥${pat.minN}):`);
if (!pat.patterns.length) console.log(`   样本不足(已结算 ${pat.n} 场,各桶均 < ${pat.minN})——规律待样本积累,诚实不强行下结论`);
for (const p of pat.patterns) console.log(`   [${p.dim}] ${p.condition}:命中 ${p.hitRate}%(n=${p.n})${p.lift != null ? ` ｜ vs基线 ${p.lift > 0 ? "+" : ""}${p.lift}pp` : ""}`);
console.log(`   实际平局占比 ${pat.drawRate}% vs 模型主推平局 ${pat.modelDrawPick}%(平局盲区实证)`);

console.log(`\n【6】条件→大概率结果(🔶观测分布·样本n;基线 主${cond.base.homePct ?? "—"}/平${cond.base.drawPct ?? "—"}/客${cond.base.awayPct ?? "—"}%):`);
for (const b of cond.buckets) console.log(`   [${b.dim}] ${b.condition}(n=${b.n}):大概率→${b.likely} ｜ 主${b.homePct}/平${b.drawPct}/客${b.awayPct}% ｜ 大球${b.over25Pct}%·BTTS${b.bttsPct}%${b.homeCoverPct != null ? `·主过盘${b.homeCoverPct}%` : ""}`);
if (!cond.buckets.length) console.log(`   各条件桶样本均 < ${cond.minN},结果分布待积累(诚实不强行归纳)`);
console.log(`   ⚠️待积累维(历史ledger未持久化,快照入库后可挖):${cond.pendingDims.join("、")}`);

// 深度信息拆解 sheet
const decompRows = [["📊 深度信息拆解 · 每场每维信号是否指向真实结果(✅实测/🔶推断/⚠️缺;战意/阵容/战术/亚盘水位未入历史ledger→标缺,非未查)"],
  ["日期", "对阵", "赛事", "主推", "维度", "标签", "信号", "判定", "因果/备注"]];
for (const m of decomp) {
  for (const d of m.dims) decompRows.push([m.date, m.match, m.comp, m.primaryHit ? "✅中" : "❌没", d.dim, d.tag, d.signal, d.verdict, d.note]);
  decompRows.push(["", "", "", "", "🔗因果综述", "", "", "", m.synthesis]);
}
if (decomp.length === 0) decompRows.push(["(暂无已结算场可拆解)"]);

// 跨场规律 sheet
const patRows = [["🧭 跨场规律挖掘 · 什么共性/变化→什么结果(🔶观测性·带样本n·未经leak-safe回测不当预测edge)"],
  [`已结算 ${pat.n} 场 · 基线命中 ${pat.baseHit ?? "—"}% · 最小样本门槛 n≥${pat.minN}`],
  ["维度", "条件", "样本n", "命中率%", "基线%", "lift(pp,越正越优)"]];
for (const p of pat.patterns) patRows.push([p.dim, p.condition, p.n, p.hitRate ?? "—", p.base ?? "—", p.lift != null ? (p.lift > 0 ? `+${p.lift}` : `${p.lift}`) : "—"]);
if (!pat.patterns.length) patRows.push(["(各桶样本均不足 n≥" + pat.minN + ",规律待积累——诚实不强行归纳)"]);
patRows.push([""], ["诚实声明", pat.note]);

// 条件→结果分布 sheet(什么盘口/让球/赔率变化→大概率什么结果)
const condRows = [["🎯 条件→大概率结果 · 什么盘口/让球/赔率变化→实际结果分布(🔶观测·带样本n·非预测edge)"],
  [`已结算 ${cond.n} 场 · 基线 主${cond.base.homePct ?? "—"}%/平${cond.base.drawPct ?? "—"}%/客${cond.base.awayPct ?? "—"}% · 大球${cond.base.over25Pct ?? "—"}% · n≥${cond.minN}`],
  ["维度", "条件", "样本n", "大概率结果", "主胜%", "平局%", "客胜%", "大2.5球%", "BTTS%", "主队过盘%", "场均总进"]];
for (const b of cond.buckets) condRows.push([b.dim, b.condition, b.n, b.likely, b.homePct, b.drawPct, b.awayPct, b.over25Pct, b.bttsPct, b.homeCoverPct ?? "—", b.avgGoals]);
if (!cond.buckets.length) condRows.push(["(各条件桶样本均不足,结果分布待积累——诚实不强行归纳)"]);
condRows.push([""], ["⚠️待积累维(历史ledger未持久化→需快照入库累积后才能挖,现标缺不编)", cond.pendingDims.join(" / ")]);
condRows.push(["诚实声明", cond.note]);

const outDir = join("C:/Users/Administrator/Desktop/足球推荐", new Date().toISOString().slice(0, 10));
try {
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `神选-诊断复盘-${onlyDate || "全量"}.xlsx`);
  writeXlsxWorkbook(outPath, [
    { name: "复盘诊断汇总", rows: summaryRows },
    { name: "逐场诊断", rows: detailRows },
    { name: "深度信息拆解", rows: decompRows },
    { name: "跨场规律", rows: patRows },
    { name: "条件→结果分布", rows: condRows },
  ]);
  console.log(`\n✅ xlsx: ${outPath}`);
} catch (e) { console.log(`\n⚠️ xlsx 写出失败(不影响控制台诊断): ${e.message}`); }
