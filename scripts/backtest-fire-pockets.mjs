#!/usr/bin/env node
/**
 * backtest-fire-pockets.mjs —— 选择性出手·高命中口袋(2026-06-23 用户:提高"出手时"命中率·以五大联赛为主)。
 * ════════════════════════════════════════════════════════════════════════════
 * 只在五大联赛(资金池大·盘口最有效)上,逐让球线 × 平赔档 × 资金动向,扫出 TRAIN/TEST 双稳的高命中细分,
 * 组成"出手清单":每条=精确条件 → 买方向 + 五大真实命中(训练/测试) + 样本。只列过测的(命中阈值+N足),其余沉默。
 * 诚实:命中高≠盈利(收盘已定价);价值=选择性出手把命中率拉到远高于基线。让球过盘≈掷硬币不出。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata";
const LEAGUES = ["D1", "E0", "F1", "I1", "SP1"];
const SEASONS = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function parseCsv(t) { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const dev = (o) => { const i = [1 / o.home, 1 / o.draw, 1 / o.away], s = i[0] + i[1] + i[2]; return { home: i[0] / s, draw: i[1] / s, away: i[2] / s }; };

const all = [];
for (const lg of LEAGUES) for (const sea of SEASONS) {
  const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue;
  for (const g of parseCsv(fs.readFileSync(f, "utf8"))) {
    const fh = num(g("FTHG")), fa = num(g("FTAG")); if (fh === null || fa === null) continue;
    const euC = trip(num(g("AvgCH")), num(g("AvgCD")), num(g("AvgCA"))) ?? trip(num(g("B365CH")), num(g("B365CD")), num(g("B365CA"))); if (!euC) continue;
    const euO = trip(num(g("AvgH")), num(g("AvgD")), num(g("AvgA"))) ?? trip(num(g("B365H")), num(g("B365D")), num(g("B365A")));
    const ahC = num(g("AHCh")) ?? num(g("AHh"));
    const favHome = euC.home <= euC.away, favSide = favHome ? "home" : "away";
    const di = dev(euC), dio = euO ? dev(euO) : null;
    const drift = dio ? (di[favSide] - dio[favSide] > 0.02 ? "加注" : di[favSide] - dio[favSide] < -0.02 ? "退烧" : "平稳") : null;
    // 让球过盘(热门视角):favMargin=热门净胜球;favCover=favMargin - 让球线绝对值(热门让球);>0.25热门过盘(让胜),<-0.25未过盘(让负),否则走盘(让平)
    const favMargin = favHome ? fh - fa : fa - fh;
    const favCoverEdge = ahC === null ? null : favMargin - Math.abs(ahC);
    const cover = favCoverEdge === null ? null : favCoverEdge > 0.25 ? "让胜" : favCoverEdge < -0.25 ? "让负" : "让平";
    all.push({ date: g("Date") || "", favSide, favOdds: euC[favSide], drawOdds: euC.draw, drift,
      ahAbs: ahC === null ? null : Math.abs(ahC), over: fh + fa > 2.5, cover,
      result: fh > fa ? "home" : fh < fa ? "away" : "draw" });
  }
}
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });
const split = Math.floor(all.length * 0.7), TR = all.slice(0, split), TE = all.slice(split);
const pc = (x) => (x * 100).toFixed(0) + "%";
console.log(`████ 选择性出手·高命中口袋 · 五大联赛 ${all.length}场(TRAIN ${TR.length}/TEST ${TE.length}) ████`);
console.log(`基线: 主胜43%/平25%/客33% · 大球53%/小球47% · 热门命中54%\n`);

const LINES = [["平手", 0, 0.125], ["让0.25", 0.125, 0.375], ["让0.5", 0.375, 0.625], ["让0.75", 0.625, 0.875], ["让1", 0.875, 1.125], ["让1.25", 1.125, 1.375], ["让1.5", 1.375, 1.625], ["让2+", 1.625, 9]];
const inLine = (m, lo, hi) => m.ahAbs !== null && m.ahAbs >= lo && m.ahAbs < hi;
const dSubs = [["平<3.2", (m) => m.drawOdds < 3.2], ["平3.2-3.5", (m) => m.drawOdds >= 3.2 && m.drawOdds < 3.5], ["平3.5-3.7", (m) => m.drawOdds >= 3.5 && m.drawOdds < 3.7], ["平3.7-4", (m) => m.drawOdds >= 3.7 && m.drawOdds < 4], ["平4+", (m) => m.drawOdds >= 4]];
const drSubs = [["加注", (m) => m.drift === "加注"], ["退烧", (m) => m.drift === "退烧"], ["平稳", (m) => m.drift === "平稳"]];
const mkts = [["大球", (m) => m.over, 0.62], ["小球", (m) => !m.over, 0.60], ["主胜(热门)", (m) => m.result === m.favSide, 0.66], ["平局", (m) => m.result === "draw", 0.34], ["让胜(热门过盘)", (m) => m.cover === "让胜", 0.60], ["让负(热门不过)", (m) => m.cover === "让负", 0.60]];
const rate = (rows, fn) => rows.length ? rows.filter(fn).length / rows.length : 0;

const fired = [];
for (const [ln, lo, hi] of LINES) {
  const trL = TR.filter((m) => inLine(m, lo, hi)), teL = TE.filter((m) => inLine(m, lo, hi));
  if (trL.length < 80) continue;
  for (const subs of [dSubs, drSubs]) for (const [sn, sf] of subs) for (const [mn, mf, thr] of mkts) {
    const tr = trL.filter(sf), te = teL.filter(sf);
    if (tr.length < 50 || te.length < 30) continue;
    const pt = rate(tr, mf), pe = rate(te, mf);
    if (pt >= thr && pe >= thr - 0.03 && Math.abs(pt - pe) <= 0.12) {
      fired.push({ cond: `${ln}+${sn}`, buy: mn, tr: pt, te: pe, n: te.length + tr.length, thr });
    }
  }
}
fired.sort((a, b) => Math.min(b.tr, b.te) - Math.min(a.tr, a.te));
console.log("══ 过测出手口袋(TRAIN&TEST双稳·五大联赛)══");
console.log("精确条件".padEnd(20), "→买", "  命中(训练/测试)", " 样本N");
for (const f of fired) console.log(`${f.cond.padEnd(20)} ${f.buy.padEnd(8)} ${pc(f.tr)}/${pc(f.te)}     ${f.n}`);
if (!fired.length) console.log("  (本阈值下无过测口袋)");
console.log(`\n共 ${fired.length} 个高命中出手口袋。读法:只在这些精确条件出现时出手,命中率远高于基线;其余场次沉默(不硬凑)。`);
console.log("诚实:命中高≠盈利(收盘已定价);五大联赛资金池大、盘口最有效,口袋是选择性出手的方向力,非稳赚。");
