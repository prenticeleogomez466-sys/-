#!/usr/bin/env node
/**
 * 命中率导向的组合扫描(2026-06-22 用户:不要稳赚,要挖高命中率组合+给打法)。
 * 数据=五大联赛全7赛季 12458场(本地CSV)。目标=选择性投注:只在"高把握组合"出手,抬整体命中率。
 * 与ROI扫描的区别:这里排序按【命中率】(方差比ROI小,稳定可用),仍强制 TRAIN/TEST 双稳防过拟合。
 * 市场:1X2(主胜/平/客胜)、大小球(大/小)、让球过盘(让胜/让平/让负,按收盘亚盘线)。
 * 诚实:高命中≠盈利(收盘已定价,赔率低);价值=知道"哪种组合该出手押哪个、历史命中多少",提升选择性命中率。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"], SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function pc(t) { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const pctp = (x) => (x * 100).toFixed(1) + "%";

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) { const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue; for (const g of pc(fs.readFileSync(f, "utf8"))) { const fh = num(g("FTHG")), fa = num(g("FTAG")); if (fh === null || fa === null) continue; const euC = trip(num(g("AvgCH")), num(g("AvgCD")), num(g("AvgCA"))) ?? trip(num(g("B365CH")), num(g("B365CD")), num(g("B365CA"))); if (!euC) continue; const euO = trip(num(g("AvgH")), num(g("AvgD")), num(g("AvgA"))) ?? trip(num(g("B365H")), num(g("B365D")), num(g("B365A"))); const ahC = num(g("AHCh")) ?? num(g("AHh")); const d = g("Date") || ""; all.push({ sea, euO, euC, ahC, goals: fh + fa, gd: fh - fa, res: fh > fa ? "home" : fh < fa ? "away" : "draw", date: d }); } }
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });
const dev = (o) => { const i = [1 / o.home, 1 / o.draw, 1 / o.away]; const s = i[0] + i[1] + i[2]; return { home: i[0] / s, draw: i[1] / s, away: i[2] / s }; };

function feat(m) {
  const favHome = m.euC.home <= m.euC.away, favSide = favHome ? "home" : "away";
  const di = dev(m.euC), dio = m.euO ? dev(m.euO) : null;
  const favDrift = dio ? di[favSide] - dio[favSide] : null;
  const L = m.ahC; // 收盘亚盘线(主队视角,负=主让)
  let hcp = null;
  if (L !== null) { const margin = m.gd + L; hcp = margin > 0.25 ? "让胜" : margin < -0.25 ? "让负" : "让平"; } // 主队让球后过盘(让胜=主队方过)
  return { ...m, favSide, favOdds: m.euC[favSide], drawOdds: m.euC.draw, favDrift, ahAbs: L === null ? null : Math.abs(L), hcp,
    over: m.goals > 2.5, win: m.res };
}
const F = all.map(feat);
const split = Math.floor(F.length * 0.7); const TR = F.slice(0, split), TE = F.slice(split);
console.log(`████ 命中率组合扫描 · ${F.length}场(全7赛季) · TRAIN${TR.length}/TEST${TE.length} ████\n`);

const segAh = (m) => { if (m.ahAbs === null) return null; const a = m.ahAbs; return a < 0.125 ? "让0平手" : a < 0.375 ? "让0.25" : a < 0.625 ? "让0.5" : a < 0.875 ? "让0.75" : a < 1.125 ? "让1" : a < 1.375 ? "让1.25" : a < 1.625 ? "让1.5" : "让2+"; };
const segFav = (m) => { const o = m.favOdds; return o < 1.3 ? "热<1.3" : o < 1.45 ? "热1.3-1.45" : o < 1.6 ? "热1.45-1.6" : o < 1.85 ? "热1.6-1.85" : o < 2.1 ? "热1.85-2.1" : o < 2.5 ? "热2.1-2.5" : "热2.5+"; };
const segDraw = (m) => { const d = m.drawOdds; return d < 3.2 ? "平<3.2" : d < 3.45 ? "平3.2-3.45" : d < 3.7 ? "平3.45-3.7" : d < 4.0 ? "平3.7-4.0" : "平4.0+"; };
const segDrift = (m) => m.favDrift === null ? null : m.favDrift > 0.02 ? "加注" : m.favDrift < -0.02 ? "退烧" : "平稳";
const SEGS = { ah: segAh, fav: segFav, draw: segDraw, drift: segDrift };
const keys = Object.keys(SEGS);
const combos = [];
for (let i = 0; i < keys.length; i++) { combos.push([keys[i]]); for (let j = i + 1; j < keys.length; j++) { combos.push([keys[i], keys[j]]); for (let k = j + 1; k < keys.length; k++) combos.push([keys[i], keys[j], keys[k]]); } }
const cellKey = (m, ks) => { const p = ks.map((k) => SEGS[k](m)); return p.some((x) => x === null) ? null : p.join(" ∧ "); };

// 各市场基线命中(自然出现率)
const base = {};
for (const o of ["home", "draw", "away"]) base["1X2:" + o] = F.filter((m) => m.win === o).length / F.length;
base["OU:over"] = F.filter((m) => m.over).length / F.length; base["OU:under"] = F.filter((m) => !m.over).length / F.length;
const hF = F.filter((m) => m.hcp); for (const o of ["让胜", "让平", "让负"]) base["HCP:" + o] = hF.filter((m) => m.hcp === o).length / hF.length;
console.log("市场基线命中率:", Object.entries(base).map(([k, v]) => `${k} ${pctp(v)}`).join(" · "), "\n");

// 市场→取值函数
const MARKETS = {
  "主胜": (m) => m.win === "home", "平局": (m) => m.win === "draw", "客胜": (m) => m.win === "away",
  "大球": (m) => m.over, "小球": (m) => !m.over,
  "让胜(主队过盘)": (m) => m.hcp === "让胜", "让平(走盘)": (m) => m.hcp === "让平", "让负(客队过盘)": (m) => m.hcp === "让负",
};
const baseMap = { "主胜": base["1X2:home"], "平局": base["1X2:draw"], "客胜": base["1X2:away"], "大球": base["OU:over"], "小球": base["OU:under"], "让胜(主队过盘)": base["HCP:让胜"], "让平(走盘)": base["HCP:让平"], "让负(客队过盘)": base["HCP:让负"] };

function rate(rows, fn) { let n = 0, k = 0; for (const m of rows) { if ((fn === MARKETS["让胜(主队过盘)"] || fn === MARKETS["让平(走盘)"] || fn === MARKETS["让负(客队过盘)"]) && !m.hcp) continue; n++; if (fn(m)) k++; } return { n, p: n ? k / n : 0 }; }

// 扫描:每格每市场,TRAIN/TEST命中率,挑高且稳的
const N0TR = 80, N0TE = 40;
const found = [];
let scanned = 0;
for (const ks of combos) {
  const trC = {}, teC = {};
  for (const m of TR) { const c = cellKey(m, ks); if (c) (trC[c] ||= []).push(m); }
  for (const m of TE) { const c = cellKey(m, ks); if (c) (teC[c] ||= []).push(m); }
  for (const c of Object.keys(trC)) {
    const tr = trC[c], te = teC[c] || []; if (tr.length < N0TR || te.length < N0TE) continue;
    for (const [mk, fn] of Object.entries(MARKETS)) {
      scanned++;
      const a = rate(tr, fn), b = rate(te, fn);
      if (a.n < N0TR || b.n < N0TE) continue;
      const lift = a.p - baseMap[mk];
      // 高命中+稳:train≥0.62 且 test≥0.58 且 两半都明显高于基线 且 train/test差≤0.10
      if (a.p >= 0.62 && b.p >= 0.58 && (a.p - baseMap[mk]) >= 0.12 && (b.p - baseMap[mk]) >= 0.08 && Math.abs(a.p - b.p) <= 0.10) {
        found.push({ seg: ks.join("+"), cell: c, mk, trN: a.n, trP: a.p, teN: b.n, teP: b.p, base: baseMap[mk], score: Math.min(a.p, b.p), lift: (a.p + b.p) / 2 - baseMap[mk] });
      }
    }
  }
}
found.sort((x, y) => y.score - x.score);
console.log(`扫描 ${scanned} 个(格×市场);门槛 TRAIN命中≥62%&TEST≥58% & 双半超基线(+12%/+8%) & train-test差≤10pp & N(80/40)\n`);
console.log(`✅ 高命中稳定组合 ${found.length} 个(按命中率降序):\n`);
console.log("市场        命中(TRAIN/TEST)  超基线   样本(TR/TE)  组合");
for (const f of found.slice(0, 40)) {
  console.log(`${f.mk.padEnd(14)} ${pctp(f.trP)}/${pctp(f.teP)}  +${(f.lift * 100).toFixed(0)}pp  ${String(f.trN).padStart(4)}/${String(f.teN).padStart(3)}  ${f.cell}`);
}

// 去重:同市场保留最高命中的不冗余组合(粗略:打印已够)
fs.writeFileSync("D:/football-model-data/screenshots-ocr/hitrate-combos.json", JSON.stringify(found, null, 1));
console.log(`\n共${found.length}个 → 已存 hitrate-combos.json`);
console.log("口径:命中率=历史自然命中(收盘赔率分档);选择性投注用=只在这些组合出手押对应市场,抬整体命中;非盈利保证(赔率已定价)。");
