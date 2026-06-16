#!/usr/bin/env node
/**
 * 盘口共性挖掘引擎(2026-06-16 用户最终目的:跨上万场,按各档亚盘/大小球 + 欧亚初终盘走势,
 *   挖"为什么同样的盘结果不同"的共性 → 提炼成可触发条件)。
 *
 * 数据底座:loadFootballDataMatches() = 8907 场五大联赛(2021-2026),每场含
 *   欧赔初/收(odds/oddsClose) · Pinnacle锐盘初/收 · 亚盘线+水位初/收(asian.line/lineClose/water...)
 *   · 大小球初/收(overProb/overProbClose) · 赛果+半场 · 技术统计(shots/sot/corners/cards)。
 *
 * 诚实铁律(遵 feedback_no_fallback_absolute + reference_signal_backtest_findings):
 *   · 每条共性必带样本数 N + 相对基线的偏离 + 二项 z 值;|z|<2 标"噪声内·不可作触发"。
 *   · 不 cherry-pick:同一维度全档位一起出,坏的也列。市场高效是先验,真 edge 罕见。
 *   · 阵容/战意/球员特点=免费历史墙,本引擎只挖盘口/走势/技术统计,soft 因子缺标缺、不编。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const { matches } = await loadFootballDataMatches();

// ── 每场派生特征 + 赛果 ──
function feat(m) {
  const o = m.odds, oc = m.oddsClose;
  if (!o || !oc || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals;
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  // 热门(按收盘 1X2)
  const favSide = oc.home >= oc.away ? "home" : "away";
  const pFavClose = oc[favSide], pFavOpen = o[favSide];
  const euDrift = pFavClose - pFavOpen;                 // >0 热门被加注(steam) <0 退烧(drift)
  // 亚盘(热门视角的线深;line 负=主让)
  const lineO = Number(m.asian.line), lineC = Number(m.asian.lineClose ?? m.asian.line);
  const ahDepthC = Math.abs(lineC);
  const ahLineMove = Math.abs(lineC) - Math.abs(lineO); // >0 让球加深 <0 退浅
  // 水位移动(受让方/弱方水位收紧=钱压弱方)
  const awWaterMove = Number(m.asian.awayWaterClose ?? m.asian.awayWater) - Number(m.asian.awayWater);
  // 大小球
  const ovO = m.overProb, ovC = m.overProbClose;
  const overMove = (Number.isFinite(ovC) && Number.isFinite(ovO)) ? ovC - ovO : null;
  const totalGoals = hg + ag;
  // Pinnacle 锐盘漂移(热门侧)
  let pinDrift = null;
  if (m.oddsPinnacle && m.oddsPinnacleClose) pinDrift = m.oddsPinnacleClose[favSide] - m.oddsPinnacle[favSide];
  return {
    league: m.league, result, favSide, pFavClose, pFavOpen, euDrift,
    lineO, lineC, ahDepthC, ahLineMove, awWaterMove,
    ovC, overMove, totalGoals,
    pinDrift,
    favUpset: result !== favSide,                       // 热门未胜
    favDrew: result === "draw",                         // 平局
    favLost: result !== favSide && result !== "draw",   // 热门被翻盘输
    over25: totalGoals > 2.5, over35: totalGoals > 3.5, under15: totalGoals < 1.5,
  };
}
const F = matches.map(feat).filter(Boolean);

// ── 统计工具:rate + 二项 z(对比基线 p0)──
function rate(arr, pred) { const n = arr.length; const k = arr.filter(pred).length; return { n, k, p: n ? k / n : 0 }; }
function z(p, p0, n) { return n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0; }
const pct = (x) => (x * 100).toFixed(1) + "%";
function line(label, sub, base, key) {
  const zz = z(sub.p, base, sub.n);
  const flag = Math.abs(zz) >= 2.6 ? "🟢强" : Math.abs(zz) >= 2 ? "🟡" : "⚪噪声";
  console.log(`  ${label.padEnd(30)} N=${String(sub.n).padStart(4)} ${key}=${pct(sub.p).padStart(6)} (基线${pct(base)}) Δ${((sub.p - base) * 100 >= 0 ? "+" : "") + ((sub.p - base) * 100).toFixed(1)}pp z=${zz.toFixed(1)} ${flag}`);
}

console.log(`\n══════ 盘口共性挖掘 · ${F.length} 场五大联赛(2021-2026) ══════`);
const baseUpset = rate(F, x => x.favUpset).p;
const baseDraw = rate(F, x => x.favDrew).p;
const baseOver = rate(F, x => x.over25).p;
console.log(`基线: 热门不胜${pct(baseUpset)} · 平局${pct(baseDraw)} · 大球(>2.5)${pct(baseOver)}`);

// ① 按亚盘收盘线档位:爆冷/平局/大球率
console.log(`\n① 各亚盘线档位(收盘|line|) → 热门不胜率 / 平局率 / 大球率`);
const buckets = [[0,0.1],[0.25,0.25],[0.5,0.5],[0.75,0.75],[1,1],[1.25,1.25],[1.5,1.5],[1.75,1.75],[2,3.5]];
for (const [lo, hi] of buckets) {
  const g = F.filter(x => x.ahDepthC >= lo && x.ahDepthC <= hi + 0.001 && (lo === 0 ? x.ahDepthC <= 0.1 : true));
  if (g.length < 30) continue;
  const u = rate(g, x => x.favUpset), d = rate(g, x => x.favDrew), ov = rate(g, x => x.over25);
  console.log(`  线${String(lo === 0 ? "平手" : "±" + lo).padEnd(8)} N=${String(g.length).padStart(4)}  不胜${pct(u.p).padStart(6)}  平局${pct(d.p).padStart(6)}  大球${pct(ov.p).padStart(6)}`);
}

// ② 走势触发:同档线下,初→终的移动方向 → 爆冷率(对比该档基线)
console.log(`\n② 走势触发(欧赔热门 加注 vs 退烧 → 热门不胜率)`);
for (const [lab, lo, hi] of [["平手/浅盘(|line|≤0.5)", 0, 0.5], ["中深(0.75~1.25)", 0.75, 1.25], ["深盘(≥1.5)", 1.5, 9]]) {
  const seg = F.filter(x => x.ahDepthC >= lo && x.ahDepthC <= hi);
  const b = rate(seg, x => x.favUpset).p;
  console.log(` [${lab}] 该段基线不胜${pct(b)} N=${seg.length}`);
  line("热门退烧(euDrift<-0.03)", rate(seg.filter(x => x.euDrift < -0.03), x => x.favUpset), b, "不胜");
  line("热门加注(euDrift>+0.03)", rate(seg.filter(x => x.euDrift > 0.03), x => x.favUpset), b, "不胜");
  line("亚盘线退浅(ahMove<0)", rate(seg.filter(x => x.ahLineMove < 0), x => x.favUpset), b, "不胜");
  line("亚盘线加深(ahMove>0)", rate(seg.filter(x => x.ahLineMove > 0), x => x.favUpset), b, "不胜");
}

// ③ 背离触发(西班牙型):1X2极笃定 但 大小球线低/退烧 → 平局率
console.log(`\n③ 背离触发:超级大热(1X2收盘≥70%) 下,大小球预期高低 → 平局/不胜率`);
const heavy = F.filter(x => x.pFavClose >= 0.70);
const bhU = rate(heavy, x => x.favUpset).p, bhD = rate(heavy, x => x.favDrew).p;
console.log(` 超级大热基线 N=${heavy.length} 不胜${pct(bhU)} 平局${pct(bhD)}`);
line("大小球收盘低(ovC<0.50)→平局", rate(heavy.filter(x => x.ovC != null && x.ovC < 0.50), x => x.favDrew), bhD, "平局");
line("大小球收盘高(ovC≥0.60)→平局", rate(heavy.filter(x => x.ovC != null && x.ovC >= 0.60), x => x.favDrew), bhD, "平局");
line("大小球退烧(overMove<-0.03)→平", rate(heavy.filter(x => x.overMove != null && x.overMove < -0.03), x => x.favDrew), bhD, "平局");
line("热门退烧+大小球低→不胜", rate(heavy.filter(x => x.euDrift < -0.02 && x.ovC != null && x.ovC < 0.52), x => x.favUpset), bhU, "不胜");

// ④ 大小球共性:收盘大球概率分档 → 实际大球率(校准 + 走势)
console.log(`\n④ 大小球:收盘大球概率分档 → 实际大球率(校准)+ 走势触发`);
for (const [lo, hi] of [[0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]]) {
  const g = F.filter(x => x.ovC != null && x.ovC >= lo && x.ovC < hi);
  if (g.length < 30) continue;
  const ov = rate(g, x => x.over25);
  console.log(`  收盘大球${(lo * 100) + "~" + (hi * 100) + "%"} N=${String(g.length).padStart(4)} 实际大球${pct(ov.p)}`);
}
line("大小球被加注(overMove>+0.04)→实际大球", rate(F.filter(x => x.overMove > 0.04), x => x.over25), baseOver, "大球");
line("大小球退烧(overMove<-0.04)→实际大球", rate(F.filter(x => x.overMove < -0.04), x => x.over25), baseOver, "大球");

// ⑤ Pinnacle 锐盘 vs 软盘背离:锐盘逆软盘动 → 爆冷
console.log(`\n⑤ Pinnacle 锐盘漂移 vs 欧赔(软盘共识)背离 → 热门不胜率`);
const withPin = F.filter(x => x.pinDrift != null);
const bp = rate(withPin, x => x.favUpset).p;
console.log(` 有Pinnacle场基线 N=${withPin.length} 不胜${pct(bp)}`);
line("锐盘退烧热门(pinDrift<-0.02)", rate(withPin.filter(x => x.pinDrift < -0.02), x => x.favUpset), bp, "不胜");
line("锐盘加注热门(pinDrift>+0.02)", rate(withPin.filter(x => x.pinDrift > 0.02), x => x.favUpset), bp, "不胜");
line("软盘加注但锐盘退烧(背离)", rate(withPin.filter(x => x.euDrift > 0.02 && x.pinDrift < -0.01), x => x.favUpset), bp, "不胜");

// ⑥ 交互:大小球走势触发 在各亚盘线档内是否稳健(独立信号 or 与线共线)
console.log(`\n⑥ 交互稳健性:大小球走势(加注/退烧)在各亚盘线档内 → 实际大球率`);
for (const [lab, lo, hi] of [["浅盘(≤0.5)", 0, 0.5], ["中(0.75~1)", 0.75, 1], ["深盘(≥1.25)", 1.25, 9]]) {
  const seg = F.filter(x => x.ahDepthC >= lo && x.ahDepthC <= hi);
  const b = rate(seg, x => x.over25).p;
  console.log(` [${lab}] 该段大球基线${pct(b)} N=${seg.length}`);
  line("  +大小球被加注>0.04", rate(seg.filter(x => x.overMove > 0.04), x => x.over25), b, "大球");
  line("  +大小球退烧<-0.04", rate(seg.filter(x => x.overMove < -0.04), x => x.over25), b, "大球");
}

// ⑦ 浅盘内"爆冷平 vs 爆冷输":热门未胜时,什么区分平局与被翻盘?(同样的盘为什么有的平有的输)
console.log(`\n⑦ 浅盘(|line|≤0.5)热门未胜时 → 平局 vs 被翻盘输 的区分因素`);
const shallowUpset = F.filter(x => x.ahDepthC <= 0.5 && x.favUpset);
const bDrawGivenUpset = rate(shallowUpset, x => x.favDrew).p; // 爆冷里有多少是平
console.log(` 浅盘爆冷中平局占比基线${pct(bDrawGivenUpset)} N=${shallowUpset.length}`);
line("  大小球低(ovC<0.48)→爆冷时更可能平", rate(shallowUpset.filter(x => x.ovC != null && x.ovC < 0.48), x => x.favDrew), bDrawGivenUpset, "平占比");
line("  大小球高(ovC≥0.58)→爆冷时更可能输", rate(shallowUpset.filter(x => x.ovC != null && x.ovC >= 0.58), x => x.favDrew), bDrawGivenUpset, "平占比");

// ⑧ 联赛差异(球队特点的免费代理:不同联赛平局/大球结构性差异)
console.log(`\n⑧ 联赛差异(球队风格代理):各联赛 平局率 / 大球率`);
for (const lg of ["E0", "SP1", "D1", "I1", "F1"]) {
  const g = F.filter(x => x.league === lg);
  if (!g.length) continue;
  const nm = { E0: "英超", SP1: "西甲", D1: "德甲", I1: "意甲", F1: "法甲" }[lg];
  console.log(`  ${nm} N=${String(g.length).padStart(4)} 平局${pct(rate(g, x => x.favDrew).p)} 大球${pct(rate(g, x => x.over25).p)} 热门不胜${pct(rate(g, x => x.favUpset).p)}`);
}

console.log(`\n说明:🟢强=|z|≥2.6(p<0.01,可作触发候选) · 🟡=|z|≥2(待更多样本) · ⚪噪声=|z|<2(不可作触发,市场高效)`);
