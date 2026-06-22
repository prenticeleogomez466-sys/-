#!/usr/bin/env node
/**
 * 逐让球线·交叉组合规律(2026-06-22 用户:从平手到让5,不同盘口不同组合内容)。
 * 数据=五大联赛全7赛季12458场。每条线给:样本+胜平负/大小球/让球过盘倾向+该线专属高命中子组合(OOS)。
 * 诚实:五大联赛真实让球线只到~让3.25且让3起N≤12;让3.5/4/5基本不出现(杯赛/低级别才有),无法可靠回测→标缺不编。
 */
import fs from "node:fs";
import path from "node:path";
const DIR = "D:/football-model/data/footballdata", LG = ["D1", "E0", "F1", "I1", "SP1"], SE = ["1920", "2021", "2122", "2223", "2324", "2425", "2526"];
function pcsv(t) { const L = t.split(/\r?\n/).filter((l) => l.trim()); const H = L[0].replace(/^﻿/, "").split(","); const I = (n) => H.indexOf(n); return L.slice(1).map((l) => { const c = l.split(","); return (n) => { const j = I(n); return j >= 0 ? c[j] : undefined; }; }); }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const trip = (h, d, a) => (h > 1 && d > 1 && a > 1 ? { home: h, draw: d, away: a } : null);
const pc = (x) => (x * 100).toFixed(0) + "%";
const all = [];
for (const lg of LG) for (const sea of SE) { const f = path.join(DIR, `${lg}_${sea}.csv`); if (!fs.existsSync(f)) continue; for (const g of pcsv(fs.readFileSync(f, "utf8"))) { const fh = num(g("FTHG")), fa = num(g("FTAG")); if (fh === null || fa === null) continue; const euC = trip(num(g("AvgCH")), num(g("AvgCD")), num(g("AvgCA"))) ?? trip(num(g("B365CH")), num(g("B365CD")), num(g("B365CA"))); if (!euC) continue; const euO = trip(num(g("AvgH")), num(g("AvgD")), num(g("AvgA"))) ?? trip(num(g("B365H")), num(g("B365D")), num(g("B365A"))); const ahC = num(g("AHCh")) ?? num(g("AHh")); if (ahC === null) continue; const d = g("Date") || ""; all.push({ euC, euO, line: ahC, gd: fh - fa, goals: fh + fa, res: fh > fa ? "home" : fh < fa ? "away" : "draw", date: d }); } }
all.sort((a, b) => { const k = (s) => { const m = String(s.date).split("/"); if (m.length < 3) return 0; let y = m[2]; if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y; return +y * 1e4 + +m[1] * 100 + +m[0]; }; return k(a) - k(b); });
const dev = (o) => { const i = [1 / o.home, 1 / o.draw, 1 / o.away], s = i[0] + i[1] + i[2]; return { home: i[0] / s, draw: i[1] / s, away: i[2] / s }; };
function feat(m) { const favHome = m.euC.home <= m.euC.away, favSide = favHome ? "home" : "away"; const di = dev(m.euC), dio = m.euO ? dev(m.euO) : null; const drift = dio ? (di[favSide] - dio[favSide] > 0.02 ? "加注" : di[favSide] - dio[favSide] < -0.02 ? "退烧" : "平稳") : null; const L = m.line; const margin = m.gd + L; const cover = margin > 0.25 ? "让胜" : margin < -0.25 ? "让负" : "让平"; return { favHome, favOdds: m.euC[favSide], drawOdds: m.euC.draw, drift, ahAbs: Math.abs(L), cover, over: m.goals > 2.5, res: m.res }; }
const F = all.map(feat);
const split = Math.floor(F.length * 0.7), TR = F.slice(0, split), TE = F.slice(split);

// 让球线分箱(细到每0.25一档,平手到3+)
const LINES = [["平手(0)", 0, 0.125], ["让0.25", 0.125, 0.375], ["让0.5", 0.375, 0.625], ["让0.75", 0.625, 0.875], ["让1", 0.875, 1.125], ["让1.25", 1.125, 1.375], ["让1.5", 1.375, 1.625], ["让1.75", 1.625, 1.875], ["让2", 1.875, 2.125], ["让2.25", 2.125, 2.375], ["让2.5", 2.375, 2.625], ["让2.75", 2.625, 2.875], ["让3+", 2.875, 99]];
const inBand = (m, lo, hi) => m.ahAbs >= lo && m.ahAbs < hi;
const rate = (rows, fn) => { const n = rows.length; return n ? rows.filter(fn).length / n : 0; };

console.log("████ 逐让球线·交叉组合规律 · 五大联赛全7赛季12458场 ████\n");
console.log("让球线     N    主胜/平/客胜      大球/小球    让胜/让平/让负      该线最强子组合(OOS双稳)");
for (const [name, lo, hi] of LINES) {
  const g = F.filter((m) => inBand(m, lo, hi));
  if (g.length < 30) { console.log(`${name.padEnd(8)} N=${String(g.length).padStart(4)}  ⚠️样本太稀,无法可靠回测(标缺不编)`); continue; }
  const h = pc(rate(g, (m) => m.res === "home")), d = pc(rate(g, (m) => m.res === "draw")), a = pc(rate(g, (m) => m.res === "away"));
  const ov = pc(rate(g, (m) => m.over)), un = pc(rate(g, (m) => !m.over));
  const cw = pc(rate(g, (m) => m.cover === "让胜")), cd = pc(rate(g, (m) => m.cover === "让平")), cl = pc(rate(g, (m) => m.cover === "让负"));
  // 该线内找最强子组合:扫 {drawOdds档/drift/favOdds档} × {主胜,大球,小球} TRAIN/TEST双稳最高
  const trG = TR.filter((m) => inBand(m, lo, hi)), teG = TE.filter((m) => inBand(m, lo, hi));
  const subs = [];
  const dBins = [["平<3.2", (m) => m.drawOdds < 3.2], ["平3.2-3.45", (m) => m.drawOdds >= 3.2 && m.drawOdds < 3.45], ["平3.45-3.7", (m) => m.drawOdds >= 3.45 && m.drawOdds < 3.7], ["平3.7-4", (m) => m.drawOdds >= 3.7 && m.drawOdds < 4], ["平4+", (m) => m.drawOdds >= 4]];
  const fBins = [["热<1.5", (m) => m.favOdds < 1.5], ["热1.5-2", (m) => m.favOdds >= 1.5 && m.favOdds < 2], ["热2+", (m) => m.favOdds >= 2]];
  const drBins = [["加注", (m) => m.drift === "加注"], ["退烧", (m) => m.drift === "退烧"], ["平稳", (m) => m.drift === "平稳"]];
  const mkts = [["主胜", (m) => m.res === "home"], ["大球", (m) => m.over], ["小球", (m) => !m.over], ["让胜", (m) => m.cover === "让胜"], ["让负", (m) => m.cover === "让负"]];
  for (const bins of [dBins, fBins, drBins]) for (const [bn, bf] of bins) for (const [mn, mf] of mkts) {
    const tr = trG.filter(bf), te = teG.filter(bf); if (tr.length < 40 || te.length < 25) continue;
    const pt = rate(tr, mf), pe = rate(te, mf); if (pt >= 0.6 && pe >= 0.58 && Math.abs(pt - pe) <= 0.12) subs.push({ s: `${bn}→${mn}`, p: Math.min(pt, pe), pt, pe });
  }
  subs.sort((x, y) => y.p - x.p);
  const top = subs.length ? subs.slice(0, 2).map((s) => `${s.s}(${pc(s.pt)}/${pc(s.pe)})`).join("·") : "无显著子组合(此线靠基线倾向)";
  console.log(`${name.padEnd(8)} N=${String(g.length).padStart(4)}  ${h}/${d}/${a}    ${ov}/${un}    ${cw}/${cd}/${cl}    ${top}`);
}
console.log("\n基线参考:主胜43%/平25%/客胜32% · 大球53%/小球47% · 让胜39%/让平21%/让负40%");
console.log("读法:'该线最强子组合'=在这条让球线内、TRAIN/TEST双稳命中≥60%的细分组合(如'平<3.2→小球');空=该线无显著高命中细分,只能按整体倾向。");
console.log("⚠️ 让3.5/4/5:五大联赛基本不出现(悬殊盘只在杯赛/低级别),本数据无样本→无法回测;要做须另抓低级别/杯赛数据(样本仍会很少)。");
