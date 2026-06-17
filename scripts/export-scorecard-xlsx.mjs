#!/usr/bin/env node
/**
 * 神选-模型全面体检与提升-<date>.xlsx
 * 把 model:scorecard 七维度自评落成专业交付配套(主交付夹第4配套)。
 * 数据自包含:直接调 writeScorecardReport() 取实时分,不依赖单独先跑 model:scorecard。
 * 由 today-oneshot ⑥b-3 自动调用,落 桌面\足球推荐\<date>\。
 */
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeScorecardReport } from "../src/model-scorecard-cli.js";

const report = writeScorecardReport();
const date = new Date().toISOString().slice(0, 10);
const dir = join(process.env.USERPROFILE || "C:/Users/Administrator", "Desktop", "足球推荐", date);
try { mkdirSync(dir, { recursive: true }); } catch {}

const pct = (s, m) => (m ? `${Math.round((s / m) * 1000) / 10}%` : "-");
// 达成率→评级标签(诚实:只描述达成度,不吹)
const rate = (s, m) => {
  const r = m ? s / m : 0;
  if (r >= 1) return "✅满分";
  if (r >= 0.9) return "🟢优";
  if (r >= 0.75) return "🟡良";
  if (r >= 0.6) return "🟠中";
  return "🔴弱·优先提升";
};

// Sheet1 体检总览
const overview = [
  [`⚡ 神选·模型全面体检与提升 · ${date}`],
  [`总分 ${report.total} / ${report.max}　评级 ${report.grade}　(七维度加权自评·model:scorecard同源)`],
  [],
  ["维度", "得分", "满分", "达成率", "评级"],
];
for (const d of report.breakdown) {
  overview.push([d.dimension, d.score, d.max, pct(d.score, d.max), rate(d.score, d.max)]);
}
overview.push([]);
overview.push(["合计", report.total, report.max, pct(report.total, report.max), report.grade]);

// Sheet2 逐项体检 + 提升清单(按缺口降序:最该提升的排最前)
const items = [];
for (const d of report.breakdown) {
  for (const it of d.items) {
    const gap = Math.round((it.max - it.score) * 100) / 100;
    items.push({
      dim: d.dimension, name: it.name, score: it.score, max: it.max,
      weight: it.weight, gap,
      found: (it.found === undefined || it.found === null) ? "-" : String(it.found),
    });
  }
}
items.sort((a, b) => b.gap - a.gap);
const detail = [
  [`📋 逐项体检 + 提升清单 · ${date} · 按缺口(提升空间)降序,缺口越大越优先`],
  [],
  ["维度", "项目", "得分", "满分", "权重", "达成率", "缺口(提升空间)", "命中迹象found", "状态"],
];
for (const it of items) {
  detail.push([
    it.dim, it.name, it.score, it.max, it.weight, pct(it.score, it.max),
    it.gap > 0 ? it.gap : "0(已达标)", it.found,
    it.gap > 0 ? rate(it.score, it.max) : "✅达标",
  ]);
}
const gaps = items.filter((i) => i.gap > 0);
const totalGap = Math.round(gaps.reduce((s, i) => s + i.gap, 0) * 10) / 10;
detail.push([]);
detail.push([`提升空间合计 ${totalGap} 分,集中在 ${gaps.slice(0, 3).map((i) => `${i.dim}/${i.name}`).join("、")} 等;found=命中迹象(文件/源/测试数等存在性探测,非性能指标)。诚实:评分=能力面覆盖自评,非命中率保证。`]);

const out = join(dir, `神选-模型全面体检与提升-${date}.xlsx`);
writeXlsxWorkbook(out, [
  { name: "体检总览", rows: overview },
  { name: "逐项提升清单", rows: detail },
]);
console.log(`✅ xlsx: ${out}`);
console.log(`   总分 ${report.total}/${report.max} ${report.grade} · 提升空间合计 ${totalGap}分 · ${gaps.length}项可提升`);
