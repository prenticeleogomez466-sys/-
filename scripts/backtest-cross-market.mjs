#!/usr/bin/env node
/**
 * backtest-cross-market.mjs —— 回测跨市场合成器的"选边价值"(2026-06-23)。
 * 核心问题:合成器把热门分成「看胜负(放心单选)」vs「防平(双选)」,这个分级在五大联赛是否真把命中率分开?
 * 数据=五大联赛全7赛季收盘+初盘欧赔+让球线。leak-safe 70/30。诚实:命中≠盈利。
 */
import fs from "node:fs";
import path from "node:path";
import { synthesize } from "../src/cross-market-synthesizer.js";

const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function parseCsv(t) { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); }
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue;
  for (const g of parseCsv(fs.readFileSync(f, "utf8"))) {
    const fh = numOr(g("FTHG")), fa = numOr(g("FTAG")); if (fh === null || fa === null) continue;
    const euC = trip(numOr(g("AvgCH")), numOr(g("AvgCD")), numOr(g("AvgCA"))) ?? trip(numOr(g("B365CH")), numOr(g("B365CD")), numOr(g("B365CA"))); if (!euC) continue;
    const euO = trip(numOr(g("AvgH")), numOr(g("AvgD")), numOr(g("AvgA"))) ?? trip(numOr(g("B365H")), numOr(g("B365D")), numOr(g("B365A")));
    const ahC = numOr(g("AHCh")) ?? numOr(g("AHh"));
    all.push({ date: g("Date") || "", euClose: euC, euOpen: euO, ahLineClose: ahC,
      result: fh > fa ? "home" : fh < fa ? "away" : "draw", over: fh + fa > 2.5 });
  }
}
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });
const split = Math.floor(all.length * 0.7);
const sets = { TRAIN: all.slice(0, split), TEST: all.slice(split) };
const pct = (x) => (x * 100).toFixed(1) + "%";

console.log(`████ 跨市场合成器·选边价值回测 · 五大联赛 ${all.length}场(TRAIN ${sets.TRAIN.length}/TEST ${sets.TEST.length}) ████`);
const baseFav = all.filter((m) => (m.euClose.home <= m.euClose.away ? "home" : "away") === m.result).length / all.length;
const baseDraw = all.filter((m) => m.result === "draw").length / all.length;
console.log(`基线: 无脑背热门命中 ${pct(baseFav)} · 平局率 ${pct(baseDraw)}\n`);

for (const [setName, rows] of Object.entries(sets)) {
  // 按合成器1X2模式分组
  const groups = {};
  let dcN = 0, dcHit = 0;      // 双选(防平)组:命中=热门或平
  let vpN = 0, vpHit = 0;      // 价值袋背平
  for (const m of rows) {
    const s = synthesize(m); if (!s) continue;
    const favSide = m.euClose.home <= m.euClose.away ? "home" : "away";
    const favHit = m.result === favSide ? 1 : 0;
    const drawHit = m.result === "draw" ? 1 : 0;
    const key = s.oneXtwo.mode + "·" + s.oneXtwo.confidence;
    (groups[key] ??= { n: 0, favHit: 0, draw: 0 });
    groups[key].n++; groups[key].favHit += favHit; groups[key].draw += drawHit;
    if (s.oneXtwo.mode.includes("双选")) { dcN++; if (favHit || drawHit) dcHit++; }
    if (s.oneXtwo.mode === "背平价值") { vpN++; if (drawHit) vpHit++; }
  }
  console.log(`── ${setName} ──`);
  console.log("合成器判定(模式·信心)".padEnd(22), "N", "  热门命中", " 平局率");
  for (const [k, v] of Object.entries(groups).sort((a, b) => b[1].favHit / b[1].n - a[1].favHit / a[1].n)) {
    console.log(k.padEnd(22), String(v.n).padStart(4), " " + pct(v.favHit / v.n).padStart(7), " " + pct(v.draw / v.n).padStart(6));
  }
  if (dcN) console.log(`  ▸ 防平双选组 命中(热门或平) ${pct(dcHit / dcN)} (N=${dcN})`);
  if (vpN) console.log(`  ▸ 价值袋背平组 平局命中 ${pct(vpHit / vpN)} (N=${vpN})`);
  console.log();
}
console.log("读法: '单选热门·高/中'组的热门命中率应显著高于'双选(防平)'组(说明分级真把好热门/陷阱热门分开)。");
console.log("诚实: 命中高≠赚钱(收盘已定价);本表证'选择性出手'的方向力,非ROI承诺。背平价值袋是唯一历史正ROI口袋。");
