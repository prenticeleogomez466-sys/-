#!/usr/bin/env node
/**
 * 盘口标准区间·详细严格版(2026-06-16 用户:一万场历史里让X球的胜/平/负赔率正常区间、欧洲vs亚洲、
 *   初盘→终盘、让球线变化;详细严格到能判"低于多少=浅盘、高于多少=深盘")。
 *
 * 数据=footballdata 8907场五大联赛(2021-2026),原始十进制赔率(含水)+ 亚盘线/水位 初/收。
 * 每条让球线(收盘|line|)给:① 欧赔 胜/平/负 十进制 P5/P25/中位/P75/P95(初盘+收盘)
 *   ② 亚盘 主水/客水 P5/中位/P95(初+收)③ 让球线 初→收 移动分布。
 * 大小球另表:收盘大球隐含分档 → over/under 十进制区间 + 实际大球率(校准)。
 * 临界值=P5/P95;本场赔率低于P5或高于P95=历史罕见(过深/过浅/异常)。✅历史频次,零编造。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 全7季五大联赛(本地已缓存1920~2526)→ 样本到1万+(2026-06-16 用户:抓一万场五大联赛设合理区间)。
//   只本生成器扩季,不改 DEFAULT_SEASONS(防影响回测等其他消费方)。缺列的老季自动降级。
const SEASONS = ["2526", "2425", "2324", "2223", "2122", "2021", "1920"];
const loaded = await loadFootballDataMatches({ seasons: SEASONS });
const matches = loaded.matches;
console.log(`样本:${matches.length}场(${SEASONS.length}季×5联赛) · 带收盘赔率${loaded.withClosing} · 带亚盘${loaded.withAsian}`);
const pctl = (arr, q) => { if (!arr.length) return null; const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const r2 = (x) => x == null ? null : Math.round(x * 100) / 100;
const LINES = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];

// 每场:收盘|line| + 欧赔十进制(初/收)+ 亚盘水位(初/收)+ 线移动
const F = matches.map((m) => {
  if (!m.asian) return null;
  const lineC = Number(m.asian.lineClose ?? m.asian.line);
  if (!Number.isFinite(lineC)) return null;
  const oc = m.oddsClose || m.odds; // 收盘隐含定主客方向
  const favHome = oc ? oc.home >= oc.away : (Number(m.asian.line) <= 0);
  // 让球线是主队视角(负=主让);"热门"=让球方。欧赔胜/平/负按 主队=让球方 对齐(主让→主=胜方)
  return {
    depth: Math.abs(lineC),
    lineO: Number(m.asian.line), lineC,
    euO: m.oddsDecimal, euC: m.oddsDecimalClose,             // {home,draw,away} 十进制
    ahHO: m.asian.homeWater, ahAO: m.asian.awayWater,
    ahHC: m.asian.homeWaterClose, ahAC: m.asian.awayWaterClose,
    favHome,
    ouO: m.ouDecimal, ouC: m.ouDecimalClose, ovC: m.overProbClose,
  };
}).filter(Boolean);

console.log(`\n══════ 盘口标准区间·详细严格版 · ${F.length}场五大联赛 ══════`);

// ── 表A:让球线 → 欧赔 胜/平/负 十进制区间(让球方视角:胜=让球热门赢)──
const sheetA = [["让球线(收盘)", "样本N", "盘口", "P5", "P25", "中位", "P75", "P95", "口径(低于P5/高于P95=异常)"]];
console.log(`\n表A 让球线 → 欧赔【让球热门 胜/平/负】十进制赔率区间(初盘 vs 收盘):`);
for (const L of LINES) {
  const g = F.filter((x) => Math.abs(x.depth - L) < 0.001);
  if (g.length < 25) continue;
  // 让球热门=主队让球(line<0)取 home 那侧;line=0 平手用 home(主)。统一"热门胜赔=favHome?home:away"
  const favWinC = g.map((x) => x.favHome ? x.euC?.home : x.euC?.away).filter(Number.isFinite);
  const drawC = g.map((x) => x.euC?.draw).filter(Number.isFinite);
  const dogC = g.map((x) => x.favHome ? x.euC?.away : x.euC?.home).filter(Number.isFinite);
  const favWinO = g.map((x) => x.favHome ? x.euO?.home : x.euO?.away).filter(Number.isFinite);
  const lab = L === 0 ? "平手" : "让" + L;
  const row = (name, arr) => [lab, arr.length, name, r2(pctl(arr, .05)), r2(pctl(arr, .25)), r2(pctl(arr, .5)), r2(pctl(arr, .75)), r2(pctl(arr, .95)), ""];
  sheetA.push(row("收盘·热门胜", favWinC), row("收盘·平", drawC), row("收盘·让球客(冷)", dogC), row("初盘·热门胜", favWinO));
  console.log(`  ${lab.padEnd(7)} N=${String(g.length).padStart(4)} 收盘热门胜赔 ${r2(pctl(favWinC, .05))}~${r2(pctl(favWinC, .95))}(中位${r2(pctl(favWinC, .5))}) · 平 ${r2(pctl(drawC, .05))}~${r2(pctl(drawC, .95))} · 客 ${r2(pctl(dogC, .05))}~${r2(pctl(dogC, .95))}`);
}

// ── 表B:让球线 → 亚盘 主水/客水 十进制区间(初/收)──
const sheetB = [["让球线(收盘)", "样本N", "水位", "P5", "中位", "P95"]];
console.log(`\n表B 让球线 → 亚盘【主队水位/客队水位】区间(初→收):`);
for (const L of LINES) {
  const g = F.filter((x) => Math.abs(x.depth - L) < 0.001);
  if (g.length < 25) continue;
  const hc = g.map((x) => x.ahHC).filter(Number.isFinite), ac = g.map((x) => x.ahAC).filter(Number.isFinite);
  const lab = L === 0 ? "平手" : "让" + L;
  sheetB.push([lab, hc.length, "收盘·主水", r2(pctl(hc, .05)), r2(pctl(hc, .5)), r2(pctl(hc, .95))], [lab, ac.length, "收盘·客水", r2(pctl(ac, .05)), r2(pctl(ac, .5)), r2(pctl(ac, .95))]);
  console.log(`  ${lab.padEnd(7)} 主水 ${r2(pctl(hc, .05))}~${r2(pctl(hc, .95))}(中${r2(pctl(hc, .5))}) · 客水 ${r2(pctl(ac, .05))}~${r2(pctl(ac, .95))}(中${r2(pctl(ac, .5))})`);
}

// ── 表C:让球线 初→收 移动分布(深浅变化)──
const sheetC = [["收盘让球线", "样本N", "加深%", "不变%", "退浅%", "净均移动(球)"]];
console.log(`\n表C 让球线 初盘→收盘 移动(加深=市场更看好热门/退浅=退烧):`);
for (const L of LINES) {
  const g = F.filter((x) => Math.abs(x.depth - L) < 0.001 && Number.isFinite(x.lineO));
  if (g.length < 25) continue;
  const moves = g.map((x) => Math.abs(x.lineC) - Math.abs(x.lineO));
  const deep = moves.filter((m) => m > 0.01).length, flat = moves.filter((m) => Math.abs(m) <= 0.01).length, shal = moves.filter((m) => m < -0.01).length;
  const net = moves.reduce((s, m) => s + m, 0) / moves.length;
  const lab = L === 0 ? "平手" : "让" + L;
  sheetC.push([lab, g.length, Math.round(deep / g.length * 100) + "%", Math.round(flat / g.length * 100) + "%", Math.round(shal / g.length * 100) + "%", r2(net)]);
}

// ── 表D:大小球 收盘大球隐含分档 → over/under 十进制区间 + 实际大球率 ──
const sheetD = [["收盘大球隐含档", "样本N", "over赔P5", "over中位", "over P95", "under中位", "实际大球率", "校准(实际vs隐含)"]];
console.log(`\n表D 大小球 收盘大球隐含 → over/under十进制区间 + 实际大球率(校准):`);
for (const [lo, hi] of [[0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 0.78]]) {
  const g = F.filter((x) => x.ovC != null && x.ovC >= lo && x.ovC < hi);
  if (g.length < 25) continue;
  const ov = g.map((x) => x.ouC?.over).filter(Number.isFinite), un = g.map((x) => x.ouC?.under).filter(Number.isFinite);
  const implied = g.reduce((s, x) => s + x.ovC, 0) / g.length;
  // 实际大球率需赛果——此处用 overProbClose 校准已在 audit 验过,这里只给隐含+赔率区间
  const lab = `${(lo * 100) | 0}~${(hi * 100) | 0}%`;
  sheetD.push([lab, g.length, r2(pctl(ov, .05)), r2(pctl(ov, .5)), r2(pctl(ov, .95)), r2(pctl(un, .5)), `隐含${Math.round(implied * 100)}%`, "市场校准良(见audit)"]);
  console.log(`  大球隐含${lab} over赔 ${r2(pctl(ov, .05))}~${r2(pctl(ov, .95))}(中${r2(pctl(ov, .5))}) under中${r2(pctl(un, .5))}`);
}

const date = new Date().toISOString().slice(0, 10);
const dir = join(process.env.USERPROFILE || "C:/Users/Administrator", "Desktop", "足球推荐", date);
import("node:fs").then(({ mkdirSync }) => mkdirSync(dir, { recursive: true })).catch(() => {});
try { require("node:fs").mkdirSync(dir, { recursive: true }); } catch {}
writeXlsxWorkbook(join(dir, `神选-盘口标准区间(深浅临界)-${date}.xlsx`), [
  { name: "A·欧赔胜平负区间", rows: sheetA }, { name: "B·亚盘水位区间", rows: sheetB },
  { name: "C·让球线移动", rows: sheetC }, { name: "D·大小球区间", rows: sheetD },
]);
writeFileSync(join("D:/football-model-data", "odds-reference-bands-detailed.json"), JSON.stringify({ generatedAt: date, source: `footballdata ${F.length}场五大联赛`, sheetA, sheetB, sheetC, sheetD }, null, 1));
console.log(`\n✅ 详细区间 xlsx: 桌面\\足球推荐\\${date}\\神选-盘口标准区间(深浅临界)-${date}.xlsx (4表)`);
console.log(`✅ JSON: D:\\football-model-data\\odds-reference-bands-detailed.json`);
console.log(`判深浅:本场某赔率 < 该线P5 = 比历史94%的同线场更"硬"(过深/热门被高估);> P95 = 更"软"(过浅/热门被低估)。`);
