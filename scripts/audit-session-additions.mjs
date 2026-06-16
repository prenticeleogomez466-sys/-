#!/usr/bin/env node
/**
 * 本轮新增/修改 全覆盖对抗审计(2026-06-16 用户:"刚才所有修改增加的部分严格回测审计,查问题不许遗漏")。
 * 逐项把可疑点写成检查跑实,发现问题即标 🔴PROBLEM(不放过)。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { diagnoseUpsetRisk } from "../src/upset-trap-detector.js";
import { analyzeTotalsMovement, overImpliedProb } from "../src/totals-movement-signal.js";
import { predictFixture } from "../src/prediction-engine.js";

const { matches } = await loadFootballDataMatches();
const problems = [];
const P = (m) => { problems.push(m); console.log("  🔴PROBLEM:", m); };
const OK = (m) => console.log("  ✅", m);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ── 检查1:LINE_BENCHMARK 嵌入值 vs 数据重导(只到样本充足的85%;90%+须不外推)──
console.log("\n【1】深浅基准 LINE_BENCHMARK 嵌入值 vs 8906场重导中位");
const EMBEDDED = { 0.50: 0.5, 0.55: 0.75, 0.60: 1.0, 0.65: 1.25, 0.70: 1.5, 0.75: 1.75, 0.80: 2.25, 0.85: 2.5 };
const feats = matches.map(m => {
  const oc = m.oddsClose; if (!oc || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals; if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const fav = oc.home >= oc.away ? "home" : "away";
  return { pFav: oc[fav], ahDepthC: Math.abs(Number(m.asian.lineClose ?? m.asian.line)), o: m.odds, oc,
    result: hg > ag ? "home" : hg < ag ? "away" : "draw", favSide: fav, ovO: m.overProb, ovC: m.overProbClose,
    pDraw: oc.draw,
    favWin: (hg > ag ? "home" : hg < ag ? "away" : "draw") === fav, favDrew: hg === ag, over25: hg + ag > 2.5 };
}).filter(Boolean);
for (const [lo, hi] of [[0.50, 0.55], [0.55, 0.60], [0.60, 0.65], [0.65, 0.70], [0.70, 0.75], [0.75, 0.80], [0.80, 0.85]]) {
  const g = feats.filter(x => x.pFav >= lo && x.pFav < hi);
  const med = median(g.map(x => x.ahDepthC));
  const emb = EMBEDDED[lo];
  const tag = g.length < 30 ? "⚠样本不足" : Math.abs(med - emb) <= 0.001 ? "✅一致" : `🔴差(嵌${emb}≠数据${med})`;
  console.log(`  档${(lo * 100).toFixed(0)}% N=${String(g.length).padStart(4)} 数据中位${med} vs 嵌入${emb} ${tag}`);
  if (g.length >= 30 && Math.abs(med - emb) > 0.001) P(`LINE_BENCHMARK 档${lo} 嵌入${emb}≠数据中位${med}`);
}
// 90%+ 不外推核验:94%热门开 -2.5(对85%基准2.5=残差0)应判"同类正常";若代码仍藏 2.75 外推→会误判"浅于同类"
const n90 = feats.filter(x => x.pFav >= 0.90).length;
const chk90 = diagnoseUpsetRisk({ p1x2Fav: 0.94, ahLine: -2.5, totalsLine: 4 });
if (chk90?.lineDepth === "同类正常") OK(`90%+(N=${n90})不外推:94%@-2.5判"同类正常"(基准并入2.5,未编造2.75)`);
else P(`90%+档可能仍外推:94%@-2.5 判"${chk90?.lineDepth}"(应"同类正常")`);

// ── 检查2:大小球走势触发 数值复现 + 覆盖率 + OOS ──
console.log("\n【2】大小球走势触发:数值复现 + 覆盖率");
const withMove = feats.filter(x => Number.isFinite(x.ovO) && Number.isFinite(x.ovC));
console.log(`  有初+收大小球双盘场=${withMove.length}/${feats.length}(覆盖${(withMove.length / feats.length * 100).toFixed(0)}%)`);
const up = withMove.filter(x => (x.ovC - x.ovO) > 0.04), dn = withMove.filter(x => (x.ovC - x.ovO) < -0.04);
const upR = up.filter(x => x.over25).length / up.length, dnR = dn.filter(x => x.over25).length / dn.length;
console.log(`  加注→大球 ${(upR * 100).toFixed(1)}%(嵌入63%·N=${up.length}) · 退烧→大球 ${(dnR * 100).toFixed(1)}%(嵌入44%·N=${dn.length})`);
if (Math.abs(upR - 0.63) > 0.03) P(`大小球加注命中${(upR * 100).toFixed(1)}% 偏离嵌入63%超3pp`);
if (Math.abs(dnR - 0.44) > 0.03) P(`大小球退烧命中${(dnR * 100).toFixed(1)}% 偏离嵌入44%超3pp`);

// ── 检查3:diagnoseUpsetRisk 边界鲁棒性(NaN/缺失/极值不崩、不编)──
console.log("\n【3】diagnoseUpsetRisk 边界鲁棒性");
const edge = [{}, { p1x2Fav: NaN }, { p1x2Fav: 0 }, { p1x2Fav: 1 }, { p1x2Fav: 1.5 }, { p1x2Fav: -0.2 },
  { p1x2Fav: 0.7, ahLine: NaN, totalsLine: NaN, pOver25: NaN, drawImplied: NaN }, { p1x2Fav: 0.7, ahLine: "x" }];
let edgeOk = true;
for (const inp of edge) {
  try { const r = diagnoseUpsetRisk(inp); const bad = inp.p1x2Fav > 0 && inp.p1x2Fav < 1 ? (r == null) : (r != null);
    if (bad) { edgeOk = false; P(`边界输入 ${JSON.stringify(inp)} 返回异常: ${JSON.stringify(r)?.slice(0, 60)}`); } }
  catch (e) { edgeOk = false; P(`边界输入 ${JSON.stringify(inp)} 抛错: ${e.message}`); }
}
if (edgeOk) OK("8种边界输入全部安全(无效→null·有效→对象,无崩溃)");
// analyzeTotalsMovement 边界
let tmOk = true;
for (const inp of [{}, { closeOverProb: null }, { closeOverProb: 0.5 }, { openOverProb: 0.5, closeOverProb: NaN }]) {
  try { analyzeTotalsMovement(inp); } catch (e) { tmOk = false; P(`analyzeTotalsMovement ${JSON.stringify(inp)} 抛错:${e.message}`); }
}
if (overImpliedProb(0, 0) !== null) P("overImpliedProb(0,0) 应返回null"); else if (tmOk) OK("analyzeTotalsMovement/overImpliedProb 边界安全");

// ── 检查4:upsetType 可达性(防平是否被双向永远抢先=死代码)+ 频率分布 ──
console.log("\n【4】upsetType 各档可达性/频率(在8906场上跑生产函数)");
const typeCount = {};
for (const x of feats) {
  const dg = diagnoseUpsetRisk({ p1x2Fav: x.pFav, ahLine: -x.ahDepthC, totalsLine: null, pOver25: x.ovC, drawImplied: x.pDraw });
  if (dg) typeCount[dg.upsetType] = (typeCount[dg.upsetType] || 0) + 1;
}
for (const [t, n] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(30)} ${n} (${(n / feats.length * 100).toFixed(1)}%)`);
// 防平档已作为死代码删除(对抗审计证不可达·平局风险并入双向);核验:①不再出现防平 ②高平局场确被双向覆盖
const fangping = Object.keys(typeCount).find(t => /防平/.test(t));
if (fangping) P(`🟡防平档应已删除但仍出现(${typeCount[fangping]}场)=死代码残留`);
else OK("🟡防平死代码已删除(不再出现);平局风险并入🔴双向爆冷");
const highDraw = feats.filter(x => x.pDraw >= 0.30);
const hdToShuang = highDraw.filter(x => {
  const dg = diagnoseUpsetRisk({ p1x2Fav: x.pFav, ahLine: -x.ahDepthC, totalsLine: null, pOver25: x.ovC, drawImplied: x.pDraw });
  return dg && /双向爆冷/.test(dg.upsetType);
}).length;
if (highDraw.length >= 20 && hdToShuang / highDraw.length < 0.9) P(`高平局隐含场(${highDraw.length})仅${hdToShuang}归双向=平局风险未被覆盖`);
else OK(`高平局隐含场(N=${highDraw.length})${highDraw.length ? Math.round(hdToShuang / highDraw.length * 100) : 0}%归双向爆冷=平局风险有覆盖`);

// ── 检查5:band×upsetType 内部一致性(无矛盾) ──
console.log("\n【5】band × upsetType 一致性(查矛盾:低风险却band高 / 双向却band低 等)");
let contradiction = 0;
for (const x of feats) {
  const dg = diagnoseUpsetRisk({ p1x2Fav: x.pFav, ahLine: -x.ahDepthC, totalsLine: null, pOver25: x.ovC, drawImplied: x.pDraw });
  if (!dg) continue;
  if (/低风险/.test(dg.upsetType) && dg.band === "高") contradiction++;
  if (/双向爆冷/.test(dg.upsetType) && dg.band === "低") contradiction++;
}
if (contradiction > 0) P(`band×upsetType 矛盾 ${contradiction} 场`); else OK("band×upsetType 零矛盾");

// ── 检查6:生产链路活性(predictFixture 真出 upsetDiagnosis + totalsMovementSignal)──
console.log("\n【6】生产链路活性:predictFixture 是否真产出两个新字段");
const snap = {
  europeanOdds: { initial: { home: 1.5, draw: 4, away: 6.5 }, current: { home: 1.45, draw: 4.2, away: 7 } },
  asianHandicap: { initial: { line: -1, homeWater: 1.9, awayWater: 1.9 }, current: { line: -1, homeWater: 1.9, awayWater: 1.9 } },
  totals: { initial: { line: 2.5, over: 2.0, under: 1.8 }, current: { line: 2.5, over: 1.7, under: 2.1 } },
};
const pred = predictFixture({ home: "A", away: "B", competition: "英超", league: "E0" }, [snap], 0, {});
if (pred.upsetDiagnosis && pred.upsetDiagnosis.band) OK(`upsetDiagnosis 活:band=${pred.upsetDiagnosis.band} type=${pred.upsetDiagnosis.upsetType}`); else P("upsetDiagnosis 生产链路为空/未产出");
if (pred.totalsMovementSignal && pred.totalsMovementSignal.lean) OK(`totalsMovementSignal 活:${pred.totalsMovementSignal.lean} ${pred.totalsMovementSignal.note?.slice(0, 30)}`); else P("totalsMovementSignal 生产链路为空/未产出");
// de-vig 校验:europeanOdds.current de-vig 后 fav 概率应 <1 且合理
const dgFav = pred.upsetDiagnosis?.favWinProb;
if (dgFav != null && (dgFav <= 0 || dgFav >= 1)) P(`favWinProb 越界 ${dgFav}(p1x2Fav 可能未 de-vig)`);
else if (dgFav != null) OK(`favWinProb=${dgFav}(de-vig 合理)`);

console.log(`\n══ 对抗审计完成:发现 ${problems.length} 个问题 ${problems.length ? "🔴需修" : "🟢全清"} ══`);
if (problems.length) { console.log("问题清单:"); problems.forEach((p, i) => console.log(` ${i + 1}. ${p}`)); }
