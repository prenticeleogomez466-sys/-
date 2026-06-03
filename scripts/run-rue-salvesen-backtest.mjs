#!/usr/bin/env node
/**
 * Rue-Salvesen γ 进球收缩 — leak-safe 净增益回测(吸收 goalmodel)。
 *
 * 缺口:生产 sampleScoreline 用 λ_home=λtot·we / λ_away=λtot·(1−we) 线性拆分。
 *   we 是【胜率】非【进球比】,实力差大时会过度放大领先方 λ(we=0.9→λ 2.34 vs 0.26),
 *   现实中强队不会无限刷分(Rue & Salvesen 2000 观测)。
 * Rue-Salvesen 修正:压缩两队 log-λ 之差,几何均值(总进球)不变、差距按 (1−γ) 收缩:
 *   δ=(logλh−logλa)/2; λh←λh·exp(−γδ); λa←λa·exp(+γδ)。γ=0 无变化,γ>0 收缩。
 *
 * 检验(49k 国际赛,martj42):walk-forward 自训练 Elo→we→线性拆 λ(λtot=leak-safe running mean),
 *   对 γ 网格建独立泊松比分矩阵,评 WLD log-loss + 精确比分 log-loss。
 *   【train 段(早期)调 γ,holdout 段(近期)评估】→ 防过拟合,纯 leak-safe。
 *   裁决:holdout 最优 γ 的 LL 显著低于 γ=0 才接进生产拆分。
 *
 * 用法: node scripts/run-rue-salvesen-backtest.mjs
 */
import { readFileSync } from "node:fs";
import { eloExpectation } from "../src/world-cup-priors.js";

const EPS = 1e-9, MAXG = 10;
const ll = (p) => -Math.log(Math.max(p, EPS));
const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");
// 泊松 pmf 表(0..MAXG)
function poisPmf(lam) {
  const out = []; let p = Math.exp(-lam);
  for (let k = 0; k <= MAXG; k++) { out.push(p); p = p * lam / (k + 1); }
  return out;
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const c = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch;
    }
    c.push(cur); rows.push(c);
  }
  return rows;
}

function load() {
  const rows = parseCSV(readFileSync("data/intl-results/results.csv", "utf8"));
  const h = rows[0]; const ix = (n) => h.indexOf(n);
  const [iD, iH, iA, iHS, iAS, iN] = ["date", "home_team", "away_team", "home_score", "away_score", "neutral"].map(ix);
  const d = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const hs = Number(r[iHS]), as = Number(r[iAS]);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    d.push({ date: r[iD], home: r[iH], away: r[iA], hs, as, neutral: r[iN] === "TRUE" });
  }
  return d.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// 一场:给 we + λtot + γ → WLD 概率 + 精确比分概率
function predict(we, lamTot, gamma) {
  const w = Math.min(0.985, Math.max(0.015, we));
  let lh = lamTot * w, la = lamTot * (1 - w);
  if (gamma !== 0) {
    const dlt = (Math.log(lh) - Math.log(la)) / 2;
    lh = Math.exp(Math.log(lh) - gamma * dlt);
    la = Math.exp(Math.log(la) + gamma * dlt);
  }
  const ph = poisPmf(lh), pa = poisPmf(la);
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const p = ph[i] * pa[j];
    if (i > j) home += p; else if (i === j) draw += p; else away += p;
  }
  return { home, draw, away, ph, pa };
}

function main() {
  const data = load();
  const K = 40, BURNIN = 256;
  const CUT = "2008-01-01"; // train: burnin..CUT ; holdout: >=CUT
  const GAMMAS = [0, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30];
  const elo = {}; const getElo = (t) => (elo[t] ?? 1500);
  // leak-safe running 总进球均值
  let gSum = 0, gN = 0;

  const acc = {}; // gamma -> {train:{wld,sc,n}, hold:{wld,sc,n}}
  for (const g of GAMMAS) acc[g] = { train: { wld: 0, sc: 0, n: 0 }, hold: { wld: 0, sc: 0, n: 0 } };

  for (let i = 0; i < data.length; i++) {
    const m = data[i];
    const haB = m.neutral ? 0 : 100;
    const exp = eloExpectation(getElo(m.home), getElo(m.away), haB);
    const we = exp ? exp.homeWinExpectancy : 0.5;
    const lamTot = gN >= 50 ? gSum / gN : 2.7;
    const actual = oc(m.hs, m.as);
    const hi = Math.min(MAXG, m.hs), ai = Math.min(MAXG, m.as);

    if (i >= BURNIN) {
      const seg = m.date >= CUT ? "hold" : "train";
      for (const g of GAMMAS) {
        const pr = predict(we, lamTot, g);
        const a = acc[g][seg]; a.n++;
        a.wld += ll(pr[actual]);
        a.sc += ll(pr.ph[hi] * pr.pa[ai]);
      }
    }
    // 更新(评估后,不泄漏)
    gSum += m.hs + m.as; gN++;
    const eh = getElo(m.home), ea = getElo(m.away);
    const wexp = 1 / (1 + 10 ** ((ea - eh + haB) / 400));
    const sc = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
    elo[m.home] = eh + K * (sc - wexp);
    elo[m.away] = ea + K * ((1 - sc) - (1 - wexp));
  }

  console.log("══════ Rue-Salvesen γ 进球收缩回测(49k 国际赛,train<2008 / holdout≥2008)══════\n");
  console.log("  γ      train-WLD train-比分 train-合计 | hold-WLD  hold-比分");
  // train 选 γ:用组合目标(WLD + 比分),WLD 为主但不让比分崩
  let bestG = 0, bestTrainComb = Infinity;
  for (const g of GAMMAS) {
    const t = acc[g].train, h = acc[g].hold;
    const comb = t.wld / t.n + t.sc / t.n;
    if (comb < bestTrainComb) { bestTrainComb = comb; bestG = g; }
    console.log(`  ${String(g).padEnd(6)} ${(t.wld / t.n).toFixed(4)}   ${(t.sc / t.n).toFixed(4)}   ${comb.toFixed(4)}  | ${(h.wld / h.n).toFixed(4)}    ${(h.sc / h.n).toFixed(4)}`);
  }
  const h0 = acc[0].hold, hb = acc[bestG].hold;
  const dWld = hb.wld / hb.n - h0.wld / h0.n;
  const dSc = hb.sc / hb.n - h0.sc / h0.n;
  console.log(`\n  train 组合最优 γ=${bestG}(纯早期选,不看 holdout)`);
  console.log(`  holdout 该 γ vs γ=0: WLD ${dWld >= 0 ? "+" : ""}${dWld.toFixed(4)} | 比分 ${dSc >= 0 ? "+" : ""}${dSc.toFixed(4)} | 合计 ${(dWld + dSc >= 0 ? "+" : "") + (dWld + dSc).toFixed(4)}`);
  const wldGood = dWld < -0.002, combGood = dWld + dSc < -0.002;
  console.log(`\n  裁决:${bestG === 0 ? "❌ train 最优即 γ=0,Rue-Salvesen 无用,维持线性拆分" :
    wldGood && combGood ? `✅ γ=${bestG} 在 holdout 同时降 WLD(${(-dWld).toFixed(4)})与合计 LL,接进生产 sampleScoreline 拆分` :
    combGood ? `✅ γ=${bestG} holdout 合计 LL 降 ${(-(dWld + dSc)).toFixed(4)},接(WLD 为主已改善)` :
    wldGood ? `⚖️ γ=${bestG} 仅 WLD 改善、比分略升,WLD 为主可接` :
    `❌ holdout 增益在噪声内或为负,维持线性拆分不接`}`);
  console.log("  诚实:γ 只改善比分/进球分布与让球,不破国际赛胜平负命中天花板;train/holdout 时间切分防过拟合。");
}
main();
