#!/usr/bin/env node
/**
 * 逐条回测用户让球分线手感规则(2026-06-22)。源:user-handicap-rules.md。
 * 只测"可在football-data大样本表达"的(欧盘1X2区间 + 让球线band)。
 * 判定双轨:① 方向对不对(预测平→实际平局率vs基线25.2%;预测胜负→平局率应更低)
 *          ② 能不能赚钱(ROI:预测平→背平收盘ROI;含TRAIN/TEST OOS)。
 * 诚实:用户范围都很窄→N常偏小,N<60标"样本不足不下结论";需亚盘1X2/让胜让平让负的规则→标"需截图数据"。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function parseCsv(t) { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); }
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) { const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue; for (const g of parseCsv(fs.readFileSync(f, "utf8"))) { const fh = numOr(g("FTHG")), fa = numOr(g("FTAG")); if (fh === null || fa === null) continue; const euC = trip(numOr(g("AvgCH")), numOr(g("AvgCD")), numOr(g("AvgCA"))) ?? trip(numOr(g("B365CH")), numOr(g("B365CD")), numOr(g("B365CA"))); if (!euC) continue; const ahC = numOr(g("AHCh")) ?? numOr(g("AHh")); const d = g("Date") || ""; all.push({ lg, date: d, euC, ahAbs: ahC === null ? null : Math.abs(ahC), goals: fh + fa, result: fh > fa ? "home" : fh < fa ? "away" : "draw" }); } }
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });
const split = Math.floor(all.length * 0.7); const TRAIN = all.slice(0, split), TEST = all.slice(split);
const pct = (x) => (x * 100).toFixed(1) + "%"; const rs = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const baseDraw = all.filter((m) => m.result === "draw").length / all.length;
const segAh = (m) => { if (m.ahAbs === null) return null; const a = m.ahAbs; return a < 0.125 ? "让0" : a < 0.375 ? "让0.25" : a < 0.625 ? "让0.5" : a < 0.875 ? "让0.75" : a < 1.125 ? "让1" : a < 1.375 ? "让1.25" : a < 1.625 ? "让1.5" : "让2+"; };
const inR = (v, r) => !r || (v >= r[0] && v <= r[1]);
function match(m, rule) { if (rule.ah && segAh(m) !== rule.ah) return false; return inR(m.euC.home, rule.h) && inR(m.euC.draw, rule.d) && inR(m.euC.away, rule.a); }
function roi(rows, o) { let s = 0, r = 0; for (const m of rows) { s++; if (m.result === o) r += m.euC[o]; } return s ? r / s - 1 : 0; }
function favRoi(rows) { let s = 0, r = 0; for (const m of rows) { const fav = m.euC.home <= m.euC.away ? "home" : "away"; s++; if (m.result === fav) r += m.euC[fav]; } return s ? r / s - 1 : 0; }

// ===== 编码可测规则(欧盘区间+让球线)。claim: draw=预测平/防平/出平;dec=看胜负/分胜负;home/away=独赢方向 =====
const RULES = [
  { id: "平手·1.7防平", ah: "让0", h: [2.33, 2.6], d: [3.1, 3.9], a: [2.4, 2.7], claim: "draw" },
  { id: "平手·1.9出平", ah: "让0", h: [2.1, 2.4], d: [3.5, 3.85], a: [2.12, 2.8], claim: "draw" },
  { id: "平手·1.5看胜负", ah: "让0", h: [2.0, 2.6], d: [3.5, 4.0], a: [2.0, 2.6], claim: "dec" },
  { id: "0.25·2.4分胜负", ah: "让0.25", h: [1.9, 2.2], d: [3.0, 3.3], a: [2.9, 3.3], claim: "dec" },
  { id: "0.25·2.6胜负", ah: "让0.25", h: [1.8, 2.0], d: [2.85, 2.99], a: [3.5, 3.8], claim: "dec" },
  { id: "0.25·2.7看胜负", ah: "让0.25", h: [2.0, 2.3], d: [2.85, 2.99], a: [3.1, 3.3], claim: "dec" },
  { id: "0.25·2.10高平", ah: "让0.25", h: [2.0, 2.2], d: [3.05, 3.45], a: [3.05, 3.15], claim: "draw" },
  { id: "0.25·2.24易平", ah: "让0.25", h: [2.1, 2.45], d: [3.05, 3.75], a: [3.0, 3.25], claim: "draw" },
  { id: "0.5·3.6胜负", ah: "让0.5", h: [1.8, 2.0], d: [2.85, 2.99], a: [3.5, 4.0], claim: "dec" },
  { id: "0.5·3.8防平", ah: "让0.5", h: [1.5, 1.6], d: [3.1, 4.0], a: [4.5, 5.5], claim: "draw" },
  { id: "0.5·3.10防平", ah: "让0.5", h: [1.6, 1.75], d: [3.55, 3.7], a: [3.9, 4.05], claim: "draw" },
  { id: "0.5·3.19出平", ah: "让0.5", h: [3.4, 3.85], d: [3.3, 3.7], a: [1.85, 2.1], claim: "draw" },
  { id: "0.75·4.6分胜负", ah: "让0.75", h: [1.6, 1.8], d: [3.5, 4.2], a: [4.2, 6.0], claim: "dec" },
  { id: "0.75·4.16出平", ah: "让0.75", h: [1.8, 2.0], d: [3.45, 3.65], a: [3.66, 4.0], claim: "draw" },
  { id: "让1·5.1独赢", ah: "让1", h: [1.4, 1.6], d: [3.5, 3.79], a: [4.6, 5.5], claim: "home" },
  { id: "让1·5.9看平", ah: "让1", h: [1.0, 1.6], d: [4.0, 9], a: [6.5, 20], claim: "draw" },
  { id: "让1.25·1看胜", ah: "让1.25", h: [1.2, 1.4], d: [4.1, 4.7], a: [6.0, 7.0], claim: "home" },
  { id: "通则·欧平3.7非穿即平", ah: null, h: null, d: [3.65, 3.75], a: null, claim: "draw" },
  { id: "通则·欧平3.45-3.9爱平", ah: null, h: null, d: [3.45, 3.9], a: null, claim: "draw" },
];

console.log("████ 用户让球分线规则·逐条回测(五大联赛全7赛季) ████");
console.log(`全样本 ${all.length} 场 · 平局基线 ${pct(baseDraw)} · OOS TRAIN${TRAIN.length}/TEST${TEST.length}\n`);
console.log("规则                         N    实际平   vs基线   背平ROI(全/TRAIN/TEST)        裁决");
for (const rule of RULES) {
  const g = all.filter((m) => match(m, rule));
  if (g.length < 30) { console.log(`${rule.id.padEnd(26)} N=${String(g.length).padStart(3)}  样本不足(<30)不下结论`); continue; }
  const dr = g.filter((m) => m.result === "draw").length / g.length;
  const tr = TRAIN.filter((m) => match(m, rule)), te = TEST.filter((m) => match(m, rule));
  const lift = dr - baseDraw;
  let verdict;
  if (rule.claim === "draw") {
    const rAll = roi(g, "draw"), rTr = roi(tr, "draw"), rTe = roi(te, "draw");
    const dirOk = lift > 0.03;
    const profit = rAll > 0 && rTr > 0 && rTe > 0 && te.length >= 25;
    verdict = profit ? "🟢方向对且背平双正ROI" : dirOk ? "🟡平率高于基线但背平不赚钱" : "⚪不成立(平率≈/<基线)";
    console.log(`${rule.id.padEnd(26)} N=${String(g.length).padStart(3)}  ${pct(dr)}  ${rs(lift)}   ${rs(rAll)}/${rs(rTr)}/${rs(rTe)}${te.length < 25 ? "(testN小)" : ""}  ${verdict}`);
  } else if (rule.claim === "dec") {
    const fr = favRoi(g);
    const dirOk = lift < -0.02;
    verdict = dirOk ? (fr > 0 ? "🟢平率低且背热门正ROI" : "🟡平率确实低但背热门不赚钱") : "⚪不成立(平率未低于基线)";
    console.log(`${rule.id.padEnd(26)} N=${String(g.length).padStart(3)}  ${pct(dr)}  ${rs(lift)}   背热门ROI${rs(fr)}              ${verdict}`);
  } else {
    const side = rule.claim, rAll = roi(g, side), wr = g.filter((m) => m.result === side).length / g.length;
    verdict = rAll > 0 ? "🟢背该方向正ROI" : "⚪背该方向负ROI";
    console.log(`${rule.id.padEnd(26)} N=${String(g.length).padStart(3)}  ${side}胜率${pct(wr)}     背${side}ROI${rs(rAll)}        ${verdict}`);
  }
}
console.log("\n注:① 需要'亚盘1X2/让胜让平让负'具体赔率的规则(平手·8、0.5·12~18、让1·10~13等)football-data无此列,只能用353张截图测(样本太小,见单独说明)。");
console.log("    ② '特例'(西甲1:0/英冠2:2等)、需软信息(保级/进攻型/比赛重要性)的规则=N=1或无数据,无法回测,诚实不测。");
console.log("    ③ 背平ROI口径=收盘欧赔1注;竞彩平赔更低→实战更差。方向对≠能赚钱(收盘已定价)。");
