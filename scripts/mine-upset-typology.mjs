#!/usr/bin/env node
/**
 * 爆冷分型·临界值标准(2026-06-16 用户:"什么叫深/浅·临界值在哪·什么样易爆冷出平·什么样爆冷出负·
 *   什么样没风险·什么样叫诱盘"。要明确临界值,不停留定性)。数据同 8906场五大联赛。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const { matches } = await loadFootballDataMatches();
function feat(m) {
  const o = m.odds, oc = m.oddsClose; if (!o || !oc || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals; if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const favSide = oc.home >= oc.away ? "home" : "away";
  const lineC = Number(m.asian.lineClose ?? m.asian.line);
  const pin = m.oddsPinnacleClose;
  return {
    pFav: oc[favSide], pDraw: oc.draw, ahDepthC: Math.abs(lineC), ovC: m.overProbClose,
    euDriftFav: oc[favSide] - o[favSide], pinFav: pin ? pin[favSide] : null,
    result, favSide,
    favWin: result === favSide, favDrew: result === "draw",
    favLost: result !== favSide && result !== "draw",
  };
}
const F = matches.map(feat).filter(Boolean);
const rate = (a, p) => { const n = a.length, k = a.filter(p).length; return { n, p: n ? k / n : 0 }; };
const PC = (x) => (x * 100).toFixed(0) + "%";

console.log(`\n══════ 爆冷分型 · 临界值标准 · ${F.length}场 ══════`);
const B = { win: rate(F, x => x.favWin).p, draw: rate(F, x => x.favDrew).p, lost: rate(F, x => x.favLost).p };
console.log(`总基线: 热门胜${PC(B.win)} / 平${PC(B.draw)} / 热门负${PC(B.lost)}`);

// ① 大小球线 → 爆冷出平 vs 出负(关键:低球闷局→平;高球对攻→负)
console.log(`\n① 大小球收盘概率分档 → 热门胜/平/负 三分(看"出平还是出负")`);
console.log(`   ${"大小球档".padEnd(16)}N     热门胜  平    热门负`);
for (const [lab, lo, hi] of [["极低<40%(铁闷)", 0, 0.40], ["低40~48%", 0.40, 0.48], ["中48~56%", 0.48, 0.56], ["高56~64%", 0.56, 0.64], ["极高≥64%(对攻)", 0.64, 1.01]]) {
  const g = F.filter(x => x.ovC != null && x.ovC >= lo && x.ovC < hi);
  if (g.length < 30) continue;
  console.log(`   ${lab.padEnd(16)}${String(g.length).padStart(4)}  ${PC(rate(g, x => x.favWin).p).padStart(5)} ${PC(rate(g, x => x.favDrew).p).padStart(5)} ${PC(rate(g, x => x.favLost).p).padStart(5)}`);
}

// ② 1X2实力 → 爆冷出平 vs 出负(强热门若爆冷多半是平,中等热门更可能直接被翻)
console.log(`\n② 1X2热门强度 → 热门胜/平/负 三分 + "爆冷中平局占比"`);
console.log(`   ${"热门强度".padEnd(14)}N     热门胜  平    热门负  |爆冷里平占比`);
for (const [lab, lo, hi] of [["势均50~58%", 0.50, 0.58], ["中热58~66%", 0.58, 0.66], ["强热66~74%", 0.66, 0.74], ["大热74~82%", 0.74, 0.82], ["超大热≥82%", 0.82, 1.01]]) {
  const g = F.filter(x => x.pFav >= lo && x.pFav < hi);
  if (g.length < 30) continue;
  const ups = g.filter(x => !x.favWin);
  const drawShare = ups.length ? rate(ups, x => x.favDrew).p : 0;
  console.log(`   ${lab.padEnd(14)}${String(g.length).padStart(4)}  ${PC(rate(g, x => x.favWin).p).padStart(5)} ${PC(rate(g, x => x.favDrew).p).padStart(5)} ${PC(rate(g, x => x.favLost).p).padStart(5)}  | ${PC(drawShare)}`);
}

// ③ 大小球×实力 交叉:"易爆冷平"和"易爆冷负"和"无风险"的临界组合
console.log(`\n③ 交叉:1X2强度 × 大小球 → 定位"易出平/易出负/无风险"`);
const cells = [];
for (const [sl, slo, shi] of [["势均~中热<66%", 0.50, 0.66], ["强热66~78%", 0.66, 0.78], ["大热≥78%", 0.78, 1.01]]) {
  for (const [gl, glo, ghi] of [["低球<48%", 0, 0.48], ["中球48~58%", 0.48, 0.58], ["高球≥58%", 0.58, 1.01]]) {
    const g = F.filter(x => x.pFav >= slo && x.pFav < shi && x.ovC != null && x.ovC >= glo && x.ovC < ghi);
    if (g.length < 25) continue;
    const d = rate(g, x => x.favDrew).p, l = rate(g, x => x.favLost).p, w = rate(g, x => x.favWin).p;
    let tag = "中性";
    if (w >= 0.62 && d + l <= 0.40) tag = "🟢低风险(可胆)";
    else if (d >= 0.30) tag = "🟡易爆冷平";
    else if (l >= 0.30) tag = "🔴易爆冷负";
    cells.push({ 组合: `${sl} × ${gl}`, N: g.length, 胜: PC(w), 平: PC(d), 负: PC(l), 判定: tag });
  }
}
console.table(cells);

// ④ 诱盘(trap)实证:公众猛加注热门 但 Pinnacle锐盘不跟/反向 → 热门是否真underperform?
console.log(`\n④ 诱盘检验:欧赔热门被公众加注 vs Pinnacle锐盘脸色 → 热门实际胜率`);
const wp = F.filter(x => x.pinFav != null && Number.isFinite(x.euDriftFav));
const bw = rate(wp, x => x.favWin).p;
console.log(` 有锐盘场 热门基线胜率${PC(bw)} N=${wp.length}`);
const steamPublic = wp.filter(x => x.euDriftFav > 0.03);                 // 公众猛加注
const steamButSharpLower = steamPublic.filter(x => x.pinFav < x.pFav - 0.02); // 锐盘比软盘更不看好=疑诱盘
const steamSharpAgree = steamPublic.filter(x => x.pinFav >= x.pFav - 0.02);
console.log(` 公众加注热门(欧赔+>3pp) N=${steamPublic.length} 实际胜率${PC(rate(steamPublic, x => x.favWin).p)}`);
console.log(`   └─疑诱盘(锐盘比软盘低>2pp) N=${steamButSharpLower.length} 实际胜率${PC(rate(steamButSharpLower, x => x.favWin).p)} ${steamButSharpLower.length < 50 ? "⚠样本不足" : ""}`);
console.log(`   └─真共识(锐盘认同)        N=${steamSharpAgree.length} 实际胜率${PC(rate(steamSharpAgree, x => x.favWin).p)}`);

console.log(`\n══ 临界值小结(可作触发标准)══`);
console.log(` 深/浅:以"同1X2实力档中位线"为基准(见 mine-upset-drivers ①),残差≤-0.25=浅、≥+0.25=深`);
console.log(` 易爆冷平:大小球收盘<48% 且 1X2强热≥66%(强队啃不开铁桶)`);
console.log(` 易爆冷负:大小球收盘≥58% 且 1X2≤66%(对攻开放+实力没拉开)`);
console.log(` 无风险(可胆):1X2≥78% 且 大小球≥58% 且 让球线深于同类`);
console.log(` 诱盘:见④——公众加注+锐盘不跟,但实证其edge(样本/方向),诚实以数据为准`);
