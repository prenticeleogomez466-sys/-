#!/usr/bin/env node
/**
 * 爆冷驱动·细挖(2026-06-16 用户:"多深挖为什么有些爆冷有些没有,不光大小球和亚盘浅;
 *   怎么看深浅?有什么标准或对比?要做细")。
 *
 * 数据同 mine-handicap-patterns.mjs(8906场五大联赛真实)。核心两件:
 *   ① 建"深浅基准":同样 1X2 实力档,亚盘线通常给多深(中位数/分位)→ 这才是判深浅的标准。
 *      "线残差" = 本场|line| − 该1X2档中位|line|;残差<0=比同类浅(疑背离),>0=比同类深。
 *   ② 把更多信号逐个验(水位/平局赔/总进球绝对/三盘背离/线残差),每条带 N+z,诚实排噪声。
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
  const awWO = Number(m.asian.awayWater), awWC = Number(m.asian.awayWaterClose ?? m.asian.awayWater);
  const hwO = Number(m.asian.homeWater), hwC = Number(m.asian.homeWaterClose ?? m.asian.homeWater);
  // 受让方(弱方)水位移动:弱方=line<0 时的 away,line>0 时的 home。收紧(变小)=钱压弱方。
  const dogWaterMove = lineC < 0 ? (awWC - awWO) : (hwC - hwO);
  const pin = m.oddsPinnacleClose;
  const euPinGap = pin && Number.isFinite(pin[favSide]) ? oc[favSide] - pin[favSide] : null; // >0 软盘比锐盘更看好热门
  return {
    league: m.league, result, favSide,
    pFav: oc[favSide], pDraw: oc.draw,
    ahDepthC: Math.abs(lineC),
    ovC: m.overProbClose,
    dogWaterMove,
    euPinGap,
    favUpset: result !== favSide, favDrew: result === "draw", over25: (hg + ag) > 2.5,
  };
}
const F = matches.map(feat).filter(Boolean);
const rate = (a, p) => { const n = a.length, k = a.filter(p).length; return { n, p: n ? k / n : 0 }; };
const z = (p, p0, n) => n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0;
const PC = (x) => (x * 100).toFixed(1) + "%";
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const flag = (zz) => Math.abs(zz) >= 2.6 ? "🟢强" : Math.abs(zz) >= 2 ? "🟡" : "⚪噪声";
function L(label, sub, base, key) {
  const zz = z(sub.p, base, sub.n);
  console.log(`  ${label.padEnd(34)} N=${String(sub.n).padStart(4)} ${key}=${PC(sub.p).padStart(6)} (基线${PC(base)}) Δ${((sub.p - base) * 100 >= 0 ? "+" : "") + ((sub.p - base) * 100).toFixed(1)}pp z=${zz.toFixed(1)} ${flag(zz)}`);
}

console.log(`\n══════ 爆冷驱动·细挖 · ${F.length} 场 ══════`);

// ① 深浅基准:每个 1X2 热门强度档 → 典型亚盘线(中位+分位)。这就是"判深浅的标准"。
console.log(`\n① 深浅基准表:同 1X2 实力,亚盘线通常给多深(中位/上下四分位)`);
console.log(`   用法:本场线比该档中位"浅"(|line|更小)=疑背离;"深"=市场敢加码,真血洗`);
const strengthBuckets = [[0.50, 0.55], [0.55, 0.60], [0.60, 0.65], [0.65, 0.70], [0.70, 0.75], [0.75, 0.80], [0.80, 0.85], [0.85, 0.90], [0.90, 1.01]];
const benchmark = {};
for (const [lo, hi] of strengthBuckets) {
  const g = F.filter(x => x.pFav >= lo && x.pFav < hi);
  if (g.length < 30) continue;
  const lines = g.map(x => x.ahDepthC).sort((a, b) => a - b);
  const q1 = lines[Math.floor(lines.length * 0.25)], med = median(lines), q3 = lines[Math.floor(lines.length * 0.75)];
  benchmark[lo] = { med, q1, q3 };
  console.log(`  1X2热门${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}% N=${String(g.length).padStart(4)}  亚盘线 中位${med}  [Q1 ${q1} ~ Q3 ${q3}]  该档不胜${PC(rate(g, x => x.favUpset).p)}`);
}

// ② 线残差(本场线 vs 同档中位)→ 爆冷/平局。残差<0=比同类浅。
console.log(`\n② 线残差(本场|line|−同1X2档中位|line|)→ 热门不胜/平局率`);
const bucketOf = (p) => { for (const [lo, hi] of strengthBuckets) if (p >= lo && p < hi) return lo; return null; };
const withRes = F.map(x => { const b = bucketOf(x.pFav); const bm = b != null ? benchmark[b] : null; return bm ? { ...x, residual: x.ahDepthC - bm.med } : null; }).filter(Boolean);
const bUp = rate(withRes, x => x.favUpset).p, bDr = rate(withRes, x => x.favDrew).p;
console.log(` 基线 不胜${PC(bUp)} 平局${PC(bDr)} N=${withRes.length}`);
L("线比同类浅 残差≤-0.25 →不胜", rate(withRes.filter(x => x.residual <= -0.25), x => x.favUpset), bUp, "不胜");
L("线比同类浅 残差≤-0.25 →平局", rate(withRes.filter(x => x.residual <= -0.25), x => x.favDrew), bDr, "平局");
L("线与同类齐 |残差|<0.25 →不胜", rate(withRes.filter(x => Math.abs(x.residual) < 0.25), x => x.favUpset), bUp, "不胜");
L("线比同类深 残差≥+0.25 →不胜", rate(withRes.filter(x => x.residual >= 0.25), x => x.favUpset), bUp, "不胜");

// ③ 平局赔率(收盘平局隐含)→ 平局率(短赔平=市场预期平)
console.log(`\n③ 平局隐含概率(收盘)分档 → 实际平局率(校准+触发)`);
for (const [lo, hi] of [[0, 0.22], [0.22, 0.26], [0.26, 0.30], [0.30, 0.5]]) {
  const g = F.filter(x => x.pDraw >= lo && x.pDraw < hi); if (g.length < 30) continue;
  console.log(`  平局隐含${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}% N=${String(g.length).padStart(4)} 实际平局${PC(rate(g, x => x.favDrew).p)}`);
}

// ④ 受让方(弱方)水位收紧 → 爆冷(钱压弱方)
console.log(`\n④ 受让方(弱方)水位移动 → 热门不胜率`);
const baseUp = rate(F, x => x.favUpset).p;
L("弱方水位收紧>0.05(钱压弱方)", rate(F.filter(x => x.dogWaterMove <= -0.05), x => x.favUpset), baseUp, "不胜");
L("弱方水位走高>0.05(钱离弱方)", rate(F.filter(x => x.dogWaterMove >= 0.05), x => x.favUpset), baseUp, "不胜");

// ⑤ 软盘 vs Pinnacle 锐盘背离 → 爆冷
console.log(`\n⑤ 欧赔软盘 vs Pinnacle 锐盘 对热门看法背离 → 热门不胜率`);
const wp = F.filter(x => x.euPinGap != null); const bwp = rate(wp, x => x.favUpset).p;
L("软盘比锐盘更吹热门>0.03(疑追捧)", rate(wp.filter(x => x.euPinGap > 0.03), x => x.favUpset), bwp, "不胜");
L("软盘比锐盘更冷热门>0.03", rate(wp.filter(x => x.euPinGap < -0.03), x => x.favUpset), bwp, "不胜");

// ⑥ 组合触发:深热门(1X2≥75%) + 线比同类浅 + 大小球低 → 平局(西班牙原型,五大联赛能凑多少)
console.log(`\n⑥ 组合(深热门1X2≥75% + 线比同类浅残差≤-0.25 + 大小球收盘<0.5)→ 平局率`);
const heavy = withRes.filter(x => x.pFav >= 0.75);
const bh = rate(heavy, x => x.favDrew).p;
console.log(` 深热门基线平局${PC(bh)} N=${heavy.length}`);
L("仅线浅", rate(heavy.filter(x => x.residual <= -0.25), x => x.favDrew), bh, "平局");
L("线浅+大小球低", rate(heavy.filter(x => x.residual <= -0.25 && x.ovC != null && x.ovC < 0.5), x => x.favDrew), bh, "平局");

console.log(`\n说明:🟢强|z|≥2.6 · 🟡|z|≥2 · ⚪噪声|z|<2 · 深浅以"同1X2实力档中位线"为基准(见①)`);
