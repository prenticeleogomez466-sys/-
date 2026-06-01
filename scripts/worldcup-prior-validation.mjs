#!/usr/bin/env node
/**
 * 世界杯先验验证(金字塔闭环·验证环)。
 * 用回填的历届世界杯真实赛果(scripts/backfill-worldcup-history.mjs 写入,tags 含 'worldcup')
 * 实测 world-cup-priors.js 各先验是否被数据支持,给出数据校准建议。
 * 遵 feedback-no-fabrication-live-only:只报实测频率,样本不足的维度明确标"样本不足·不下结论"。
 *
 * 用法: node scripts/worldcup-prior-validation.mjs
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";

function collect() {
  const rows = [];
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result) continue;
      const r = f.result;
      rows.push({
        stage: f.round || "group",
        tot: r.home + r.away,
        draw90: r.home === r.away ? 1 : 0,
        htDraw: r.halfHome != null && r.halfAway != null ? (r.halfHome === r.halfAway ? 1 : 0) : null,
        hasHt: r.halfHome != null,
      });
    }
  }
  return rows;
}

function summarize(rows) {
  if (!rows.length) return null;
  const n = rows.length;
  const avgGoals = rows.reduce((s, x) => s + x.tot, 0) / n;
  const drawRate = rows.reduce((s, x) => s + x.draw90, 0) / n;
  return { n, avgGoals, drawRate };
}

function main() {
  const rows = collect();
  if (!rows.length) {
    console.log("库内无世界杯样本 — 先跑 node scripts/backfill-worldcup-history.mjs");
    return;
  }
  const KNOCKOUT = new Set(["r16", "qf", "sf", "third", "final", "knockout"]);
  const group = rows.filter((r) => r.stage === "group");
  const knockout = rows.filter((r) => KNOCKOUT.has(r.stage));
  const gS = summarize(group), kS = summarize(knockout), allS = summarize(rows);

  console.log("=== 世界杯先验验证(历届真实赛果)===");
  console.log(`总样本: ${allS.n} 场 | 全局平均总进球 ${allS.avgGoals.toFixed(3)} | 90分平局率 ${(allS.drawRate * 100).toFixed(1)}%`);
  console.log("");
  console.log("阶段           n     平均总进球   90分平局率");
  for (const [label, s] of [["小组赛 group", gS], ["淘汰赛 knockout", kS]]) {
    if (s) console.log(`${label.padEnd(14)} ${String(s.n).padEnd(5)} ${s.avgGoals.toFixed(3).padEnd(11)} ${(s.drawRate * 100).toFixed(1)}%`);
  }
  // 各淘汰阶段细分(样本少→标注)
  console.log("\n淘汰赛细分(样本少仅供参考):");
  for (const st of ["r16", "qf", "sf", "third", "final"]) {
    const s = summarize(rows.filter((r) => r.stage === st));
    if (s) console.log(`  ${st.padEnd(6)} n=${s.n} 进球${s.avgGoals.toFixed(2)} 平局${(s.drawRate * 100).toFixed(0)}%${s.n < 20 ? " ⚠样本不足" : ""}`);
  }
  // 校准建议
  if (gS && kS) {
    const lambdaRatio = kS.avgGoals / gS.avgGoals;
    const drawDelta = (kS.drawRate - gS.drawRate) * 100;
    console.log("\n=== 数据校准建议(vs world-cup-priors 现行先验)===");
    console.log(`淘汰赛 λ 乘子: 实测 ${lambdaRatio.toFixed(3)}(淘汰赛/小组赛进球比)| 先验现行 lowest×0.96 / lower×0.98`);
    console.log(`淘汰赛平局率: 实测比小组赛 +${drawDelta.toFixed(1)}pp(${(kS.drawRate * 100).toFixed(1)}% vs ${(gS.drawRate * 100).toFixed(1)}%)→ 软重校准淘汰赛应上调平局目标`);
  }
}

main();
