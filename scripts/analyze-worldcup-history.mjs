#!/usr/bin/env node
/**
 * 世界杯历史样本统计分析(过夜进化轮2+,leak-safe 纯描述统计,不改任何数据)。
 * 读库内已回填的 worldcup-history 真实赛果(1930-2022,964 场),算:
 *   - 每届场均进球 / 平局率(90分钟)
 *   - 三时代(草创1930-58 / 防守1962-90 / 现代1994-2022)聚合 → 确认 2026 进球基线
 *   - 分阶段(小组 vs 淘汰)场均进球比 + 平局率差
 *   - 半场样本 halfRatio(有 ht 的场)
 * 用法: node scripts/analyze-worldcup-history.mjs
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

const rows = [];
for (const date of listFixtureDates()) {
  const doc = loadFixtures(date);
  if (doc.source !== "worldcup-history") continue;
  for (const f of doc.fixtures) {
    const r = f.result || {};
    const h = Number(r.home), a = Number(r.away);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    const m = /世界杯(\d{4})/.exec(f.competition || "");
    const year = m ? Number(m[1]) : null;
    if (!year) continue;
    rows.push({
      year, stage: f.round || "?", h, a, tot: h + a,
      draw: h === a ? 1 : 0,
      // 注意:Number(null)=0 会假阳性,必须先排除 null/undefined/''(只 256 场真有 ht)
      hh: (r.halfHome == null || r.halfHome === "") ? null : (Number.isFinite(Number(r.halfHome)) ? Number(r.halfHome) : null),
      ha: (r.halfAway == null || r.halfAway === "") ? null : (Number.isFinite(Number(r.halfAway)) ? Number(r.halfAway) : null),
    });
  }
}

const agg = (list) => {
  const n = list.length;
  if (!n) return { n: 0 };
  const g = list.reduce((s, r) => s + r.tot, 0);
  const d = list.reduce((s, r) => s + r.draw, 0);
  return { n, gpg: +(g / n).toFixed(3), drawPct: +((d / n) * 100).toFixed(1) };
};

console.log(`══════ 世界杯历史样本统计(库内 ${rows.length} 场)══════\n`);

// 每届
console.log("【每届场均进球 / 平局率】");
const years = [...new Set(rows.map((r) => r.year))].sort();
for (const y of years) {
  const s = agg(rows.filter((r) => r.year === y));
  console.log(`  ${y}: ${String(s.n).padStart(2)}场  场均${s.gpg}  平局${s.drawPct}%`);
}

// 三时代
console.log("\n【三时代聚合】");
const eras = [
  ["草创 1930-58", (y) => y <= 1958],
  ["防守 1962-90", (y) => y >= 1962 && y <= 1990],
  ["现代 1994-2022", (y) => y >= 1994],
];
for (const [name, f] of eras) {
  const s = agg(rows.filter((r) => f(r.year)));
  console.log(`  ${name}: ${s.n}场  场均${s.gpg}  平局${s.drawPct}%`);
}

// 分阶段(现代期 1994-2022,避免草创期污染)
console.log("\n【现代期(1994-2022)分阶段】");
const modern = rows.filter((r) => r.year >= 1994);
const groupS = agg(modern.filter((r) => r.stage === "group"));
const koStages = ["r16", "qf", "sf", "final", "knockout", "third"];
const koS = agg(modern.filter((r) => koStages.includes(r.stage)));
console.log(`  小组赛 : ${groupS.n}场  场均${groupS.gpg}  平局${groupS.drawPct}%`);
console.log(`  淘汰赛 : ${koS.n}场  场均${koS.gpg}  平局${koS.drawPct}%(注:含点球前90/120分钟平局)`);
if (groupS.gpg && koS.gpg) {
  console.log(`  → 淘汰/小组 进球比 = ${(koS.gpg / groupS.gpg).toFixed(3)}  平局差 = +${(koS.drawPct - groupS.drawPct).toFixed(1)}pp`);
}

// 半场 halfRatio(有 ht 的场)
console.log("\n【半场样本 halfRatio】");
const withHt = rows.filter((r) => r.hh != null && r.ha != null);
if (withHt.length) {
  const htGoals = withHt.reduce((s, r) => s + r.hh + r.ha, 0);
  const ftGoals = withHt.reduce((s, r) => s + r.tot, 0);
  console.log(`  ${withHt.length}场有半场比分  HT进球占FT = ${(htGoals / ftGoals).toFixed(4)}(模型现用 0.46)`);
  const htDraw = withHt.filter((r) => r.hh === r.ha).length;
  console.log(`  HT 平局率 = ${((htDraw / withHt.length) * 100).toFixed(1)}%`);
}

console.log("\n诚实:纯描述统计,不等于命中率净增益;时代分段后才有 2026 参考意义。");
