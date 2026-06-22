#!/usr/bin/env node
/** 组合触发器 catalog xlsx(2026-06-22):规则全表 + 386场逐场触发 + 引擎验证。 */
import fs from "node:fs";
import { writeXlsxWorkbook } from "../src/xlsx-writer.js";
import { comboTriggers, RULES } from "../src/combo-triggers.js";

const ss = JSON.parse(fs.readFileSync("D:/football-model-data/screenshots-ocr/all.json", "utf8")).filter((x) => x.finished && Array.isArray(x.ft) && x.crow_eu_close);
const pc = (x) => (x * 100).toFixed(0) + "%";

// Sheet1: 规则全表
const tierName = { 高: "🟢高(实测OOS稳)", 中: "🟡中", 提醒: "⚠️避坑", 倾向: "·倾向(用户规则)", 弱: "弱" };
const s1 = [
  ["⚡ 神选·交叉组合触发器 · 规律全表 · 2026-06-22"],
  ["市场", "触发条件", "预测", "信心档", "回测命中(TRAIN/TEST)", "超基线", "样本N", "来源"],
];
for (const r of RULES) {
  s1.push([r.market, r.why, r.predict, tierName[r.tier] || r.tier, `${pc(r.hit.tr)}/${pc(r.hit.te)}`, "+" + ((r.hit.tr + r.hit.te) / 2 - r.base) > 0 ? "+" + (((r.hit.tr + r.hit.te) / 2 - r.base) * 100).toFixed(0) + "pp" : "—", String(r.hit.n), r.src]);
}

// Sheet2: 逐场触发
const toMatch = (x) => { const c = x.crow_eu_close, o = x.crow_eu_open; return { euClose: { home: c[0], draw: c[1], away: c[2] }, euOpen: Array.isArray(o) && o.every((v) => v > 1) ? { home: o[0], draw: o[1], away: o[2] } : null, ahLineClose: x.crow_ah_close ? x.crow_ah_close[1] : null, ahLineOpen: x.crow_ah_open ? x.crow_ah_open[1] : null }; };
const s2 = [
  ["神选·逐场触发(386张真竞彩截图·独立验证集)"],
  ["联赛", "对阵", "实际比分", "结果", "大小", "触发的规律(预测·信心·历史命中)"],
];
for (const x of ss) {
  const r = comboTriggers(toMatch(x)); if (!r) continue;
  const [h, a] = x.ft; const res = h > a ? "主胜" : h < a ? "客胜" : "平局"; const ov = h + a > 2.5 ? "大球" : "小球";
  const trg = r.triggers.length ? r.triggers.map((t) => `${t.tier === "高" ? "🟢" : t.tier === "中" ? "🟡" : t.tier === "提醒" ? "⚠️" : "·"}${t.predict}(${pc(t.hitRate.te)})`).join(" ｜ ") : "无触发";
  s2.push([x.league || "?", `${x.home} vs ${x.away}`, `${h}-${a}`, res, ov, trg]);
}

// Sheet3: 引擎验证(逐规则截图命中 vs 回测)
const agg = {};
for (const x of ss) { const r = comboTriggers(toMatch(x)); if (!r) continue; const [h, a] = x.ft; const res = h > a ? "主胜" : h < a ? "客胜" : "平局"; const over = h + a > 2.5;
  for (const t of r.triggers) { let ok = null;
    if (t.predict === "主胜") ok = res === "主胜"; else if (t.predict === "客胜") ok = res === "客胜"; else if (t.predict.includes("平")) ok = res === "平局"; else if (t.predict === "大球") ok = over; else if (t.predict === "小球") ok = !over; else if (t.predict.includes("骤降") || t.predict.includes("当胆")) ok = r.features.favHome ? res !== "主胜" : res !== "客胜"; else if (t.predict.includes("可靠")) ok = r.features.favHome ? res === "主胜" : res === "客胜";
    if (ok === null) continue; (agg[t.id] ||= { id: t.id, predict: t.predict, tier: t.tier, te: t.hitRate.te, n: 0, k: 0 }); agg[t.id].n++; if (ok) agg[t.id].k++; } }
const s3 = [
  ["神选·引擎端到端验证 · 386张独立截图(组合从12458场football-data挖,截图未参与训练)"],
  ["规律", "预测", "信心", "截图命中", "样本N", "回测命中(TEST)", "是否可迁移"],
];
for (const a of Object.values(agg).sort((x, y) => (y.k / y.n) - (x.k / x.n))) {
  const verdict = a.n < 8 ? "⚠️样本小" : a.k / a.n >= a.te - 0.12 ? "✅可迁移" : "🔶偏低";
  s3.push([a.id, a.predict, a.tier, pc(a.k / a.n), String(a.n), pc(a.te), verdict]);
}

// Sheet4: 逐让球线规律(平手→让3+),读football-data全7赛季
import path from "node:path";
const DIRS = ["D:/football-model/data/footballdata", "D:/football-model/data/footballdata-extra"]; // 五大+17低级别(补深让球线)
const pcsv = (t) => { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const fd = [];
for (const D of DIRS) { if (!fs.existsSync(D)) continue; for (const fn of fs.readdirSync(D)) { if (!fn.endsWith(".csv")) continue; for (const g of pcsv(fs.readFileSync(path.join(D, fn), "utf8"))) { const fh = num(g("FTHG")), fa = num(g("FTAG")); if (fh === null || fa === null) continue; const euC = trip(num(g("AvgCH")), num(g("AvgCD")), num(g("AvgCA"))) ?? trip(num(g("B365CH")), num(g("B365CD")), num(g("B365CA"))); if (!euC) continue; const ahC = num(g("AHCh")) ?? num(g("AHh")); if (ahC === null) continue; fd.push({ favHome: euC.home <= euC.away, ahAbs: Math.abs(ahC), gd: fh - fa, goals: fh + fa, res: fh > fa ? "home" : fh < fa ? "away" : "draw" }); } } }
const LINES = [["平手(0)", 0, 0.125], ["让0.25", 0.125, 0.375], ["让0.5", 0.375, 0.625], ["让0.75", 0.625, 0.875], ["让1", 0.875, 1.125], ["让1.25", 1.125, 1.375], ["让1.5", 1.375, 1.625], ["让1.75", 1.625, 1.875], ["让2", 1.875, 2.125], ["让2.25", 2.125, 2.375], ["让2.5", 2.375, 2.625], ["让2.75", 2.625, 2.875], ["让3", 2.875, 3.125], ["让3.25+", 3.125, 99]];
const rt = (rows, fn) => rows.length ? rows.filter(fn).length / rows.length : 0;
const s4 = [["神选·逐让球线交叉规律 · 五大联赛全7赛季12458场 · 不同盘口不同组合内容"], ["让球线", "样本N", "主胜", "平局", "客胜", "大球", "小球", "让胜", "让平", "让负", "该线倾向(大白话)"]];
for (const [nm, lo, hi] of LINES) {
  const g = fd.filter((m) => m.ahAbs >= lo && m.ahAbs < hi);
  if (g.length < 30) { s4.push([nm, String(g.length), "⚠️样本太稀·无法可靠回测(让3.5/4/5五大联赛基本不出现,须杯赛/低级别数据)", "", "", "", "", "", "", "", ""]); continue; }
  const cover = (m) => { const x = m.gd - (m.favHome ? m.ahAbs : -m.ahAbs); return x > 0.25 ? "让胜" : x < -0.25 ? "让负" : "让平"; };
  const h = rt(g, (m) => m.res === "home"), d = rt(g, (m) => m.res === "draw"), a = rt(g, (m) => m.res === "away"), ov = rt(g, (m) => m.goals > 2.5);
  const cw = rt(g, (m) => cover(m) === "让胜"), cd = rt(g, (m) => cover(m) === "让平"), cl = rt(g, (m) => cover(m) === "让负");
  const tip = lo < 0.4 ? "胶着盘:胜平负三七开·平局偏多(30%)·大小球近基线·让球≈掷硬币" : lo < 0.9 ? "中等盘:主队渐占优·大球抬头·平局开始走低" : lo < 1.6 ? "明显盘:主胜近5成+·大球6成·平局压到20%以内" : "悬殊盘:主胜7-8成+·大球7成·平局个位数·但赔率已定价非盈利";
  s4.push([nm, String(g.length), pcc(h), pcc(d), pcc(a), pcc(ov), pcc(1 - ov), pcc(cw), pcc(cd), pcc(cl), tip]);
}
function pcc(x) { return (x * 100).toFixed(0) + "%"; }

const dir = "C:/Users/Administrator/Desktop/足球推荐/组合触发器";
fs.mkdirSync(dir, { recursive: true });
const out = `${dir}/神选-交叉组合触发器-2026-06-22.xlsx`;
writeXlsxWorkbook(out, [
  { name: "组合规律全表", rows: s1 },
  { name: "逐让球线规律", rows: s4 },
  { name: "逐场触发386场", rows: s2 },
  { name: "引擎验证", rows: s3 },
]);
console.log("已生成:", out);
console.log("规则", RULES.length, "条 · 逐场", s2.length - 2, "场 · 验证", s3.length - 2, "规则");
