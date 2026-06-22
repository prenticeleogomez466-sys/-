#!/usr/bin/env node
/**
 * 389张苹果手机截图(看球App"分析"页)OCR后的真·竞彩赔率分析(2026-06-22)。
 * 数据 = D:\football-model-data\screenshots-ocr\all.json(初盘+终盘 欧赔/亚盘/大小球/竞彩1X2/竞彩让球 + 最终比分)。
 *
 * 价值:football-data.co.uk 缺历史竞彩赔率,这批截图补上了"真竞彩初盘+终盘"(N~353)。
 * 用来验证 reference_signal_backtest_findings 的两条:
 *   ① 竞彩1X2 ≈ 欧赔换算(共线?) —— 是则"欧赔+竞彩组合"不是独立信号。
 *   ② 庄家意图(初→终 加注/退烧)在真竞彩上能否复现 +5.2%/-12.6% 那条唯一有效信号。
 *
 * 铁律:N小(386)→只报方向+样本量,显著性弱必须诚实标;不cherry-pick;禁编。
 */
import fs from "node:fs";
const all = JSON.parse(fs.readFileSync("D:/football-model-data/screenshots-ocr/all.json", "utf8"));
const pct = (x) => (x * 100).toFixed(1) + "%";
const z = (p, p0, n) => (n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt((p0 * (1 - p0)) / n) : 0);
const flag = (zz) => (Math.abs(zz) >= 2.6 ? "🟢" : Math.abs(zz) >= 2 ? "🟡" : "⚪");

// devig 3-way 小数赔 → 归一隐含概率
function devig(arr) {
  if (!Array.isArray(arr) || !arr.every((v) => v > 1)) return null;
  const inv = arr.map((v) => 1 / v);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((v) => v / s);
}

const fin = all.filter((x) => x.finished && Array.isArray(x.ft) && x.ft.length === 2 && Number.isFinite(x.ft[0]) && Number.isFinite(x.ft[1]));
function result(x) { const [h, a] = x.ft; return h > a ? "home" : h < a ? "away" : "draw"; }

// ===== 基线 =====
const N = fin.length;
const base = {
  home: fin.filter((x) => result(x) === "home").length / N,
  draw: fin.filter((x) => result(x) === "draw").length / N,
  away: fin.filter((x) => result(x) === "away").length / N,
};
console.log("████ 截图真竞彩赔率分析 ████");
console.log(`可分析(含最终比分) N=${N}`);
console.log(`基线: 主胜${pct(base.home)} 平${pct(base.draw)} 客胜${pct(base.away)}\n`);

// ===== ① 竞彩1X2 vs 欧赔 共线性 =====
console.log("① 竞彩1X2收盘 vs 欧赔收盘 是不是同一个东西(共线性检验)");
{
  const rows = fin.filter((x) => devig(x.jc_1x2_close) && devig(x.crow_eu_close));
  let sumAbs = 0, n = 0, corrXY = [];
  for (const x of rows) {
    const jc = devig(x.jc_1x2_close), eu = devig(x.crow_eu_close);
    for (let i = 0; i < 3; i++) { sumAbs += Math.abs(jc[i] - eu[i]); n++; corrXY.push([jc[i], eu[i]]); }
  }
  const mx = corrXY.reduce((a, b) => a + b[0], 0) / corrXY.length;
  const my = corrXY.reduce((a, b) => a + b[1], 0) / corrXY.length;
  let sxy = 0, sx = 0, sy = 0;
  for (const [a, b] of corrXY) { sxy += (a - mx) * (b - my); sx += (a - mx) ** 2; sy += (b - my) ** 2; }
  const r = sxy / Math.sqrt(sx * sy);
  console.log(`  ${rows.length}场 · 竞彩devig隐含 vs 欧赔devig隐含: 相关r=${r.toFixed(4)} · 平均绝对差=${(sumAbs / n * 100).toFixed(2)}pp`);
  console.log(`  ⇒ ${r > 0.97 ? "高度共线(竞彩≈欧赔换算,'欧赔+竞彩组合'非独立信号)" : "存在差异,值得分别看"}\n`);
}

// ===== ② 竞彩热门收盘赔档 → 主推命中/爆冷(对照football-data档) =====
console.log("② 竞彩收盘热门赔档 → 热门胜/平/不胜率(N小,看方向)");
{
  const rows = fin.map((x) => {
    const c = x.jc_1x2_close; if (!Array.isArray(c) || !(c[0] > 0 && c[2] > 0)) return null;
    const favHome = c[0] <= c[2];
    const favDec = favHome ? c[0] : c[2];
    const r = result(x);
    return { favDec, favWin: r === (favHome ? "home" : "away"), draw: r === "draw", notWin: r !== (favHome ? "home" : "away") };
  }).filter(Boolean);
  const bands = [[1, 1.4], [1.4, 1.6], [1.6, 1.85], [1.85, 2.1], [2.1, 3.5]];
  const b0 = rows.filter((r) => r.notWin).length / rows.length;
  for (const [lo, hi] of bands) {
    const g = rows.filter((r) => r.favDec >= lo && r.favDec < hi);
    if (!g.length) continue;
    const win = g.filter((r) => r.favWin).length / g.length;
    const dr = g.filter((r) => r.draw).length / g.length;
    const nw = g.filter((r) => r.notWin).length / g.length;
    console.log(`  竞彩热门[${lo}-${hi}) N=${String(g.length).padStart(3)} | 胜${pct(win)} 平${pct(dr)} 不胜${pct(nw)} ${flag(z(nw, b0, g.length))}`);
  }
  console.log("");
}

// ===== ③ 庄家意图:竞彩初→终 热门隐含变化 → 命中(唯一有效信号能否复现) =====
console.log("③ 庄家意图(竞彩初→终):热门被加注 vs 退烧 → 实际命中  ★唯一有效信号复现检验");
{
  const rows = fin.map((x) => {
    const o = devig(x.jc_1x2_open), c = devig(x.jc_1x2_close);
    if (!o || !c) return null;
    const favHome = c[0] >= c[2]; // 收盘隐含高=热门
    const favIdx = favHome ? 0 : 2;
    const move = c[favIdx] - o[favIdx]; // >0 收盘更看好(加注) <0 退烧
    const r = result(x);
    return { move, favWin: r === (favHome ? "home" : "away"), favImpClose: c[favIdx] };
  }).filter(Boolean);
  const baseWin = rows.filter((r) => r.favWin).length / rows.length;
  console.log(`  样本 ${rows.length}场 · 热门收盘平均命中基线 ${pct(baseWin)}`);
  const groups = [
    ["收盘加注热门(move>+2pp,sharp更看好)", rows.filter((r) => r.move > 0.02)],
    ["平稳(|move|≤2pp)", rows.filter((r) => Math.abs(r.move) <= 0.02)],
    ["收盘退烧热门(move<-2pp,公众追捧被看淡)", rows.filter((r) => r.move < -0.02)],
  ];
  for (const [name, g] of groups) {
    if (!g.length) continue;
    const win = g.filter((r) => r.favWin).length / g.length;
    const avgImp = g.reduce((a, r) => a + r.favImpClose, 0) / g.length;
    console.log(`  ${name.padEnd(34)} N=${String(g.length).padStart(3)} | 收盘隐含${pct(avgImp)} → 实际命中${pct(win)} ${flag(z(win, baseWin, g.length))}`);
  }
  console.log("  对照football-data 21405场: 加注组命中57.2%(+5.2%ROI) / 退烧组47.3%(-12.6%ROI)\n");
}

// ===== ④ 竞彩让球(让胜/让平/让负) 按让球线 =====
console.log("④ 竞彩让球结果(让胜/让平/让负)按让球线 — 用真竞彩让球盘");
{
  // 让球线: 主队让球数(line为正=主队让给客队). 让胜=主队赢盘 让平=正好 让负=输盘
  function hcpResult(x) {
    const line = parseFloat(String(x.jc_hcp_line).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(line)) return null;
    const [h, a] = x.ft; const margin = (h + line) - a; // 主队加让球后净胜
    return margin > 0.0001 ? "让胜" : margin < -0.0001 ? "让负" : "让平";
  }
  const rows = fin.map((x) => { const hr = hcpResult(x); return hr ? { line: parseFloat(String(x.jc_hcp_line).replace(/[^0-9.-]/g, "")), hr } : null; }).filter(Boolean);
  const byLine = {};
  for (const r of rows) { (byLine[r.line] ||= []).push(r.hr); }
  for (const line of Object.keys(byLine).map(Number).sort((a, b) => a - b)) {
    const g = byLine[line];
    const w = g.filter((h) => h === "让胜").length, d = g.filter((h) => h === "让平").length, l = g.filter((h) => h === "让负").length;
    console.log(`  让球线${line >= 0 ? "+" + line : line} N=${String(g.length).padStart(3)} | 让胜${pct(w / g.length)} 让平${pct(d / g.length)} 让负${pct(l / g.length)}`);
  }
  console.log("");
}

// ===== ⑤ 大小球初→终 走势 → 大小球结果 =====
console.log("⑤ 大小球盘口初→终走势 → 实际大/小球(football-data证此为唯一可利用残差)");
{
  const rows = fin.map((x) => {
    const oo = x.crow_ou_open, oc = x.crow_ou_close;
    if (!Array.isArray(oo) || !Array.isArray(oc) || !(oo[0] > 0 && oc[0] > 0)) return null;
    const line = parseFloat(String(oc[1]).split("/")[0]);
    if (!Number.isFinite(line)) return null;
    const overWaterMove = oc[0] - oo[0]; // 大球水位变化 <0=大球被加注
    const goals = x.ft[0] + x.ft[1];
    return { overWaterMove, over: goals > line + 0.001, line };
  }).filter(Boolean);
  const b0 = rows.filter((r) => r.over).length / rows.length;
  console.log(`  样本${rows.length} · 大球出现基线${pct(b0)}`);
  const g1 = rows.filter((r) => r.overWaterMove < -0.03); // 大球水位降=大球被加注
  const g2 = rows.filter((r) => r.overWaterMove > 0.03);
  if (g1.length) console.log(`  大球被加注(水位降) N=${g1.length} → 实际大球${pct(g1.filter((r) => r.over).length / g1.length)} ${flag(z(g1.filter((r) => r.over).length / g1.length, b0, g1.length))}`);
  if (g2.length) console.log(`  大球退烧(水位升) N=${g2.length} → 实际大球${pct(g2.filter((r) => r.over).length / g2.length)} ${flag(z(g2.filter((r) => r.over).length / g2.length, b0, g2.length))}`);
  console.log("");
}

console.log("标记 🟢z≥2.6 🟡z≥2 ⚪不显著(N小多为⚪,看方向是否与football-data大样本一致)");
