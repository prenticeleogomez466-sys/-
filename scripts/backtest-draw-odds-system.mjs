#!/usr/bin/env node
/**
 * backtest-draw-odds-system.mjs —— 系统性回测用户「平赔率体系/防平·看胜负」盘口手感(2026-06-23 用户令:全部吃透后回测,告诉我哪些高度吻合、真有条件→方向价值)。
 * ════════════════════════════════════════════════════════════════════════════
 * 数据:五大联赛全7赛季(本地 data/footballdata CSV),收盘欧赔(AvgC→B365C回退)+初盘欧赔(Avg→B365)+亚盘让球线(AHCh→AHh)。
 * 方法(leak-safe):按真实日期时序 70/30 切 TRAIN/TEST;每个条件报 N + 实际平率/主胜/客胜 + 超基线 + TRAIN/TEST双稳 + (背平ROI)。
 * 诚实铁律(reference_signal_backtest_findings + draw_blindspot):平局是头号难市场;高于基线≠能赚钱(收盘已定价);
 *   需亚盘1X2/让胜让平让负/软信息(保级/进攻/杯赛重要性)的规则→football-data无此列,标缺不测。
 *
 * 输出口径:
 *   - 防平类(预测"平局率显著高")→ 看 实际平率 vs 基线25%、TRAIN/TEST同向、+背平收盘ROI是否>0。
 *   - 看胜负类(预测"平局率显著低·该下注一方)→ 看 实际平率 vs 基线、是否更低。
 *   裁决:🟢高度吻合(TRAIN&TEST同向+TEST超基线≥4pp+N足) / 🟡方向对但弱(2-4pp) / ⚪不成立(≈或反) / ⚠️样本不足。
 */
import fs from "node:fs";
import path from "node:path";

const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];

function parseCsv(t) {
  const L = t.split(/\r?\n/).filter((l) => l.trim());
  const H = L[0].replace(/^﻿/, "").split(",");
  const I = (n) => H.indexOf(n);
  return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; });
}
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`);
  if (!fs.existsSync(f)) continue;
  for (const g of parseCsv(fs.readFileSync(f, "utf8"))) {
    const fh = numOr(g("FTHG")), fa = numOr(g("FTAG"));
    if (fh === null || fa === null) continue;
    const euC = trip(numOr(g("AvgCH")), numOr(g("AvgCD")), numOr(g("AvgCA"))) ?? trip(numOr(g("B365CH")), numOr(g("B365CD")), numOr(g("B365CA")));
    if (!euC) continue;
    const euO = trip(numOr(g("AvgH")), numOr(g("AvgD")), numOr(g("AvgA"))) ?? trip(numOr(g("B365H")), numOr(g("B365D")), numOr(g("B365A")));
    const ahC = numOr(g("AHCh")) ?? numOr(g("AHh"));
    all.push({
      lg, date: g("Date") || "", euC, euO,
      ahAbs: ahC === null ? null : Math.abs(ahC),
      goals: fh + fa,
      result: fh > fa ? "home" : fh < fa ? "away" : "draw",
      fav: euC.home <= euC.away ? "home" : "away",
    });
  }
}
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });

const split = Math.floor(all.length * 0.7);
const TRAIN = all.slice(0, split), TEST = all.slice(split);
const pct = (x) => (x * 100).toFixed(1) + "%";
const sp = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "pp";
const rs = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%";
const drawRate = (rows) => rows.length ? rows.filter((m) => m.result === "draw").length / rows.length : 0;
const baseDraw = drawRate(all);
const baseHome = all.filter((m) => m.result === "home").length / all.length;
const baseAway = all.filter((m) => m.result === "away").length / all.length;
// 背平收盘ROI(1注),与命中分离看
const drawRoi = (rows) => { if (!rows.length) return 0; let r = 0; for (const m of rows) if (m.result === "draw") r += m.euC.draw; return r / rows.length - 1; };
const favRoi = (rows) => { if (!rows.length) return 0; let r = 0; for (const m of rows) if (m.result === m.fav) r += m.euC[m.fav]; return r / rows.length - 1; };

const segAh = (m) => { if (m.ahAbs === null) return "?"; const a = m.ahAbs; return a < 0.125 ? "平手" : a < 0.375 ? "让0.25" : a < 0.625 ? "让0.5" : a < 0.875 ? "让0.75" : a < 1.125 ? "让1" : a < 1.375 ? "让1.25" : "让1.5+"; };

console.log(`████ 用户「平赔率体系/防平·看胜负」系统回测 · 五大联赛全7赛季 ${all.length}场 ████`);
console.log(`基线: 平局 ${pct(baseDraw)} · 主胜 ${pct(baseHome)} · 客胜 ${pct(baseAway)} | OOS TRAIN ${TRAIN.length}/TEST ${TEST.length}\n`);

// 通用裁决:expect="draw"(防平/看平,平率应↑) 或 "dec"(看胜负,平率应↓)
function judge(name, filt, expect, extra = "") {
  const g = all.filter(filt), tr = TRAIN.filter(filt), te = TEST.filter(filt);
  if (g.length < 60) { console.log(`${name.padEnd(30)} N=${String(g.length).padStart(4)}  ⚠️样本不足(<60)`); return null; }
  const dr = drawRate(g), trD = drawRate(tr), teD = drawRate(te);
  const lift = dr - baseDraw, teLift = teD - baseDraw, trLift = trD - baseDraw;
  let verdict, roiStr = "";
  if (expect === "draw") {
    const stable = Math.sign(trLift) > 0 && teLift >= 0.04;
    verdict = stable ? "🟢高度吻合" : teLift >= 0.02 && trLift > 0 ? "🟡方向对但弱" : "⚪不成立";
    roiStr = `背平ROI ${rs(drawRoi(g))}(te${rs(drawRoi(te))})`;
  } else {
    const stable = trLift < 0 && teLift <= -0.04;
    verdict = stable ? "🟢高度吻合" : teLift <= -0.02 && trLift < 0 ? "🟡方向对但弱" : "⚪不成立";
    roiStr = `背热门ROI ${rs(favRoi(g))}`;
  }
  console.log(`${name.padEnd(30)} N=${String(g.length).padStart(4)}  平${pct(dr)}(基${sp(lift)}) TR${pct(trD)}/TE${pct(teD)}  ${roiStr}  ${verdict}${extra ? " " + extra : ""}`);
  return { name, n: g.length, dr, teLift, verdict };
}

// ══ ① 核心:平赔率分档 → 平局率(直接验证"防平/看胜负"赔率分区) ══
console.log("══ ① 收盘平赔率分档 → 实际平局率(用户核心:某些平赔区间高平/某些看胜负)══");
const drawBands = [
  ["平赔<2.7", (m) => m.euC.draw < 2.7],
  ["平赔2.7-2.9", (m) => m.euC.draw >= 2.7 && m.euC.draw < 2.9],
  ["平赔2.9-3.05", (m) => m.euC.draw >= 2.9 && m.euC.draw < 3.05],
  ["平赔3.05-3.2", (m) => m.euC.draw >= 3.05 && m.euC.draw < 3.2],
  ["平赔3.2-3.35", (m) => m.euC.draw >= 3.2 && m.euC.draw < 3.35],
  ["平赔3.35-3.5", (m) => m.euC.draw >= 3.35 && m.euC.draw < 3.5],
  ["平赔3.5-3.7", (m) => m.euC.draw >= 3.5 && m.euC.draw < 3.7],
  ["平赔3.7-3.9", (m) => m.euC.draw >= 3.7 && m.euC.draw < 3.9],
  ["平赔3.9-4.2", (m) => m.euC.draw >= 3.9 && m.euC.draw < 4.2],
  ["平赔4.2+", (m) => m.euC.draw >= 4.2],
];
for (const [n, f] of drawBands) {
  const g = all.filter(f), te = TEST.filter(f);
  const dr = drawRate(g), teD = drawRate(te);
  console.log(`${n.padEnd(16)} N=${String(g.length).padStart(4)}  平${pct(dr)}(基${sp(dr - baseDraw)}) TE${pct(teD)}  背平ROI${rs(drawRoi(g))}`);
}

// ══ ② 用户结构性条件 ══
console.log("\n══ ② 结构性条件 → 方向(用户规则核心命题)══");
const maxOdd = (m) => Math.max(m.euC.home, m.euC.draw, m.euC.away);
const drawIsMax = (m) => m.euC.draw >= m.euC.home && m.euC.draw >= m.euC.away;
const haGap = (m) => Math.abs(m.euC.home - m.euC.away);

judge("三门全<3(高平概率)", (m) => m.euC.home < 3 && m.euC.draw < 3 && m.euC.away < 3, "draw");
judge("平赔最高(平>胜&平>负)", drawIsMax, "draw");
judge("胜负相近(差<0.3)+平>3.5", (m) => haGap(m) < 0.3 && m.euC.draw > 3.5, "dec");
judge("胜负相近(差<0.3)+平2.4-2.6内", (m) => haGap(m) < 0.3 && m.euC.draw >= 2.4 && m.euC.draw <= 2.6, "draw");
judge("胜负相近(差<0.3)+平<3.0", (m) => haGap(m) < 0.3 && m.euC.draw < 3.0, "draw");
judge("胜负相近(差<0.4)总体", (m) => haGap(m) < 0.4, "draw");
judge("平负相近(差<0.25)", (m) => Math.abs(m.euC.draw - m.euC.away) < 0.25 || Math.abs(m.euC.draw - m.euC.home) < 0.25, "draw");
judge("平赔3.45±0.03(用户高平点)", (m) => m.euC.draw >= 3.42 && m.euC.draw <= 3.48, "draw");
judge("平赔3.05-3.10(用户防平点)", (m) => m.euC.draw >= 3.03 && m.euC.draw <= 3.12, "draw");
judge("平赔3.55-3.85(用户看胜负点)", (m) => m.euC.draw >= 3.55 && m.euC.draw <= 3.85, "dec");

// ══ ③ 让球线 × 平赔(用户:不同盘口不同规律)══
console.log("\n══ ③ 让球线 × 平赔区间 → 方向 ══");
judge("平手盘+胜负相近(差<0.3)", (m) => segAh(m) === "平手" && haGap(m) < 0.3, "draw");
judge("平手盘+平>3.5", (m) => segAh(m) === "平手" && m.euC.draw > 3.5, "dec");
judge("让0.25+负<平(客赔<平赔)", (m) => segAh(m) === "让0.25" && m.euC.away < m.euC.draw, "dec");
judge("让0.25+平负都>3", (m) => segAh(m) === "让0.25" && m.euC.draw > 3 && (m.fav === "home" ? m.euC.away : m.euC.home) > 3, "dec");
judge("让0.5+胜<2+平>3.5", (m) => segAh(m) === "让0.5" && Math.min(m.euC.home, m.euC.away) < 2 && m.euC.draw > 3.5, "dec");
judge("让0.5/0.75大热+平负≈4", (m) => (segAh(m) === "让0.5" || segAh(m) === "让0.75") && m.euC.draw >= 3.7 && m.euC.draw <= 4.2 && (m.fav === "home" ? m.euC.away : m.euC.home) >= 3.8 && (m.fav === "home" ? m.euC.away : m.euC.home) <= 4.3, "draw");

// ══ ④ 大热门让1+ 平高负高 → 看平(已知唯一过测,复证+细化)══
console.log("\n══ ④ 大热门 + 平高负高 → 看平(背平价值)══");
judge("让1+ 平>4 负>6.5", (m) => m.ahAbs !== null && m.ahAbs >= 0.875 && m.euC.draw >= 4 && (m.fav === "home" ? m.euC.away : m.euC.home) >= 6.5, "draw");
judge("超大热(热赔<1.5)+平>4", (m) => Math.min(m.euC.home, m.euC.away) < 1.5 && m.euC.draw >= 4, "draw");
judge("热赔1.4-1.6+平3.9-4.3+负>5", (m) => { const fo = Math.min(m.euC.home, m.euC.away), dg = m.fav === "home" ? m.euC.away : m.euC.home; return fo >= 1.4 && fo <= 1.6 && m.euC.draw >= 3.9 && m.euC.draw <= 4.3 && dg >= 5; }, "draw");

// ══ ⑤ 初盘→收盘 平赔变化(用户:没开亚盘看初盘vs最新)══
console.log("\n══ ⑤ 平赔 初盘→收盘 移动 → 平局率 ══");
const drawDrift = (m) => (m.euO && m.euO.draw > 1) ? (1 / m.euC.draw) - (1 / m.euO.draw) : null; // >0 平隐含↑(钱压平)
judge("平赔被加注(平隐含↑≥2%)", (m) => { const d = drawDrift(m); return d != null && d >= 0.02; }, "draw");
judge("平赔退烧(平隐含↓≥2%)", (m) => { const d = drawDrift(m); return d != null && d <= -0.02; }, "dec");

console.log("\n注: ① 背平ROI=收盘欧赔1注;竞彩平赔更低→实战更差。命中高≠赚钱(收盘已定价)。");
console.log("    ② 需亚盘1X2/让胜让平让负/软信息(保级·进攻型·杯赛重要性)的规则football-data无→未列,非否定。");
console.log(`    ③ 裁决: 🟢=TRAIN&TEST同向+TEST超基线≥4pp+N≥60; 🟡=2-4pp弱; ⚪=不成立。基线平${pct(baseDraw)}。`);
