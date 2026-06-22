#!/usr/bin/env node
/**
 * 穷尽组合 ROI 扫描器(2026-06-22 用户令:找真能赚钱的edge)。
 * 数据 = 本地 football-data.co.uk 五大联赛全7赛季(1920~2526)CSV,直读直解析(不走加载器/网络)。
 * 维度:让球线band × 欧盘热门赔档 × 平赔档 × 初→终热门走势(加注/退烧)。
 * 判定:不是看命中率,是看【ROI】——按收盘真实赔率下注,TRAIN找→TEST验,只认两半都正+样本足。
 * 诚实铁律(reference_signal_backtest_findings):
 *   · 公开盘历史已反复证明打不过收盘线,预期绝大多数组合 ROI≈-vig(负);穷尽搜一遍是为确认,不是为强行找。
 *   · 扫几百个组合→多重检验,总有几个靠运气过OOS;故要求 train&test 同向为正 + test N≥40,且明确标注"扫了多少格"。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
const pct = (x) => (x * 100).toFixed(1) + "%";
const roiStr = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";

// ---- CSV 解析(按列名,容错早赛季缺列)----
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  const head = lines[0].replace(/^﻿/, "").split(",");
  const idx = (name) => head.indexOf(name);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    rows.push({ get: (name) => { const j = idx(name); return j >= 0 ? c[j] : undefined; } });
  }
  return rows;
}
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
function devig3(o) { if (!o) return null; const inv = [1 / o.home, 1 / o.draw, 1 / o.away]; const s = inv[0] + inv[1] + inv[2]; return { home: inv[0] / s, draw: inv[1] / s, away: inv[2] / s }; }

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`);
  if (!fs.existsSync(f)) continue;
  for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
    const fthg = numOr(r.get("FTHG")), ftag = numOr(r.get("FTAG"));
    if (fthg === null || ftag === null) continue;
    const euO = trip(numOr(r.get("AvgH")), numOr(r.get("AvgD")), numOr(r.get("AvgA"))) ?? trip(numOr(r.get("B365H")), numOr(r.get("B365D")), numOr(r.get("B365A")));
    const euC = trip(numOr(r.get("AvgCH")), numOr(r.get("AvgCD")), numOr(r.get("AvgCA"))) ?? trip(numOr(r.get("B365CH")), numOr(r.get("B365CD")), numOr(r.get("B365CA")));
    const ahO = numOr(r.get("AHh")), ahC = numOr(r.get("AHCh"));
    const ouC = (() => { const o = numOr(r.get("AvgC>2.5")) ?? numOr(r.get("B365C>2.5")); const u = numOr(r.get("AvgC<2.5")) ?? numOr(r.get("B365C<2.5")); return o > 1 && u > 1 ? { over: o, under: u } : null; })();
    const d = r.get("Date") || "";
    const result = fthg > ftag ? "home" : fthg < ftag ? "away" : "draw";
    all.push({ lg, date: d, euO, euC, ahO, ahC, ouC, goals: fthg + ftag, result });
  }
}
all.sort((a, b) => { // dd/mm/yy(yy) → 排序键
  const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return Number(y) * 10000 + Number(m[1]) * 100 + Number(m[0]); };
  return k(a) - k(b);
});
console.log(`████ 穷尽组合ROI扫描 · 五大联赛全7赛季 ████`);
console.log(`读入 ${all.length} 场(${SEASONS[0]}~${SEASONS.at(-1)})`);
const withC = all.filter((m) => m.euC);
console.log(`含收盘欧赔 ${withC.length} · 含收盘让球线 ${all.filter((m) => m.ahC !== null).length} · 含收盘大小球 ${all.filter((m) => m.ouC).length}\n`);

// 时间外分割 70/30
const split = Math.floor(withC.length * 0.7);
const TRAIN = withC.slice(0, split), TEST = withC.slice(split);
console.log(`OOS: TRAIN ${TRAIN.length}(早) / TEST ${TEST.length}(近)\n`);

// ---- 特征 ----
function feat(m) {
  if (!m.euC) return null;
  const favHome = m.euC.home <= m.euC.away;
  const favSide = favHome ? "home" : "away";
  const favOddsC = m.euC[favSide];
  const di = devig3(m.euC), dio = devig3(m.euO);
  const favDrift = di && dio ? di[favSide] - dio[favSide] : null; // >0 收盘更看好热门(加注)
  const ahLine = m.ahC ?? m.ahO; // 收盘优先
  return { favSide, favOddsC, drawOddsC: m.euC.draw, favDrift, ahLineAbs: ahLine === null ? null : Math.abs(ahLine), ...m };
}
const F = (arr) => arr.map(feat).filter(Boolean);
const trainF = F(TRAIN), testF = F(TEST), allF = F(withC);

// ---- 分段函数 ----
const segAh = (m) => {
  if (m.ahLineAbs === null) return null;
  const a = m.ahLineAbs;
  if (a < 0.125) return "让0(平手)";
  if (a < 0.375) return "让0.25";
  if (a < 0.625) return "让0.5";
  if (a < 0.875) return "让0.75";
  if (a < 1.125) return "让1";
  if (a < 1.375) return "让1.25";
  if (a < 1.625) return "让1.5";
  return "让2+";
};
const segFav = (m) => { const o = m.favOddsC; return o < 1.4 ? "热<1.4" : o < 1.6 ? "热1.4-1.6" : o < 1.85 ? "热1.6-1.85" : o < 2.1 ? "热1.85-2.1" : o < 2.5 ? "热2.1-2.5" : "热2.5+"; };
const segDraw = (m) => { const d = m.drawOddsC; return d < 3.0 ? "平<3.0" : d < 3.2 ? "平3.0-3.2" : d < 3.35 ? "平3.2-3.35" : d < 3.45 ? "平3.35-3.45" : d < 3.55 ? "平3.45-3.55" : d < 3.65 ? "平3.55-3.65" : d < 3.8 ? "平3.65-3.8" : d < 4.0 ? "平3.8-4.0" : "平4.0+"; };
const segDrift = (m) => { if (m.favDrift === null) return null; return m.favDrift > 0.02 ? "加注" : m.favDrift < -0.02 ? "退烧" : "平稳"; };
const SEGS = { ah: segAh, fav: segFav, draw: segDraw, drift: segDrift };

// ---- ROI:在子集上,backOutcome 的收盘赔率ROI ----
function roi(rows, outcome) {
  let stake = 0, ret = 0;
  for (const m of rows) {
    if (outcome === "over" || outcome === "under") { if (!m.ouC) continue; stake++; if ((m.goals > 2.5) === (outcome === "over")) ret += m.ouC[outcome === "over" ? "over" : "under"]; }
    else { if (!m.euC) continue; stake++; if (m.result === outcome) ret += m.euC[outcome]; }
  }
  return stake ? { n: stake, roi: ret / stake - 1 } : { n: 0, roi: 0 };
}
const drawRate = (rows) => rows.length ? rows.filter((m) => m.result === "draw").length / rows.length : 0;

// ===== ① 总基线(背各玩法的天然ROI=约-vig)=====
console.log("① 全样本背各玩法ROI(天然抽水基线,应≈负):");
for (const o of ["home", "draw", "away", "over", "under"]) { const r = roi(allF, o); console.log(`   背${o.padEnd(5)} N=${r.n} ROI=${roiStr(r.roi)}`); }
const baseDraw = drawRate(allF);
console.log(`   全样本平局率 ${pct(baseDraw)}\n`);

// ===== ② 按让球线band:结果分布 + 背平/背热ROI =====
console.log("② 按让球线band:平局率 + 背平ROI + 背热门ROI(收盘)");
{
  const bands = ["让0(平手)", "让0.25", "让0.5", "让0.75", "让1", "让1.25", "让1.5", "让2+"];
  for (const b of bands) {
    const g = allF.filter((m) => segAh(m) === b);
    if (g.length < 20) { console.log(`   ${b.padEnd(9)} N=${g.length}(样本不足)`); continue; }
    const dr = drawRate(g), rd = roi(g, "draw"), favWin = g.filter((m) => m.result === m.favSide).length / g.length;
    console.log(`   ${b.padEnd(9)} N=${String(g.length).padStart(4)} | 平${pct(dr)} 热胜${pct(favWin)} | 背平ROI=${roiStr(rd.roi)}`);
  }
  console.log("");
}

// ===== ③ 平赔档(用户高平信号核心):平局率 vs 隐含 + 背平ROI + OOS =====
console.log("③ 平赔档 → 平局率 vs 隐含 + 背平ROI(OOS) ★用户'高平信号'核心检验");
{
  const buckets = ["平<3.0", "平3.0-3.2", "平3.2-3.35", "平3.35-3.45", "平3.45-3.55", "平3.55-3.65", "平3.65-3.8", "平3.8-4.0", "平4.0+"];
  for (const b of buckets) {
    const gAll = allF.filter((m) => segDraw(m) === b);
    if (gAll.length < 30) { console.log(`   ${b.padEnd(11)} N=${gAll.length}(不足)`); continue; }
    const impl = gAll.reduce((a, m) => a + 1 / m.drawOddsC, 0) / gAll.length;
    const dr = drawRate(gAll);
    const rTr = roi(trainF.filter((m) => segDraw(m) === b), "draw");
    const rTe = roi(testF.filter((m) => segDraw(m) === b), "draw");
    const oos = rTr.roi > 0 && rTe.roi > 0 ? "🟢两半皆正" : rTr.roi > 0 || rTe.roi > 0 ? "🟡仅一半" : "⚪皆负";
    console.log(`   ${b.padEnd(11)} N=${String(gAll.length).padStart(4)} | 实际平${pct(dr)} vs 隐含${pct(impl)} | 背平ROI 全${roiStr(roi(gAll, "draw").roi)}(TRAIN${roiStr(rTr.roi)}/TEST${roiStr(rTe.roi)}) ${oos}`);
  }
  console.log("");
}

// ===== ④ 穷尽交叉扫描:1/2/3维 段组合 × 5玩法 → ROI,TRAIN找TEST验 =====
console.log("④ 穷尽交叉扫描(1/2/3维)× 5玩法 → 找 TRAIN&TEST 双正 ROI 的真edge");
{
  const keys = Object.keys(SEGS);
  const combos = [];
  for (let i = 0; i < keys.length; i++) { combos.push([keys[i]]); for (let j = i + 1; j < keys.length; j++) { combos.push([keys[i], keys[j]]); for (let k = j + 1; k < keys.length; k++) combos.push([keys[i], keys[j], keys[k]]); } }
  const cellKey = (m, ks) => { const parts = ks.map((k) => SEGS[k](m)); return parts.some((p) => p === null) ? null : parts.join(" ∧ "); };
  const N0_TRAIN = 60, N0_TEST = 40, BAR = 0.03;
  const found = [];
  let cellsScanned = 0;
  for (const ks of combos) {
    const trCells = {}, teCells = {};
    for (const m of trainF) { const c = cellKey(m, ks); if (c) (trCells[c] ||= []).push(m); }
    for (const m of testF) { const c = cellKey(m, ks); if (c) (teCells[c] ||= []).push(m); }
    for (const c of Object.keys(trCells)) {
      const tr = trCells[c], te = teCells[c] || [];
      if (tr.length < N0_TRAIN || te.length < N0_TEST) continue;
      for (const o of ["home", "draw", "away", "over", "under"]) {
        cellsScanned++;
        const a = roi(tr, o), b = roi(te, o);
        if (a.n < N0_TRAIN || b.n < N0_TEST) continue;
        if (a.roi >= BAR && b.roi > 0) found.push({ seg: ks.join("+"), cell: c, bet: o, trN: a.n, trRoi: a.roi, teN: b.n, teRoi: b.roi, score: Math.min(a.roi, b.roi) });
      }
    }
  }
  found.sort((x, y) => y.score - x.score);
  console.log(`   扫描了 ${cellsScanned} 个(格×玩法)组合;门槛 TRAIN ROI≥+3% 且 TEST ROI>0 且 N(train≥60,test≥40)`);
  if (!found.length) console.log("   ⛔ 没有任何组合在 TRAIN&TEST 两个时间段都正ROI → 公开盘穷尽搜后无稳定可盈利edge(与历史实证一致)");
  else {
    console.log(`   ✅ 命中 ${found.length} 个候选(注意:多重检验下部分可能假阳,需谨慎):`);
    for (const f of found.slice(0, 25)) console.log(`   [${f.bet}] ${f.cell}  TRAIN ROI${roiStr(f.trRoi)}(N${f.trN}) / TEST ROI${roiStr(f.teRoi)}(N${f.teN})`);
  }
  console.log("");
}
console.log("口径:欧赔=Avg收盘小数;背平/背玩法ROI=1注收盘赔率结算;竞彩同方向赔率更低(抽水高)→实战ROI还要更差。");
