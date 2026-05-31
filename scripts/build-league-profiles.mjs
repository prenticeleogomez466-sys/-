/**
 * 建联赛历史画像(2026-05-31)—— 从本地 fixture store(已回填 football-data 五大联赛+次级 +
 * ESPN 日韩职/澳超/美职/巴甲/沙特/挪超/瑞超等的真实赛果)提炼每联赛特点:
 *   场均进球、平局率、主场优势(主/客进球比)、主胜率、大球率。存 exports/league-profiles.json。
 * 免网络、秒出。用途:把"日职小球多平、阿甲高平、德甲大球、英超主场弱"等真实特点接进预测。
 * 用法:node scripts/build-league-profiles.mjs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { getExportDir } from "../src/paths.js";

const byLeague = {};
for (const d of listFixtureDates()) {
  for (const f of loadFixtures(d).fixtures) {
    if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
    const lg = f.competition || "?";
    (byLeague[lg] ??= []).push([f.result.home, f.result.away]);
  }
}

function profileOf(a) {
  const n = a.length;
  const hg = a.reduce((s, [h]) => s + h, 0) / n;
  const ag = a.reduce((s, [, w]) => s + w, 0) / n;
  const r = (v) => Math.round(v * 1000) / 1000;
  return {
    n,
    avgGoals: r(hg + ag),
    homeGoalsAvg: r(hg), awayGoalsAvg: r(ag),
    homeAdvantage: r(hg / Math.max(0.01, ag)),
    drawRate: r(a.filter(([h, w]) => h === w).length / n),
    homeWinRate: r(a.filter(([h, w]) => h > w).length / n),
    overRate: r(a.filter(([h, w]) => h + w > 2.5).length / n),
  };
}

const profiles = {};
for (const [lg, a] of Object.entries(byLeague)) if (a.length >= 120) profiles[lg] = profileOf(a);
const allArr = Object.values(byLeague).flat();
profiles.__global__ = profileOf(allArr);

const path = join(getExportDir(), "league-profiles.json");
writeFileSync(path, JSON.stringify({ generatedAt: "2026-05-31", source: "fixture-store", leagues: profiles }, null, 2), "utf8");

console.log(`联赛画像已存:${path}  (${Object.keys(profiles).length - 1} 个联赛)\n`);
console.log("联赛        样本  场均球 平局率 主场优势 大球率");
for (const [lg, p] of Object.entries(profiles).filter(([k]) => k !== "__global__").sort((a, b) => b[1].avgGoals - a[1].avgGoals)) {
  console.log(lg.padEnd(8), String(p.n).padStart(5), String(p.avgGoals).padStart(6), (p.drawRate * 100).toFixed(0).padStart(5) + "%", String(p.homeAdvantage).padStart(7), (p.overRate * 100).toFixed(0).padStart(6) + "%");
}
const g = profiles.__global__;
console.log("全局基准".padEnd(7), String(g.n).padStart(5), String(g.avgGoals).padStart(6), (g.drawRate * 100).toFixed(0).padStart(5) + "%", String(g.homeAdvantage).padStart(7), (g.overRate * 100).toFixed(0).padStart(6) + "%");
