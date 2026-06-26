#!/usr/bin/env node
/**
 * build-combo-outcomes.mjs (2026-06-23 用户:组合表必须给"胜负平方向+比分+半全场+样本+胜率")
 *
 * 用生产 comboTriggers 引擎,在 12458 场五大联赛全7赛季本地CSV 上复算每条规则触发后的
 * 真实赛果分布(胜负平/最常见比分/最常见半全场/大小球),口径与引擎完全一致(同一套 fire 条件)。
 * CSV 同时有 FTHG/FTAG(全场)+HTHG/HTAG(半场)→ 比分与半全场都是真实统计,非赔率派生。
 *
 * 产出 D:/football-model/data/combo-rule-outcomes.json,由 combo-triggers.js 读入,
 * 让每条规则带上 score(top比分)/halfFull(top半全场)/dirHit(预测方向真实命中率)/n。
 */
import fs from "node:fs";
import path from "node:path";
import { comboTriggers, RULES } from "../src/combo-triggers.js";

const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
// 大小球 over 隐含概率(两路 devig)
const overProb = (o, u) => (o > 1 && u > 1 ? (1 / o) / (1 / o + 1 / u) : null);

function parseCsv(t) {
  const L = t.split(/\r?\n/).filter((l) => l.trim());
  const H = L[0].replace(/^﻿/, "").split(",");
  const I = (n) => H.indexOf(n);
  return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; });
}

// 一行 CSV → comboTriggers 期望的 m 对象 + 真实赛果
function toRow(g) {
  const fh = num(g("FTHG")), fa = num(g("FTAG"));
  if (fh === null || fa === null) return null;
  const ht_h = num(g("HTHG")), ht_a = num(g("HTAG"));
  const euC = trip(num(g("AvgCH")), num(g("AvgCD")), num(g("AvgCA"))) ?? trip(num(g("B365CH")), num(g("B365CD")), num(g("B365CA")));
  if (!euC) return null;
  const euO = trip(num(g("AvgH")), num(g("AvgD")), num(g("AvgA"))) ?? trip(num(g("B365H")), num(g("B365D")), num(g("B365A")));
  const m = {
    euClose: euC,
    euOpen: euO,
    ahLineClose: num(g("AHCh")),
    ahLineOpen: num(g("AHh")),
    ouClose: overProb(num(g("AvgC>2.5")), num(g("AvgC<2.5"))),
    ouOpen: overProb(num(g("Avg>2.5")), num(g("Avg<2.5"))),
    waterHomeClose: num(g("AvgCAHH")), waterAwayClose: num(g("AvgCAHA")),
    waterHomeOpen: num(g("AvgAHH")), waterAwayOpen: num(g("AvgAHA")),
  };
  const favHome = euC.home <= euC.away;
  const res = fh > fa ? "主胜" : fh < fa ? "客胜" : "平局";
  const htRes = ht_h === null || ht_a === null ? null : (ht_h > ht_a ? "H" : ht_h < ht_a ? "A" : "D");
  const ftRes = fh > fa ? "H" : fh < fa ? "A" : "D";
  // 半全场以"热门视角"归一:热-热/平-热/... 用 热/冷/平 标签(与 RULE_HIST hf 口径一致)
  const sideTag = (r) => r === "D" ? "平" : (favHome ? (r === "H" ? "热" : "冷") : (r === "A" ? "热" : "冷"));
  const halfFull = htRes ? `${sideTag(htRes)}-${sideTag(ftRes)}` : null;
  return { m, favHome, res, over: fh + fa > 2.5, score: `${fh}-${fa}`,
    // 比分按热门视角归一(热门进球-冷门进球),让不同主客场的同形态比分能聚合
    scoreFav: favHome ? `${fh}-${fa}` : `${fa}-${fh}`, halfFull };
}

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`);
  if (!fs.existsSync(f)) continue;
  for (const g of parseCsv(fs.readFileSync(f, "utf8"))) { const r = toRow(g); if (r) all.push(r); }
}

const dirHitFn = {
  "主胜": (r) => r.res === "主胜", "客胜": (r) => r.res === "客胜", "平局": (r) => r.res === "平局",
  "大球": (r) => r.over, "小球": (r) => !r.over,
};
function predMatch(predict, r) {
  if (predict === "主胜") return r.res === "主胜";
  if (predict === "客胜") return r.res === "客胜";
  if (predict.includes("平")) return r.res === "平局";
  if (predict === "大球") return r.over;
  if (predict === "小球") return !r.over;
  if (predict.includes("骤降") || predict.includes("别当胆")) return r.favHome ? r.res !== "主胜" : r.res !== "客胜";
  if (predict.includes("可靠")) return r.favHome ? r.res === "主胜" : r.res === "客胜";
  return null;
}
const topN = (counts, n) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);

// 逐规则聚合
const agg = {};
for (const r of all) {
  const out = comboTriggers(r.m);
  if (!out) continue;
  for (const t of out.triggers) {
    const a = (agg[t.id] ||= { id: t.id, predict: t.predict, n: 0, hit: 0,
      scoreFav: {}, score: {}, hf: {}, over: 0, resCount: { 主胜: 0, 平局: 0, 客胜: 0 } });
    a.n++;
    const h = predMatch(t.predict, r);
    if (h) a.hit++;
    a.resCount[r.res]++;
    if (r.over) a.over++;
    a.scoreFav[r.scoreFav] = (a.scoreFav[r.scoreFav] || 0) + 1;
    a.score[r.score] = (a.score[r.score] || 0) + 1;
    if (r.halfFull) a.hf[r.halfFull] = (a.hf[r.halfFull] || 0) + 1;
  }
}

const result = {};
for (const a of Object.values(agg)) {
  if (a.n < 30) continue; // 样本太薄不出比分
  const pc = (x) => Math.round((x / a.n) * 100);
  result[a.id] = {
    n: a.n,
    predict: a.predict,
    dirHit: Math.round((a.hit / a.n) * 1000) / 10, // 预测方向真实命中%
    overPct: pc(a.over),
    res: { 主胜: pc(a.resCount.主胜), 平局: pc(a.resCount.平局), 客胜: pc(a.resCount.客胜) },
    scoreTop: topN(a.scoreFav, 3).map(([s, c]) => ({ s, pct: pc(c) })), // 热门视角比分(热-冷)
    hfTop: topN(a.hf, 3).map(([s, c]) => ({ s, pct: pc(c) })),
  };
}

const OUT = "D:/football-model/data/combo-rule-outcomes.json";
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`████ 组合规则真实赛果分布 · ${all.length}场五大联赛全7赛季 ████\n`);
console.log("规则".padEnd(30) + "样本 方向命中  最常见比分(热视角)        最常见半全场");
for (const id of Object.keys(result)) {
  const r = result[id];
  const sc = r.scoreTop.map((x) => `${x.s}(${x.pct}%)`).join(" ");
  const hf = r.hfTop.map((x) => `${x.s}(${x.pct}%)`).join(" ");
  console.log(`${id.padEnd(28)} ${String(r.n).padStart(5)} ${(r.dirHit + "%").padStart(6)}  ${sc.padEnd(26)} ${hf}`);
}
console.log(`\n写入 ${OUT}`);
