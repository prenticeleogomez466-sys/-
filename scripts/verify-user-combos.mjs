#!/usr/bin/env node
/**
 * 用户复合组合定点验证(2026-06-22)。
 * 底座:loadFootballDataMatches() 8906场五大联赛(2021-2026)。
 * 诚实:每条带 N + 二项 z;|z|<2=噪声内不可作触发。欧赔+亚盘代理竞彩方向(无竞彩历史)。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
const { matches } = await loadFootballDataMatches();

function feat(m) {
  const o = m.odds, oc = m.oddsClose, od = m.oddsDecimal, odc = m.oddsDecimalClose;
  if (!o || !oc || !m.asian || !od) return null;
  const hg = m.homeGoals, ag = m.awayGoals;
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const favSide = oc.home >= oc.away ? "home" : "away";
  const lineO = Number(m.asian.line), lineC = Number(m.asian.lineClose ?? m.asian.line);
  return {
    result, favSide,
    pHomeC: oc.home, pDrawC: oc.draw, pAwayC: oc.away,
    pHomeO: o.home, pDrawO: o.draw, pAwayO: o.away,
    // 十进制赔率(开盘/收盘),对得上用户报的数字
    dHomeO: od.home, dDrawO: od.draw, dAwayO: od.away,
    dHomeC: odc?.home, dDrawC: odc?.draw, dAwayC: odc?.away,
    ahO: Math.abs(lineO), ahC: Math.abs(lineC), ahMove: Math.abs(lineC) - Math.abs(lineO),
    lineO, lineC,
    overC: m.overProbClose, overMove: (Number.isFinite(m.overProbClose) && Number.isFinite(m.overProb)) ? m.overProbClose - m.overProb : null,
    isDraw: result === "draw",
    favUpset: result !== favSide,
    homeWin: result === "home", awayWin: result === "away",
    totalGoals: hg + ag,
  };
}
const F = matches.map(feat).filter(Boolean);
const pct = (x) => (x * 100).toFixed(1) + "%";
function rate(arr, pred) { const n = arr.length, k = arr.filter(pred).length; return { n, k, p: n ? k / n : 0 }; }
function z(p, p0, n) { return n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0; }
function show(label, sub, base, key) {
  const zz = z(sub.p, base, sub.n);
  const flag = Math.abs(zz) >= 2.6 ? "🟢强" : Math.abs(zz) >= 2 ? "🟡" : "⚪噪声";
  console.log(`  ${label.padEnd(40)} N=${String(sub.n).padStart(4)} ${key}=${pct(sub.p).padStart(6)} (基线${pct(base)}) Δ${((sub.p-base)*100>=0?"+":"")+((sub.p-base)*100).toFixed(1)}pp z=${zz.toFixed(1)} ${flag}`);
}

const baseDraw = rate(F, x => x.isDraw).p;
const baseUpset = rate(F, x => x.favUpset).p;
console.log(`\n══════ 用户复合组合验证 · ${F.length}场 ══════`);
console.log(`全样本基线: 平局${pct(baseDraw)} · 热门不胜${pct(baseUpset)}`);

// ── ① 主胜十进制赔率分档(收盘)→ 平局率/主胜率/客胜率(验证"胜1.44易爆冷"、"胜1.9易平") ──
console.log(`\n① 主胜收盘赔率分档 → 主胜/平局/客胜率(N≥40才列)`);
const dbuckets = [[1.0,1.30],[1.30,1.45],[1.45,1.60],[1.60,1.80],[1.80,2.00],[2.00,2.40],[2.40,3.20],[3.20,99]];
for (const [lo,hi] of dbuckets) {
  const g = F.filter(x => Number.isFinite(x.dHomeC) && x.dHomeC>=lo && x.dHomeC<hi);
  if (g.length < 40) continue;
  const hw = rate(g, x=>x.homeWin), dr = rate(g, x=>x.isDraw), aw = rate(g, x=>x.awayWin);
  console.log(`  主胜赔${lo.toFixed(2)}~${hi>=99?"∞":hi.toFixed(2)}  N=${String(g.length).padStart(4)}  主胜${pct(hw.p).padStart(6)}  平${pct(dr.p).padStart(6)}  客胜${pct(aw.p).padStart(6)}`);
}

// ── ② 组合A:强主热(主胜赔~1.44, 客胜赔高~8) + 让球线加深(0.5→1) → 易平? ──
console.log(`\n② 组合A:强主热(主胜赔1.38~1.52 & 客胜赔≥5) → 平局率;再叠加让球线加深`);
const A = F.filter(x => Number.isFinite(x.dHomeO) && x.dHomeO>=1.38 && x.dHomeO<=1.52 && x.dAwayO>=5);
const baseA = rate(A, x=>x.isDraw).p;
console.log(`  [强主热基线] N=${A.length} 平局${pct(baseA)} 主胜${pct(rate(A,x=>x.homeWin).p)} 不胜${pct(rate(A,x=>x.favUpset).p)}`);
show("叠加: 让球线加深(ahMove>0,如0.5→1)", rate(A.filter(x=>x.ahMove>0), x=>x.isDraw), baseA, "平局");
show("叠加: 让球线不变/退浅(ahMove<=0)", rate(A.filter(x=>x.ahMove<=0), x=>x.isDraw), baseA, "平局");
show("叠加: 大小球退烧(overMove<-0.03)", rate(A.filter(x=>x.overMove!=null&&x.overMove<-0.03), x=>x.isDraw), baseA, "平局");
// 与全样本基线对比:强主热本身平局率 vs 全样本
show("[强主热整体 vs 全样本平局基线]", rate(A,x=>x.isDraw), baseDraw, "平局");

// ── ③ 组合B:均势盘(主胜赔1.85~2.0, 平赔3.2~3.7, 客胜赔2.5~3.1)→ 易平? ──
console.log(`\n③ 组合B:均势盘(主胜赔1.85~2.00 & 平赔3.2~3.7 & 客胜赔2.5~3.1) → 平局率`);
const B = F.filter(x => Number.isFinite(x.dHomeO) && x.dHomeO>=1.85 && x.dHomeO<=2.00 && x.dDrawO>=3.2 && x.dDrawO<=3.7 && x.dAwayO>=2.5 && x.dAwayO<=3.1);
show("组合B整体 → 平局(vs全样本)", rate(B,x=>x.isDraw), baseDraw, "平局");
console.log(`  [组合B] N=${B.length} 平${pct(rate(B,x=>x.isDraw).p)} 主胜${pct(rate(B,x=>x.homeWin).p)} 客胜${pct(rate(B,x=>x.awayWin).p)}`);
// 更宽松的"均势"定义:收盘三者隐含都在 0.28~0.45
const balanced = F.filter(x => x.pHomeC>=0.30&&x.pHomeC<=0.50 && x.pAwayC>=0.25&&x.pAwayC<=0.45 && x.pDrawC>=0.25);
show("均势(收盘隐含主0.30-0.50/客0.25-0.45/平≥0.25)", rate(balanced,x=>x.isDraw), baseDraw, "平局");

// ── ④ 平局隐含概率分档(收盘 draw prob)→ 实际平局率(校准:是否平赔本身就预示平) ──
console.log(`\n④ 收盘平局隐含概率分档 → 实际平局率(平赔本身的预测力)`);
for (const [lo,hi] of [[0,0.22],[0.22,0.26],[0.26,0.29],[0.29,0.32],[0.32,1]]) {
  const g = F.filter(x => x.pDrawC>=lo && x.pDrawC<hi);
  if (g.length<40) continue;
  show(`平隐含${(lo*100).toFixed(0)}~${(hi*100).toFixed(0)}%`, rate(g,x=>x.isDraw), baseDraw, "实际平");
}

// ── ⑤ 高概率搭配挖掘:扫描"实力档×让球线深×大小球"组合,找平局率/爆冷率最高的格子 ──
console.log(`\n⑤ 高概率搭配扫描:实力档(收盘主胜隐含) × 亚盘线深 → 平局率/热门不胜率(N≥80)`);
const powBkt = [["均势 0.40-0.55",0.40,0.55],["小热 0.55-0.65",0.55,0.65],["中热 0.65-0.75",0.65,0.75],["大热 ≥0.75",0.75,1.01]];
const ahBkt = [["浅≤0.5",0,0.5],["中0.75-1",0.55,1.05],["深≥1.25",1.2,9]];
for (const [pl,plo,phi] of powBkt) {
  for (const [al,alo,ahi] of ahBkt) {
    const g = F.filter(x => x.pHomeC>=plo&&x.pHomeC<phi && x.ahC>=alo&&x.ahC<=ahi);
    if (g.length<80) continue;
    const dr=rate(g,x=>x.isDraw), up=rate(g,x=>x.favUpset);
    console.log(`  ${pl.padEnd(14)}×${al.padEnd(8)} N=${String(g.length).padStart(4)} 平${pct(dr.p).padStart(6)}(z${z(dr.p,baseDraw,g.length).toFixed(1)}) 不胜${pct(up.p).padStart(6)}(z${z(up.p,baseUpset,up.n).toFixed(1)})`);
  }
}
console.log(`\n说明: 🟢强|z|≥2.6 · 🟡|z|≥2 · ⚪噪声|z|<2(市场已定价,不可作独立触发)`);
