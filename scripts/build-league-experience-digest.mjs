#!/usr/bin/env node
/**
 * 每联赛深度经验档(分析依据,2026-05-31)。
 * 把 experience-library 各联赛的真实历史经验 + ESPN 阵型分布,汇成一张 xlsx —— 以后分析的依据。
 * 每联赛一行:样本/赔率覆盖/胜平负率/主场优势/场均进球/大小球/常见比分/半全场覆盖/最强盘口漂移/常见阵型。
 * 用法:node scripts/build-league-experience-digest.mjs
 * 产物:<导出目录>\联赛经验档.xlsx(+ 桌面副本)
 */
import "../src/env.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadExperienceLibrary } from "../src/experience-library-store.js";
import { ESPN_LEAGUES } from "../src/espn-results-source.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { getExportDir, getDataSubdir } from "../src/paths.js";

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const num = (v, p = 2) => (Number.isFinite(v) ? v.toFixed(p) : "—");

const lib = loadExperienceLibrary();
if (!lib?.leagues) { console.error("经验库不存在,先 npm run experience:build"); process.exit(1); }

// 阵型分布(ESPN 回填):league code → {formation: count}
const formByLeague = {};
const fpath = join(getDataSubdir("formations"), "espn-formations.json");
if (existsSync(fpath)) {
  const recs = Object.values(JSON.parse(readFileSync(fpath, "utf8")).records ?? {});
  for (const r of recs) {
    const cn = ESPN_LEAGUES[r.league] ?? r.league;
    const m = (formByLeague[cn] ??= {});
    for (const f of [r.homeFormation, r.awayFormation]) if (f) m[f] = (m[f] ?? 0) + 1;
  }
}
const topFormations = (cn) => {
  const m = formByLeague[cn];
  if (!m) return "—";
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([f, c]) => `${f}(${c})`).join(" ");
};

// 最强盘口漂移信号:driftTiers 里挑"热门走强"桶,看热门方真实胜率(供"赔率变化→结果"判读)
const strongestDrift = (L) => {
  const dt = L.driftTiers;
  if (!dt) return "—";
  const out = [];
  for (const [k, b] of Object.entries(dt)) {
    if (!b || b.n < 30) continue;
    const [side, band] = k.split("|");
    const sideRate = side === "home" ? b.wld.home : b.wld.away;
    out.push(`${band}→${side === "home" ? "主" : "客"}胜${pct(sideRate)}(n${b.n})`);
  }
  return out.length ? out.slice(0, 2).join("；") : "—";
};

const header = ["联赛", "样本", "赔率覆盖", "主胜%", "平局%", "客胜%", "主场优势", "场均总进球", "大小球over2.5", "常见比分Top3", "半全场覆盖", "盘口漂移→结果", "常见阵型Top2"];
const rows = [header];

const leagues = Object.entries(lib.leagues)
  .filter(([, L]) => L && L.n >= 40)
  .sort((a, b) => b[1].n - a[1].n);

for (const [name, L] of leagues) {
  const homeAdv = Number.isFinite(L.wld?.home) && Number.isFinite(L.wld?.away) ? L.wld.home - L.wld.away : NaN;
  const topScores = (L.scoreDist ?? []).slice(0, 3).map((s) => `${s.key}(${pct(s.prob)})`).join(" ");
  rows.push([
    name,
    L.n,
    L.hasOdds ? "有" : "纯赛果",
    pct(L.wld?.home), pct(L.drawRate), pct(L.wld?.away),
    Number.isFinite(homeAdv) ? `${homeAdv >= 0 ? "+" : ""}${(homeAdv * 100).toFixed(1)}pp` : "—",
    num(L.overUnder?.avgTotal),
    pct(L.overUnder?.over25),
    topScores || "—",
    L.hasHalfTime ? "有" : "无",
    strongestDrift(L),
    topFormations(name)
  ]);
}

const note = [
  ["说明", ""],
  ["数据源", `football-data 18 欧洲联赛×5季 + /new/ 北欧/日职 + ESPN 纯赛果(MLS/巴甲/沙特/中超/阿甲/墨超/澳超)+ TheSportsDB 逐轮(韩K)`],
  ["样本总数", String(lib.meta?.usedMatches ?? "")],
  ["带赔率场数", String(lib.meta?.usedWithOdds ?? "")],
  ["用途", "每联赛真实历史经验 = 以后分析依据(平局率/主场优势/进球水平/比分形态/盘口漂移→结果/阵型)"],
  ["主场优势", "主胜率−客胜率,越大主场越强"],
  ["盘口漂移→结果", "历史『赔率开→收变化方向』对应的真实热门胜率(仅有开收双价的联赛)"],
  ["阵型分布", "ESPN 联赛赛前真实首发阵型频次(布阵姿态→胜负平回测无增益,仅作特点参考)"],
  ["诚实边界", "纯赛果联赛无半全场/无赔率漂移档;成熟市场赔率仍是命中天花板,经验档是分析依据非保证"],
];

const exportDir = getExportDir();
const outPath = join(exportDir, "联赛经验档.xlsx");
writeXlsxWorkbook(outPath, [{ name: "联赛经验档", rows }, { name: "说明", rows: note }]);
console.log(`已生成 ${leagues.length} 个联赛的经验档:${outPath}`);

// 桌面副本(用户取用方便,遵 xlsx 输出规则)
try {
  const desktop = join(homedir(), "Desktop", "联赛经验档.xlsx");
  writeXlsxWorkbook(desktop, [{ name: "联赛经验档", rows }, { name: "说明", rows: note }]);
  console.log(`桌面副本:${desktop}`);
} catch (e) { console.log(`桌面副本跳过:${e.message}`); }

// 控制台速览 Top 12
console.log("\n联赛经验速览(按样本):");
console.log(header.slice(0, 9).join(" | "));
for (const r of rows.slice(1, 13)) console.log(r.slice(0, 9).join(" | "));
