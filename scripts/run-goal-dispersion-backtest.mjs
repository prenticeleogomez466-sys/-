#!/usr/bin/env node
/**
 * 进球离散度建模回测 — 定论 CMP/NB 值不值得做(替"CMP 待评估")。
 *
 * 诊断(49k 国际赛 2000+):进球【过离散】var/mean≈1.46(条件,给定 Elo 推的 λ 后仍>1),
 *   非探子假设的欠离散。过离散的正统模型是【负二项 NB】(CMP 更适合欠离散)。
 * 但过离散可能只是 λ 设定噪声的假象(桶内 λ 异质)。真问题:显式建模离散度能否【预测更准】?
 *
 * 检验:walk-forward 自训练 Elo→we 线性拆 λ(+Rue-Salvesen γ=0.15,对齐生产)→比分矩阵,
 *   对比【独立泊松】vs【负二项 NB(size=r)】的精确比分 + WLD log-loss。
 *   train(<2008)调 r,holdout(≥2008)评估。NB net-positive 才接,否则连同 CMP 一并 SKIP。
 *
 * 用法: node scripts/run-goal-dispersion-backtest.mjs
 */
import { readFileSync } from "node:fs";
import { eloExpectation } from "../src/world-cup-priors.js";

const EPS = 1e-9, MAXG = 12, RUE = 0.15;
const ll = (p) => -Math.log(Math.max(p, EPS));
const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");
const lgamma = (z) => { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
function poisPmf(lam) { const o = []; let p = Math.exp(-lam); for (let k = 0; k <= MAXG; k++) { o.push(p); p = p * lam / (k + 1); } return o; }
// Dixon-Coles τ:只修 (0,0)(0,1)(1,0)(1,1) 四格(对齐生产 dixon-coles-engine)
const RHO = -0.08;
function tau(h, a, lh, la) {
  if (h === 0 && a === 0) return 1 - lh * la * RHO;
  if (h === 0 && a === 1) return 1 + lh * RHO;
  if (h === 1 && a === 0) return 1 + la * RHO;
  if (h === 1 && a === 1) return 1 - RHO;
  return 1;
}
// 负二项:mean=μ, size=r, var=μ+μ²/r。P(k)=Γ(k+r)/(k!Γ(r))·(r/(r+μ))^r·(μ/(r+μ))^k
function nbPmf(mu, r) {
  const o = []; const lr = Math.log(r / (r + mu)), lm = Math.log(mu / (r + mu));
  for (let k = 0; k <= MAXG; k++) o.push(Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * lr + k * lm));
  return o;
}
function splitLam(we, lamTot) {
  let la = lamTot * we, lb = lamTot * (1 - we);
  const d = (Math.log(la) - Math.log(lb)) / 2;
  return [Math.exp(Math.log(la) - RUE * d), Math.exp(Math.log(lb) + RUE * d)];
}
// 建带 τ 的归一比分矩阵,返回 {home,draw,away, M}
function buildMatrix(ph, pa, lh, la, useTau) {
  const M = []; let tot = 0;
  for (let i = 0; i <= MAXG; i++) { M[i] = []; for (let j = 0; j <= MAXG; j++) { const p = ph[i] * pa[j] * (useTau ? tau(i, j, lh, la) : 1); M[i][j] = p; tot += p; } }
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { M[i][j] /= tot; if (i > j) home += M[i][j]; else if (i === j) draw += M[i][j]; else away += M[i][j]; }
  return { home, draw, away, M };
}

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) { if (!line) continue; const c = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { c.push(cur); cur = ""; } else cur += ch; }
    c.push(cur); rows.push(c); }
  return rows;
}

function main() {
  const rows = parseCSV(readFileSync("data/intl-results/results.csv", "utf8"));
  const h = rows[0], ix = (n) => h.indexOf(n);
  const [iD, iH, iA, iHS, iAS, iN] = ["date", "home_team", "away_team", "home_score", "away_score", "neutral"].map(ix);
  const data = [];
  for (let i = 1; i < rows.length; i++) { const r = rows[i]; const hs = +r[iHS], as = +r[iAS];
    if (Number.isFinite(hs) && Number.isFinite(as)) data.push({ date: r[iD], home: r[iH], away: r[iA], hs, as, neutral: r[iN] === "TRUE" }); }
  data.sort((a, b) => (a.date < b.date ? -1 : 1));

  const K = 40, BURNIN = 256, CUT = "2008-01-01";
  const RS = [Infinity, 20, 12, 8, 6, 4, 3]; // size r;Infinity=泊松
  const elo = {}; const ge = (t) => (elo[t] ?? 1500);
  let gSum = 0, gN = 0;
  const acc = {}; for (const r of RS) acc[r] = { train: { wld: 0, sc: 0, n: 0 }, hold: { wld: 0, sc: 0, n: 0 } };

  for (let i = 0; i < data.length; i++) {
    const m = data[i]; const ha = m.neutral ? 0 : 100;
    const exp = eloExpectation(ge(m.home), ge(m.away), ha); const we = exp ? exp.homeWinExpectancy : 0.5;
    const lamTot = gN >= 50 ? gSum / gN : 2.7;
    const [lh, la] = splitLam(Math.min(0.985, Math.max(0.015, we)), lamTot);
    const actual = oc(m.hs, m.as); const hi = Math.min(MAXG, m.hs), ai = Math.min(MAXG, m.as);
    if (i >= BURNIN) {
      const seg = m.date >= CUT ? "hold" : "train";
      for (const r of RS) {
        const ph = r === Infinity ? poisPmf(lh) : nbPmf(lh, r);
        const pa = r === Infinity ? poisPmf(la) : nbPmf(la, r);
        const w = buildMatrix(ph, pa, lh, la, true); // 全部带 τ:对照"泊松+τ vs NB+τ"
        const a = acc[r][seg]; a.n++;
        a.wld += ll(w[actual]); a.sc += ll(w.M[hi][ai]);
      }
    }
    gSum += m.hs + m.as; gN++;
    const eh = ge(m.home), ea = ge(m.away); const wexp = 1 / (1 + 10 ** ((ea - eh + ha) / 400));
    const sc = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
    elo[m.home] = eh + K * (sc - wexp); elo[m.away] = ea + K * ((1 - sc) - (1 - wexp));
  }

  console.log("══════ 进球离散度建模回测(49k 国际赛;泊松+τ vs NB+τ,r=∞ 即泊松,均含 Dixon-Coles τ)══════\n");
  console.log("  r        train-WLD train-比分 train-合计 | hold-WLD  hold-比分");
  let bestR = Infinity, bestTrain = Infinity;
  for (const r of RS) { const t = acc[r].train; const comb = t.wld / t.n + t.sc / t.n; if (comb < bestTrain) { bestTrain = comb; bestR = r; } }
  for (const r of RS) { const t = acc[r].train, hd = acc[r].hold; const comb = t.wld / t.n + t.sc / t.n;
    console.log(`  ${String(r === Infinity ? "∞(泊松)" : r).padEnd(8)} ${(t.wld / t.n).toFixed(4)}   ${(t.sc / t.n).toFixed(4)}   ${comb.toFixed(4)}  | ${(hd.wld / hd.n).toFixed(4)}    ${(hd.sc / hd.n).toFixed(4)}`); }
  const h0 = acc[Infinity].hold, hb = acc[bestR].hold;
  const dSc = hb.sc / hb.n - h0.sc / h0.n, dWld = hb.wld / hb.n - h0.wld / h0.n;
  console.log(`\n  train 组合最优 r=${bestR === Infinity ? "∞(泊松)" : bestR}`);
  console.log(`  holdout 该 r vs 泊松: 比分 ${dSc >= 0 ? "+" : ""}${dSc.toFixed(4)} | WLD ${dWld >= 0 ? "+" : ""}${dWld.toFixed(4)}`);
  console.log(`\n  裁决:${bestR === Infinity ? "❌ train 最优即泊松,显式离散度建模无用→CMP/NB 一并 SKIP" :
    dSc < -0.002 ? `✅ NB(r=${bestR}) holdout 降比分 LL ${(-dSc).toFixed(4)},接进比分矩阵` :
    `❌ holdout 比分增益噪声内/为负(${dSc.toFixed(4)})→过离散多为 λ 异质假象,CMP/NB SKIP`}`);
  console.log("  诚实:探子假设'欠离散'对国际赛为假(实为过离散);且过离散多由 λ 设定噪声致,显式离散参数未必预测更准。");
}
main();
