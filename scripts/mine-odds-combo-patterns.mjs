#!/usr/bin/env node
/**
 * 1X2赔率档 × 让球线走势 × 大小球 的"条件组合共性"挖掘 + 时间外样本(OOS)验证(2026-06-22)。
 *
 * 用户假设(必须先验证,不照单全收):
 *   H1 "胜赔率1.44 容易爆冷"
 *   H2 "胜1.44+平4.00+负8.00 + 让0.5→1 → 易出平"
 *   H3 "胜1.9 平3.45 负2.8 → 易出平"(均势低平赔)
 *
 * 数据底座:loadFootballDataMatches() = 8906场五大联赛(2021-2026)。
 *   赔率=欧赔/Pinnacle小数(oddsDecimal开/oddsDecimalClose收) —— 没有竞彩历史赔率(免费墙)。
 *   竞彩等价:返还率低→同队竞彩赔率更低,欧赔1.44 ≈ 竞彩1.30档;欧赔1.55 ≈ 竞彩1.44档。下表已并列标注。
 *
 * 防过拟合铁律(遵 reference_signal_backtest_findings + feedback_no_fallback_absolute):
 *   · 每条组合带 N + 二项 z(对全样本基线)。
 *   · 关键:TRAIN(2021-2024)找 → TEST(2025-2026)confirm。只认 train 与 test 同向 且 test 不翻车 的。
 *   · 不 cherry-pick:同档全列,坏的也列。市场高效是先验,真 edge 罕见。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
const { matches } = await loadFootballDataMatches();
const pct = (x) => (x * 100).toFixed(1) + "%";
function rate(arr, pred) { const n = arr.length, k = arr.filter(pred).length; return { n, k, p: n ? k / n : 0 }; }
function z(p, p0, n) { return n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0; }
function flag(zz) { return Math.abs(zz) >= 2.6 ? "🟢强" : Math.abs(zz) >= 2 ? "🟡" : "⚪噪声"; }

function feat(m) {
  const od = m.oddsDecimal, oc = m.oddsDecimalClose, op = m.oddsClose; // op=收盘隐含概率
  if (!od || !oc || !op || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals;
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const favHome = oc.home <= oc.away;                  // 收盘赔率低=热门
  const favDec = favHome ? oc.home : oc.away;          // 收盘热门小数赔
  const dogDec = favHome ? oc.away : oc.home;
  const drawDec = oc.draw;
  const favDecOpen = favHome ? od.home : od.away;      // 开盘热门小数赔
  const favMove = favDec - favDecOpen;                 // <0 热门赔率被压低=加注 >0 退烧
  const lineO = Math.abs(Number(m.asian.line));        // 亚盘初线(绝对值,深度)
  const lineC = Math.abs(Number(m.asian.lineClose ?? m.asian.line)); // 终线
  const lineMove = lineC - lineO;                      // >0 让球加深 <0 退浅
  const favGoals = favHome ? hg : ag, dogGoals = favHome ? ag : hg;
  const margin = favGoals - dogGoals;                  // 热门净胜球
  const favWin = result === (favHome ? "home" : "away");
  return {
    date: m.date, league: m.league, result, favHome,
    favDec, dogDec, drawDec, favMove,
    lineO, lineC, lineMove,
    overC: m.overProbClose,
    isDraw: result === "draw",
    favWin,                                            // 热门直接胜
    favLose: !favWin && result !== "draw",             // 热门被翻盘输
    notWin: !favWin,                                   // 热门不胜
    margin,
    hcWin: margin >= 2,                                // 竞彩让1球:让胜
    hcDraw: margin === 1,                              // 让平(净胜恰好1)
    hcLose: margin <= 0,                               // 让负(平或输)
  };
}
const F = matches.map(feat).filter(Boolean);
const TR = F.filter(x => x.date < "2025-01-01");        // 找
const TE = F.filter(x => x.date >= "2025-01-01");       // confirm
console.log(`\n████ 1X2赔率档×让球走势×大小球 组合共性 + OOS验证 ████`);
console.log(`全样本 ${F.length}场 | TRAIN(21-24) ${TR.length} | TEST(25-26) ${TE.length}`);
console.log(`基线: 热门不胜 全${pct(rate(F,x=>x.notWin).p)} / train${pct(rate(TR,x=>x.notWin).p)} / test${pct(rate(TE,x=>x.notWin).p)}`);
console.log(`基线: 平局   全${pct(rate(F,x=>x.isDraw).p)} / train${pct(rate(TR,x=>x.isDraw).p)} / test${pct(rate(TE,x=>x.isDraw).p)}`);

// 通用:给一个筛选器,出 全/train/test 三段 (rate vs 各自基线 z),并裁决 OOS
function judge(label, filt, target /*x=>bool*/, baseAll, baseTr, baseTe) {
  const ga = F.filter(filt), gtr = TR.filter(filt), gte = TE.filter(filt);
  const a = rate(ga, target), tr = rate(gtr, target), te = rate(gte, target);
  const za = z(a.p, baseAll, a.n), ztr = z(tr.p, baseTr, tr.n), zte = z(te.p, baseTe, te.n);
  // OOS裁决:train显著(|z|>=2)且 test同向 且 test效应未消失(同向且|Δ|>=该效应一半)
  const sameDir = (tr.p - baseTr) * (te.p - baseTe) > 0;
  const trSig = Math.abs(ztr) >= 2;
  const teHold = sameDir && Math.abs(te.p - baseTe) >= Math.abs(tr.p - baseTr) * 0.4;
  let verdict = "—样本不足";
  if (tr.n >= 40 && te.n >= 25) {
    verdict = !trSig ? "⚪train就不显著" : !sameDir ? "❌OOS反向(过拟合)" : !teHold ? "🟠OOS大幅缩水(疑过拟合)" : "✅OOS稳健";
  }
  console.log(`  ${label}`);
  console.log(`     全 N=${String(a.n).padStart(4)} ${pct(a.p).padStart(6)}(z${za.toFixed(1)}) | train N=${String(tr.n).padStart(4)} ${pct(tr.p).padStart(6)}(z${ztr.toFixed(1)}) | test N=${String(te.n).padStart(4)} ${pct(te.p).padStart(6)}(z${zte.toFixed(1)}) → ${verdict}`);
  return { a, tr, te, verdict };
}

const bDrawA = rate(F,x=>x.isDraw).p, bDrawTr = rate(TR,x=>x.isDraw).p, bDrawTe = rate(TE,x=>x.isDraw).p;
const bNwA = rate(F,x=>x.notWin).p, bNwTr = rate(TR,x=>x.notWin).p, bNwTe = rate(TE,x=>x.notWin).p;

// ═══ ① H1验证:热门收盘小数赔率档 → 热门不胜率(含1.44档)═══
console.log(`\n① 热门收盘欧赔档 → 热门不胜率(H1:1.44易爆冷? 竞彩等价档并列)`);
const bands = [[1.20,1.30,"竞彩~1.15"],[1.30,1.40,"竞彩~1.22"],[1.40,1.50,"竞彩~1.30"],[1.50,1.62,"竞彩~1.40"],[1.62,1.80,"竞彩~1.50"],[1.80,2.00,"竞彩~1.62"],[2.00,2.30,"竞彩~1.80"]];
for (const [lo,hi,jc] of bands) {
  judge(`欧赔[${lo}-${hi}) (${jc})`, x=>x.favDec>=lo&&x.favDec<hi, x=>x.notWin, bNwA,bNwTr,bNwTe);
}

// ═══ ② H3验证:均势低平赔 → 平局率(胜1.9/平3.45/负2.8型)═══
console.log(`\n② 均势盘(热门赔1.7-2.1) × 平局赔档 → 平局率(H3:低平赔易出平?)`);
const balanced = x => x.favDec>=1.70 && x.favDec<=2.20;
for (const [lo,hi] of [[3.0,3.4],[3.4,3.7],[3.7,4.0],[4.0,9]]) {
  judge(`平赔[${lo}-${hi})`, x=>balanced(x)&&x.drawDec>=lo&&x.drawDec<hi, x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);
}

// ═══ ③ H2验证:大热(欧赔1.4-1.55) × 让球线 0.5→1 加深 → 平局率 ═══
console.log(`\n③ 热门(欧赔1.40-1.60)× 让球线走势 → 平局率(H2:让0.5升1易出平?)`);
const fav15 = x => x.favDec>=1.40 && x.favDec<=1.60;
judge(`让线加深(lineMove>0,如0.5→1)`, x=>fav15(x)&&x.lineMove>0.1, x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);
judge(`让线持平(|lineMove|≤0.1)`,     x=>fav15(x)&&Math.abs(x.lineMove)<=0.1, x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);
judge(`让线退浅(lineMove<-0.1)`,      x=>fav15(x)&&x.lineMove<-0.1, x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);
console.log(`   —同上但看"热门不胜率":`);
judge(`让线加深→热门不胜`, x=>fav15(x)&&x.lineMove>0.1, x=>x.notWin, bNwA,bNwTr,bNwTe);

// ═══ ④ H2精确组合:热门1.40-1.55 + 平3.8-4.3 + 客7-9 + 让线加深 ═══
console.log(`\n④ H2精确复刻:热门1.40-1.55 + 平3.7-4.5 + 客6.5-9.5 + 让线加深 → 平局率`);
const h2 = x => x.favDec>=1.40&&x.favDec<=1.55 && x.drawDec>=3.7&&x.drawDec<=4.5 && x.dogDec>=6.5&&x.dogDec<=9.5;
judge(`H2全条件(含让线加深)`, x=>h2(x)&&x.lineMove>0.05, x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);
judge(`H2去掉让线条件`,        x=>h2(x),                    x=>x.isDraw, bDrawA,bDrawTr,bDrawTe);

// ═══ ⑤ 热门加注/退烧(欧赔被压低/抬高)× 是否爆冷(已知噪声,复核)═══
console.log(`\n⑤ 热门欧赔走势(被加注=赔率压低 vs 退烧)→ 热门不胜率`);
judge(`热门被加注(favMove<-0.03)`, x=>x.favMove<-0.03, x=>x.notWin, bNwA,bNwTr,bNwTe);
judge(`热门退烧(favMove>+0.03)`,   x=>x.favMove>0.03,  x=>x.notWin, bNwA,bNwTr,bNwTe);

// ═══ ⑥ 六方向全景:每个条件下 胜/平/负 + 让胜/让平/让负(带z,对全样本基线)═══
// 全样本六方向基线
const B = {
  win: rate(F,x=>x.favWin).p, draw: rate(F,x=>x.isDraw).p, lose: rate(F,x=>x.favLose).p,
  hw: rate(F,x=>x.hcWin).p, hd: rate(F,x=>x.hcDraw).p, hl: rate(F,x=>x.hcLose).p,
};
const Btr = { win:rate(TR,x=>x.favWin).p, draw:rate(TR,x=>x.isDraw).p, lose:rate(TR,x=>x.favLose).p, hw:rate(TR,x=>x.hcWin).p, hd:rate(TR,x=>x.hcDraw).p, hl:rate(TR,x=>x.hcLose).p };
const Bte = { win:rate(TE,x=>x.favWin).p, draw:rate(TE,x=>x.isDraw).p, lose:rate(TE,x=>x.favLose).p, hw:rate(TE,x=>x.hcWin).p, hd:rate(TE,x=>x.hcDraw).p, hl:rate(TE,x=>x.hcLose).p };
console.log(`\n⑥ 六方向全景(热门视角) · 全样本基线: 胜${pct(B.win)} 平${pct(B.draw)} 负${pct(B.lose)} | 让胜${pct(B.hw)} 让平${pct(B.hd)} 让负${pct(B.hl)}`);
function panel(label, filt) {
  const ga = F.filter(filt), gtr = TR.filter(filt), gte = TE.filter(filt);
  if (ga.length < 40) { console.log(`  ${label}  N=${ga.length} (样本不足跳过)`); return; }
  const cell = (k, pred) => {
    const a = rate(ga,pred), tr = rate(gtr,pred), te = rate(gte,pred);
    const za = z(a.p, B[k], a.n);
    // OOS:train方向与test方向一致 且 test同向
    const sd = (tr.p-Btr[k])*(te.p-Bte[k]) > 0;
    const ztr = z(tr.p,Btr[k],tr.n);
    const mark = Math.abs(za)>=2.6 && Math.abs(ztr)>=2 && sd ? "🟢" : Math.abs(za)>=2 ? (sd?"🟡":"✗") : "";
    return `${pct(a.p).padStart(6)}${mark}`;
  };
  console.log(`  ${label.padEnd(26)} N=${String(ga.length).padStart(4)} | 胜${cell("win",x=>x.favWin)} 平${cell("draw",x=>x.isDraw)} 负${cell("lose",x=>x.favLose)} ‖ 让胜${cell("hw",x=>x.hcWin)} 让平${cell("hd",x=>x.hcDraw)} 让负${cell("hl",x=>x.hcLose)}`);
}
console.log(`  —按热门收盘欧赔档:`);
for (const [lo,hi,jc] of bands) panel(`欧赔[${lo}-${hi})(${jc})`, x=>x.favDec>=lo&&x.favDec<hi);
console.log(`  —均势盘(欧赔1.7-2.2)按平赔档:`);
for (const [lo,hi] of [[3.0,3.4],[3.4,3.7],[3.7,4.0],[4.0,9]]) panel(`均势·平赔[${lo}-${hi})`, x=>x.favDec>=1.7&&x.favDec<=2.2&&x.drawDec>=lo&&x.drawDec<hi);
console.log(`  —热门(欧赔1.4-1.6)按让球线走势:`);
panel(`让线加深(0.5→1型)`, x=>x.favDec>=1.4&&x.favDec<=1.6&&x.lineMove>0.1);
panel(`让线持平`,          x=>x.favDec>=1.4&&x.favDec<=1.6&&Math.abs(x.lineMove)<=0.1);
panel(`让线退浅`,          x=>x.favDec>=1.4&&x.favDec<=1.6&&x.lineMove<-0.1);

console.log(`\n标记: 🟢全样本z≥2.6且train显著且OOS同向(可信) · 🟡全样本z≥2待confirm · ✗OOS反向(过拟合) · 空=噪声`);
console.log(`\n裁决说明: ✅OOS稳健=train显著且25-26样本同向不缩水(可信) · 🟠/❌=过拟合(只train好看,不可作触发) · ⚪=本就不显著`);
console.log(`赔率口径=欧赔/Pinnacle小数收盘(非竞彩);竞彩同队赔率更低,见各档"竞彩~"等价标注。`);
