#!/usr/bin/env node
/**
 * 爆冷触发·回测审计(2026-06-16 用户:"全部做完后加回测审计,保证不是编造、准确、确实有用")。
 *
 * 三关诚实验证(遵 reference_signal_backtest_findings:公开信号打不过收盘线·样本内好看≠有用):
 *   ① 复现:重算所有上报数字,确认与报告一致(非编造)。
 *   ② 样本外(OOS):按时间切 训练2021~2024-07 / 测试2024-08~2026,看触发在"没见过的数据"上是否还成立。
 *   ③ 残差edge:大小球走势——在"收盘大球概率"分桶内,初→收的移动是否还加预测力?
 *      (若收盘线已price该移动→桶内残差≈0=无下注edge,只是描述性;诚实区分)。
 * 全部用真实 loadFootballDataMatches,不取巧、不cherry-pick;不达标就如实标。
 */
import "../src/env.js";
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { diagnoseUpsetRisk } from "../src/upset-trap-detector.js";

const { matches } = await loadFootballDataMatches();
function feat(m) {
  const o = m.odds, oc = m.oddsClose; if (!o || !oc || !m.asian) return null;
  const hg = m.homeGoals, ag = m.awayGoals; if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const result = hg > ag ? "home" : hg < ag ? "away" : "draw";
  const favSide = oc.home >= oc.away ? "home" : "away";
  const lineC = Number(m.asian.lineClose ?? m.asian.line);
  const ovO = m.overProb, ovC = m.overProbClose;
  return {
    date: m.date, pFav: oc[favSide], pDraw: oc.draw, ahDepthC: Math.abs(lineC),
    ovO, ovC, overMove: (Number.isFinite(ovC) && Number.isFinite(ovO)) ? ovC - ovO : null,
    favWin: result === favSide, favDrew: result === "draw", favLost: result !== favSide && result !== "draw",
    favUpset: result !== favSide, over25: (hg + ag) > 2.5,
  };
}
const ALL = matches.map(feat).filter(Boolean).filter(x => x.date);
const SPLIT = "2024-08-01";
const TRAIN = ALL.filter(x => x.date < SPLIT);
const TEST = ALL.filter(x => x.date >= SPLIT);
const rate = (a, p) => { const n = a.length, k = a.filter(p).length; return { n, p: n ? k / n : 0 }; };
const z = (p, p0, n) => n > 0 && p0 > 0 && p0 < 1 ? (p - p0) / Math.sqrt(p0 * (1 - p0) / n) : 0;
const PC = (x) => (x * 100).toFixed(1) + "%";
let pass = 0, warn = 0, fail = 0;
function verdict(name, trainVal, testVal, baseTest, nTest, dir) {
  const zz = z(testVal, baseTest, nTest);
  const holds = dir === "up" ? (testVal - baseTest) >= 0.03 && zz >= 1.5 : (baseTest - testVal) >= 0.03 && zz <= -1.5;
  const tag = holds ? "🟢OOS成立" : Math.abs(testVal - trainVal) <= 0.06 ? "🟡方向在但弱" : "🔴OOS不成立";
  if (holds) pass++; else if (tag.includes("🟡")) warn++; else fail++;
  console.log(`  ${name.padEnd(30)} 训练${PC(trainVal)} → 测试${PC(testVal)}(基线${PC(baseTest)},N=${nTest},z=${zz.toFixed(1)}) ${tag}`);
}

console.log(`\n══════ 爆冷触发·回测审计 ══════`);
console.log(`总${ALL.length}场 | 训练(${ALL[0]?.date}~${SPLIT}) ${TRAIN.length} | 测试(${SPLIT}~) ${TEST.length}`);

// ① 复现(确认非编造):重算总基线
console.log(`\n① 复现总基线(对照报告:热门胜54%/平25%/负20%·大球53%)`);
console.log(`  全样本: 热门胜${PC(rate(ALL, x => x.favWin).p)} 平${PC(rate(ALL, x => x.favDrew).p)} 负${PC(rate(ALL, x => x.favLost).p)} 大球${PC(rate(ALL, x => x.over25).p)}`);

// ② 大小球走势触发 OOS
console.log(`\n② 大小球走势触发 — 样本外验证(报告称:加注→大球63%/退烧→44%)`);
const baseOverTest = rate(TEST, x => x.over25).p;
verdict("大小球加注>4pp→大球", rate(TRAIN.filter(x => x.overMove > 0.04), x => x.over25).p, rate(TEST.filter(x => x.overMove > 0.04), x => x.over25).p, baseOverTest, TEST.filter(x => x.overMove > 0.04).length, "up");
verdict("大小球退烧>4pp→小球", rate(TRAIN.filter(x => x.overMove < -0.04), x => x.over25).p, rate(TEST.filter(x => x.overMove < -0.04), x => x.over25).p, baseOverTest, TEST.filter(x => x.overMove < -0.04).length, "down");

// ②b 残差edge:收盘大球概率分桶内,移动是否还加预测力(测真下注edge)
console.log(`\n②b 残差edge检验:固定"收盘大球概率"桶内,初→收移动是否仍区分实际大球?`);
console.log(`   (若桶内加注vs退烧的实际大球率≈→收盘线已price该移动=无下注edge,只描述性)`);
for (const [lo, hi] of [[0.45, 0.55], [0.55, 0.65]]) {
  const bucket = ALL.filter(x => x.ovC != null && x.ovC >= lo && x.ovC < hi && x.overMove != null);
  if (bucket.length < 60) continue;
  const up = rate(bucket.filter(x => x.overMove > 0.04), x => x.over25);
  const dn = rate(bucket.filter(x => x.overMove < -0.04), x => x.over25);
  const bb = rate(bucket, x => x.over25).p;
  console.log(`  收盘大球${(lo * 100).toFixed(0)}~${(hi * 100).toFixed(0)}%桶(N=${bucket.length},桶内实际大球${PC(bb)}): 加注组${PC(up.p)}(N=${up.n}) vs 退烧组${PC(dn.p)}(N=${dn.n}) → 桶内差${((up.p - dn.p) * 100).toFixed(1)}pp`);
}

// ③ upsetType 分型 OOS(用生产 diagnoseUpsetRisk 跑测试集,看各型实际平/胜率)
console.log(`\n③ 分型 upsetType 样本外:用生产 diagnoseUpsetRisk 跑测试集,看各型实际结果`);
const typed = TEST.map(x => {
  const dg = diagnoseUpsetRisk({ p1x2Fav: x.pFav, ahLine: -x.ahDepthC, totalsLine: null, pOver25: x.ovC, drawImplied: x.pDraw });
  return dg ? { ...x, type: dg.upsetType } : null;
}).filter(Boolean);
const baseTestDraw = rate(TEST, x => x.favDrew).p, baseTestWin = rate(TEST, x => x.favWin).p;
console.log(`  测试集基线: 平${PC(baseTestDraw)} 热门胜${PC(baseTestWin)}`);
for (const t of ["🟢低风险(强热可胆)", "🟢低风险(强热窄胜·WC对弱旅留尾部)", "🟡防平(平局隐含≥30%·校准31.5%)", "🔴双向爆冷(势均·平/负各半·勿当胆)", "中性"]) {
  const g = typed.filter(x => x.type === t);
  if (g.length < 20) { console.log(`  ${t.padEnd(28)} N=${g.length} (样本不足,跳过)`); continue; }
  console.log(`  ${t.padEnd(28)} N=${String(g.length).padStart(4)} 实际:热门胜${PC(rate(g, x => x.favWin).p)} 平${PC(rate(g, x => x.favDrew).p)} 负${PC(rate(g, x => x.favLost).p)}`);
}

console.log(`\n══ 审计裁决: 🟢成立 ${pass} · 🟡弱 ${warn} · 🔴不成立 ${fail} ══`);
console.log(`诚实说明:此审计只验"公开盘口触发"的样本外稳健性与描述价值;`);
console.log(`真下注edge需CLV(打败收盘线),记忆已证1X2/大小球公开信号CLV≈0——故触发定位=`);
console.log(`风险分型/防坑(别当胆、防平)而非"稳赢下注",此为诚实边界。`);
