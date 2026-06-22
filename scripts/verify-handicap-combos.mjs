#!/usr/bin/env node
/**
 * 竞彩让球(让胜/让平/让负)组合条件挖掘(2026-06-22)。
 * 口径:主队为热门时按"竞彩让1球"折算 → 让胜=主净胜≥2 · 让平=主胜1球 · 让负=主平或输。
 * 客队为热门时镜像(客让1球)。底座 8906场五大联赛。每条带 N + z。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
const { matches } = await loadFootballDataMatches();
const pct = (x) => (x * 100).toFixed(1) + "%";
function rate(arr, pred) { const n = arr.length, k = arr.filter(pred).length; return { n, k, p: n ? k / n : 0 }; }
function z(p, p0, n) { return n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0; }

function feat(m) {
  const oc = m.oddsClose, od = m.oddsDecimal; if (!oc || !m.asian || !od) return null;
  const hg = m.homeGoals, ag = m.awayGoals; if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const favHome = oc.home >= oc.away;               // 热门是主队?
  const favG = favHome ? hg : ag, dogG = favHome ? ag : hg;
  const margin = favG - dogG;                        // 热门净胜球
  // 竞彩让1球(热门让1):
  const hcWin = margin >= 2, hcDraw = margin === 1, hcLose = margin <= 0;
  const lineC = Math.abs(Number(m.asian.lineClose ?? m.asian.line));
  return {
    pFavC: favHome ? oc.home : oc.away, pDrawC: oc.draw,
    dFavC: favHome ? (m.oddsDecimalClose?.home) : (m.oddsDecimalClose?.away),
    ahC: lineC, overC: m.overProbClose,
    hcWin, hcDraw, hcLose, favHome,
    margin,
  };
}
const F = matches.map(feat).filter(Boolean);
const bW = rate(F, x => x.hcWin).p, bD = rate(F, x => x.hcDraw).p, bL = rate(F, x => x.hcLose).p;
console.log(`\n══════ 竞彩让1球(热门让1) · ${F.length}场 ══════`);
console.log(`基线: 让胜(净胜≥2)${pct(bW)} · 让平(胜1球)${pct(bD)} · 让负(平或输)${pct(bL)}`);

// ① 按热门实力档(收盘隐含)→ 让胜/让平/让负
console.log(`\n① 热门实力档(收盘隐含胜率) → 让胜/让平/让负`);
for (const [lo,hi,lab] of [[0.45,0.55,"均势~小热"],[0.55,0.65,"中热"],[0.65,0.75,"大热"],[0.75,0.85,"超大热"],[0.85,1.01,"碾压热"]]) {
  const g = F.filter(x => x.pFavC>=lo && x.pFavC<hi); if (g.length<60) continue;
  const w=rate(g,x=>x.hcWin), d=rate(g,x=>x.hcDraw), l=rate(g,x=>x.hcLose);
  console.log(`  ${lab.padEnd(8)}(${lo}-${hi}) N=${String(g.length).padStart(4)} 让胜${pct(w.p).padStart(6)}(z${z(w.p,bW,g.length).toFixed(1)}) 让平${pct(d.p).padStart(6)}(z${z(d.p,bD,g.length).toFixed(1)}) 让负${pct(l.p).padStart(6)}(z${z(l.p,bL,g.length).toFixed(1)})`);
}

// ② 实力档 × 亚盘线深 → 让胜率(让球盘真正吃线的格子)
console.log(`\n② 实力档 × 收盘亚盘线深 → 让胜/让负率`);
for (const [lo,hi,lab] of [[0.55,0.70,"中热"],[0.70,0.85,"大热"]]) {
  for (const [alo,ahi,al] of [[0,0.75,"浅≤0.5"],[0.75,1.25,"中1球"],[1.25,9,"深≥1.5"]]) {
    const g = F.filter(x => x.pFavC>=lo&&x.pFavC<hi && x.ahC>=alo&&x.ahC<ahi); if (g.length<60) continue;
    const w=rate(g,x=>x.hcWin), l=rate(g,x=>x.hcLose);
    console.log(`  ${lab}×${al.padEnd(8)} N=${String(g.length).padStart(4)} 让胜${pct(w.p).padStart(6)}(z${z(w.p,bW,g.length).toFixed(1)}) 让负${pct(l.p).padStart(6)}(z${z(l.p,bL,g.length).toFixed(1)})`);
  }
}

// ③ 实力档 × 大小球预期 → 让胜率(球多的场强队更容易拉开净胜2球)
console.log(`\n③ 大热(隐含≥0.65) × 大小球收盘预期 → 让胜率`);
const heavy = F.filter(x => x.pFavC>=0.65);
const bWh = rate(heavy,x=>x.hcWin).p, bLh=rate(heavy,x=>x.hcLose).p;
console.log(`  [大热基线] N=${heavy.length} 让胜${pct(bWh)} 让负${pct(bLh)}`);
for (const [lo,hi,lab] of [[0,0.50,"小球预期<50%"],[0.50,0.60,"中性50-60%"],[0.60,1.01,"大球预期≥60%"]]) {
  const g = heavy.filter(x => x.overC!=null && x.overC>=lo && x.overC<hi); if (g.length<50) continue;
  const w=rate(g,x=>x.hcWin), l=rate(g,x=>x.hcLose);
  console.log(`  ${lab.padEnd(14)} N=${String(g.length).padStart(4)} 让胜${pct(w.p).padStart(6)}(z${z(w.p,bWh,g.length).toFixed(1)}) 让负${pct(l.p).padStart(6)}(z${z(l.p,bLh,g.length).toFixed(1)})`);
}
console.log(`\n说明: 让1球下 大热也常"让平"(净胜恰好1球) → 受让方半球/平手盘才是钱;🟢强|z|≥2.6 ·🟡≥2 ·⚪<2噪声`);
