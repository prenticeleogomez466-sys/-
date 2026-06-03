#!/usr/bin/env node
/**
 * 构建 2026 世界杯官方淘汰赛对阵表 bracket.json（真实来源，非臆造）。
 * 来源:
 *   - R32/R16/QF/SF/Final 骨架 = Wikipedia「2026 FIFA World Cup knockout stage」官方对阵(胜者/亚军位次固定)。
 *   - 第三名 495 组合分配 = Wikipedia Template「2026 FIFA World Cup third-place table」(= FIFA Annex C)。
 *     原始 wikitext 已下载到 _thirdplace_template.wikitext,本脚本确定性解析,自校验。
 *
 * 列序(官方)= [1A,1B,1D,1E,1G,1I,1K,1L];每行 8 个 3X 既给分配、又给出"出线 8 组"键。
 * 用法: node scripts/build-worldcup-bracket.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "D:/football-model-data/world-cup/2026";
const WIKITEXT = join(DIR, "_thirdplace_template.wikitext");
const OUT = join(DIR, "bracket.json");

// 第三名 8 个位次的接收方(官方列序)
const THIRD_SLOT_ORDER = ["1A", "1B", "1D", "1E", "1G", "1I", "1K", "1L"];

// 各接收位次的合法来源组(来自 R32 骨架,用于反向校验解析正确性)
const ELIGIBLE = {
  "1A": new Set(["C", "E", "F", "H", "I"]), // M79
  "1B": new Set(["E", "F", "G", "I", "J"]), // M85
  "1D": new Set(["B", "E", "F", "I", "J"]), // M81
  "1E": new Set(["A", "B", "C", "D", "F"]), // M74
  "1G": new Set(["A", "E", "H", "I", "J"]), // M82
  "1I": new Set(["C", "D", "F", "G", "H"]), // M77
  "1K": new Set(["D", "E", "I", "J", "L"]), // M87
  "1L": new Set(["E", "H", "I", "J", "K"]), // M80
};

// ── 解析 495 行 ──
const raw = readFileSync(WIKITEXT, "utf8");
// 以行号标记 "! scope=\"row\" | N" 切块
const blocks = raw.split(/!\s*scope="row"\s*\|\s*/).slice(1);
const table = {};
let parsed = 0;
const errors = [];

for (const blk of blocks) {
  const noMatch = blk.match(/^\s*(\d+)/);
  if (!noMatch) continue;
  const no = Number(noMatch[1]);
  // 在切到下一行号前截断(下一块以数字开头,split 已分开)
  const seg = blk.split(/\n!\s*scope="row"/)[0];
  // 提取所有 3X 分配(顺序即列序)
  const thirds = (seg.match(/3([A-L])\b/g) || []).map((s) => s[1]);
  if (thirds.length !== 8) {
    errors.push(`行${no}: 解析到 ${thirds.length} 个分配(应为8)`);
    continue;
  }
  const assign = {};
  for (let i = 0; i < 8; i++) assign[THIRD_SLOT_ORDER[i]] = thirds[i];
  // 键 = 出线8组(排序)
  const groups = [...thirds].sort();
  const key = groups.join(",");
  // 校验:8组互异 + 每个分配落在合法来源集
  if (new Set(groups).size !== 8) { errors.push(`行${no}: 出线组有重复 ${key}`); continue; }
  for (const slot of THIRD_SLOT_ORDER) {
    if (!ELIGIBLE[slot].has(assign[slot])) {
      errors.push(`行${no}: ${slot} 收到 3${assign[slot]} 不在合法来源 {${[...ELIGIBLE[slot]].join("")}}`);
    }
  }
  if (table[key]) errors.push(`行${no}: 键重复 ${key}`);
  table[key] = assign;
  parsed++;
}

// ── R32/R16/QF/SF/Final 骨架(官方,胜者1X/亚军2X/第三名 T@1X) ──
const r32 = [
  { m: 73, home: "2A", away: "2B" },
  { m: 74, home: "1E", away: "T@1E" },
  { m: 75, home: "1F", away: "2C" },
  { m: 76, home: "1C", away: "2F" },
  { m: 77, home: "1I", away: "T@1I" },
  { m: 78, home: "2E", away: "2I" },
  { m: 79, home: "1A", away: "T@1A" },
  { m: 80, home: "1L", away: "T@1L" },
  { m: 81, home: "1D", away: "T@1D" },
  { m: 82, home: "1G", away: "T@1G" },
  { m: 83, home: "2K", away: "2L" },
  { m: 84, home: "1H", away: "2J" },
  { m: 85, home: "1B", away: "T@1B" },
  { m: 86, home: "1J", away: "2H" },
  { m: 87, home: "1K", away: "T@1K" },
  { m: 88, home: "2D", away: "2G" },
];
const r16 = [
  { m: 89, from: [74, 77] },
  { m: 90, from: [73, 75] },
  { m: 91, from: [76, 78] },
  { m: 92, from: [79, 80] },
  { m: 93, from: [83, 84] },
  { m: 94, from: [81, 82] },
  { m: 95, from: [86, 88] },
  { m: 96, from: [85, 87] },
];
const qf = [
  { m: 97, from: [89, 90] },
  { m: 98, from: [93, 94] },
  { m: 99, from: [91, 92] },
  { m: 100, from: [95, 96] },
];
const sf = [
  { m: 101, from: [97, 98] },
  { m: 102, from: [99, 100] },
];
const final = { m: 104, from: [101, 102] };

const bracket = {
  meta: {
    tournament: "2026 FIFA World Cup",
    source: "Wikipedia: 2026 FIFA World Cup knockout stage + Template:2026 FIFA World Cup third-place table (FIFA Annex C)",
    builtFromWikitext: "_thirdplace_template.wikitext",
    thirdSlotOrder: THIRD_SLOT_ORDER,
    note: "第三名表按出线8组集合(逗号排序)为键;胜者1X/亚军2X位次官方固定;无同组R32重赛。",
  },
  r32,
  r16,
  qf,
  sf,
  final,
  thirdPlaceTable: table,
};

// ── 输出 + 汇总 ──
if (errors.length) {
  console.log(`❌ 校验失败 ${errors.length} 条(前20):`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(bracket, null, 0), "utf8");
console.log(`✅ bracket.json 已生成: ${OUT}`);
console.log(`   第三名分配表行数: ${parsed} (应=495)`);
console.log(`   R32=${r32.length} R16=${r16.length} QF=${qf.length} SF=${sf.length} Final=1`);
console.log(`   反向校验: 全部 ${parsed}×8 分配均落在 R32 骨架合法来源组内 ✓`);
// 抽样展示
const sampleKey = "E,F,G,H,I,J,K,L";
console.log(`   抽样 [${sampleKey}] => ${JSON.stringify(table[sampleKey])}`);
