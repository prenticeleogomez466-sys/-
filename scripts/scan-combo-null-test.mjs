#!/usr/bin/env node
/**
 * 对 scan-combo-edges 命中的"69个双正ROI组合"做对抗证伪 / 零假设检验(2026-06-22)。
 * 问题:扫1375个组合,多重检验下纯噪声能冒出多少个"TRAIN&TEST双正ROI"?
 * 方法(置换/蒙特卡洛零假设):
 *   假设市场收盘赔率完全正确(devig隐含=真概率)→ 按该概率重新模拟每场赛果(此世界里任何下注期望ROI=−vig,绝无edge)。
 *   用同一套扫描流程跑K次,记录每次"命中数"。得到"纯噪声命中数"分布。
 *   若真实命中69 落在噪声分布内/之下 → 这些组合是多重检验假阳,无真edge。
 * 另:对真实数据的top候选,逐赛季ROI看稳定性(真edge应多赛季为正,噪声靠1-2季)。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function parseCsv(text) { const lines = text.split(/\r?\n/).filter((l) => l.trim().length); const head = lines[0].replace(/^﻿/, "").split(","); const idx = (n) => head.indexOf(n); return lines.slice(1).map((l) => { const c = l.split(","); return { get: (n) => { const j = idx(n); return j >= 0 ? c[j] : undefined; } }; }); }
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const devig3 = (o) => { if (!o) return null; const inv = [1 / o.home, 1 / o.draw, 1 / o.away]; const s = inv[0] + inv[1] + inv[2]; return { home: inv[0] / s, draw: inv[1] / s, away: inv[2] / s }; };

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue;
  for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
    const fthg = numOr(r.get("FTHG")), ftag = numOr(r.get("FTAG")); if (fthg === null || ftag === null) continue;
    const euO = trip(numOr(r.get("AvgH")), numOr(r.get("AvgD")), numOr(r.get("AvgA"))) ?? trip(numOr(r.get("B365H")), numOr(r.get("B365D")), numOr(r.get("B365A")));
    const euC = trip(numOr(r.get("AvgCH")), numOr(r.get("AvgCD")), numOr(r.get("AvgCA"))) ?? trip(numOr(r.get("B365CH")), numOr(r.get("B365CD")), numOr(r.get("B365CA")));
    if (!euC) continue;
    const ahC = numOr(r.get("AHCh")), ahO = numOr(r.get("AHh"));
    const ouC = (() => { const o = numOr(r.get("AvgC>2.5")) ?? numOr(r.get("B365C>2.5")); const u = numOr(r.get("AvgC<2.5")) ?? numOr(r.get("B365C<2.5")); return o > 1 && u > 1 ? { over: o, under: u } : null; })();
    const d = r.get("Date") || ""; const result = fthg > ftag ? "home" : fthg < ftag ? "away" : "draw";
    all.push({ lg, date: d, euO, euC, ahC, ahO, ouC, goals: fthg + ftag, result });
  }
}
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return Number(y) * 10000 + Number(m[1]) * 100 + Number(m[0]); }; return k(a) - k(b); });

function feat(m) {
  const favHome = m.euC.home <= m.euC.away, favSide = favHome ? "home" : "away";
  const di = devig3(m.euC), dio = devig3(m.euO);
  const favDrift = di && dio ? di[favSide] - dio[favSide] : null;
  const ahLine = m.ahC ?? m.ahO;
  return { ...m, favSide, favOddsC: m.euC[favSide], drawOddsC: m.euC.draw, favDrift, ahLineAbs: ahLine === null ? null : Math.abs(ahLine), pdev: di, pover: m.ouC ? (1 / m.ouC.over) / (1 / m.ouC.over + 1 / m.ouC.under) : null };
}
const F = all.map(feat);
const segAh = (m) => { if (m.ahLineAbs === null) return null; const a = m.ahLineAbs; return a < 0.125 ? "让0" : a < 0.375 ? "让0.25" : a < 0.625 ? "让0.5" : a < 0.875 ? "让0.75" : a < 1.125 ? "让1" : a < 1.375 ? "让1.25" : a < 1.625 ? "让1.5" : "让2+"; };
const segFav = (m) => { const o = m.favOddsC; return o < 1.4 ? "热<1.4" : o < 1.6 ? "热1.4-1.6" : o < 1.85 ? "热1.6-1.85" : o < 2.1 ? "热1.85-2.1" : o < 2.5 ? "热2.1-2.5" : "热2.5+"; };
const segDraw = (m) => { const d = m.drawOddsC; return d < 3.0 ? "平<3.0" : d < 3.2 ? "平3.0-3.2" : d < 3.35 ? "平3.2-3.35" : d < 3.45 ? "平3.35-3.45" : d < 3.55 ? "平3.45-3.55" : d < 3.65 ? "平3.55-3.65" : d < 3.8 ? "平3.65-3.8" : d < 4.0 ? "平3.8-4.0" : "平4.0+"; };
const segDrift = (m) => { if (m.favDrift === null) return null; return m.favDrift > 0.02 ? "加注" : m.favDrift < -0.02 ? "退烧" : "平稳"; };
const SEGS = { ah: segAh, fav: segFav, draw: segDraw, drift: segDrift };
const keys = Object.keys(SEGS);
const combos = [];
for (let i = 0; i < keys.length; i++) { combos.push([keys[i]]); for (let j = i + 1; j < keys.length; j++) { combos.push([keys[i], keys[j]]); for (let k = j + 1; k < keys.length; k++) combos.push([keys[i], keys[j], keys[k]]); } }
const cellKey = (m, ks) => { const parts = ks.map((k) => SEGS[k](m)); return parts.some((p) => p === null) ? null : parts.join(" ∧ "); };

const split = Math.floor(F.length * 0.7);
const TRAIN = F.slice(0, split), TEST = F.slice(split);
const N0_TRAIN = 60, N0_TEST = 40, BAR = 0.03;

// resultOf: 'real' 用真实赛果;否则用模拟(从devig概率采样)
function roiCount(resultOf, overOf) {
  // 预存每场的(result,over)
  const trR = TRAIN.map((m) => ({ m, r: resultOf(m), ov: overOf(m) }));
  const teR = TEST.map((m) => ({ m, r: resultOf(m), ov: overOf(m) }));
  function roi(rows, o) { let s = 0, ret = 0; for (const x of rows) { if (o === "over" || o === "under") { if (!x.m.ouC) continue; s++; if ((x.ov) === (o === "over")) ret += x.m.ouC[o === "over" ? "over" : "under"]; } else { s++; if (x.r === o) ret += x.m.euC[o]; } } return { n: s, roi: s ? ret / s - 1 : 0 }; }
  let found = 0;
  for (const ks of combos) {
    const trC = {}, teC = {};
    for (const x of trR) { const c = cellKey(x.m, ks); if (c) (trC[c] ||= []).push(x); }
    for (const x of teR) { const c = cellKey(x.m, ks); if (c) (teC[c] ||= []).push(x); }
    for (const c of Object.keys(trC)) { const tr = trC[c], te = teC[c] || []; if (tr.length < N0_TRAIN || te.length < N0_TEST) continue;
      for (const o of ["home", "draw", "away", "over", "under"]) { const a = roi(tr, o), b = roi(te, o); if (a.n < N0_TRAIN || b.n < N0_TEST) continue; if (a.roi >= BAR && b.roi > 0) found++; } }
  }
  return found;
}

// 简易LCG随机(可复现)
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function sampleResult(m) { const p = m.pdev; const u = rnd(); return u < p.home ? "home" : u < p.home + p.draw ? "draw" : "away"; }
function sampleOver(m) { return m.pover === null ? false : rnd() < m.pover; }

const real = roiCount((m) => m.result, (m) => m.goals > 2.5);
console.log("████ 对抗证伪:扫描命中数 真实 vs 纯噪声(市场完全正确模拟) ████\n");
console.log(`真实数据命中(TRAIN ROI≥+3% & TEST ROI>0): ${real} 个\n`);
const K = 20; const nulls = [];
for (let t = 0; t < K; t++) { const c = roiCount((m) => sampleResult(m), (m) => sampleOver(m)); nulls.push(c); process.stdout.write(`  噪声第${t + 1}次: ${c}\r`); }
nulls.sort((a, b) => a - b);
const mean = nulls.reduce((a, b) => a + b, 0) / K;
console.log(`\n\n纯噪声(无edge世界)${K}次命中数: 最小${nulls[0]} 中位${nulls[Math.floor(K / 2)]} 均值${mean.toFixed(1)} 最大${nulls[K - 1]}`);
const ge = nulls.filter((x) => x >= real).length;
console.log(`噪声命中 ≥ 真实(${real}) 的次数: ${ge}/${K}  → 经验p≈${(ge / K).toFixed(2)}`);
console.log("");
if (mean >= real * 0.7) console.log("⛔ 裁决:真实命中数与纯噪声同量级 → 这些'双正ROI组合'绝大多数是多重检验假阳,无真实可盈利edge。");
else console.log("🟢 裁决:真实命中数显著高于噪声 → 存在超出多重检验的信号,值得逐个稳健性复核(逐赛季+多split)。");
