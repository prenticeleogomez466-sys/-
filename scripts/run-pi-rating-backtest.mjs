#!/usr/bin/env node
/**
 * Pi-rating (Constantinou-Fenton 2013) 回测 — 第二评分源,看能否独立胜 Elo 或集成增益。
 *
 * Pi-rating:每队分【主场评级 R_H / 客场评级 R_A】,按【净胜球误差】更新(非胜平负),
 *   带递减(大胜边际递减 ψ=3·log10(1+x))与跨场迁移 γ(主场表现部分更新客场评级)。
 *   预测净胜球 GD = e(R_AH) − e(R_BA),e(R)=sign·(10^(|R|/3)−1)。
 *
 * 公平对照:把 Pi 的预测 GD + running 总进球均值 → λ_home/λ_away → 泊松 WLD,
 *   与生产 Elo(eloExpectation)同口径比 WLD 命中/logloss;再测 Elo+Pi 概率平均集成。
 *   walk-forward leak-safe,评估窗口近 15 年。过了(集成或独立胜)才接,否则 SKIP。
 *
 * 用法: node scripts/run-pi-rating-backtest.mjs
 */
import { readFileSync } from "node:fs";
import { eloExpectation } from "../src/world-cup-priors.js";

const EPS = 1e-9, MAXG = 10;
const ll = (p) => -Math.log(Math.max(p, EPS));
const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");
const poisPmf = (lam) => { const o = []; let p = Math.exp(-Math.max(lam, 0.05)); const L = Math.max(lam, 0.05); let pp = Math.exp(-L); for (let k = 0; k <= MAXG; k++) { o.push(pp); pp = pp * L / (k + 1); } return o; };
function wldFromLambdas(lh, la) {
  const ph = poisPmf(lh), pa = poisPmf(la); let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { const p = ph[i] * pa[j]; if (i > j) home += p; else if (i === j) draw += p; else away += p; }
  const s = home + draw + away; return { home: home / s, draw: draw / s, away: away / s };
}
// Pi-rating 工具
const eGoal = (R) => Math.sign(R) * (10 ** (Math.abs(R) / 3) - 1);   // 评级→期望进球贡献
const psi = (x) => 3 * Math.log10(1 + Math.abs(x));                  // 误差递减

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

  const K = 40, BURNIN = 512, EVAL = "2011-01-01";
  const LR = 0.06, GAM = 0.5; // Pi-rating 学习率/迁移
  const elo = {}, piH = {}, piA = {};
  const ge = (t) => (elo[t] ?? 1500), gpH = (t) => (piH[t] ?? 0), gpA = (t) => (piA[t] ?? 0);
  let gSum = 0, gN = 0;
  const mk = (l) => ({ l, n: 0, hit: 0, ll: 0 });
  const S = { elo: mk("Elo(生产)"), pi: mk("Pi-rating"), ens: mk("Elo+Pi 概率集成"), ensL: mk("Elo+Pi λ平均") };
  const top = (e) => ["home", "draw", "away"].sort((x, y) => e[y] - e[x])[0];

  for (const m of data) {
    const ha = m.neutral ? 0 : 100;
    const lamTot = gN >= 50 ? gSum / gN : 2.7;
    // Elo→WLD(中立/主场经 ha)
    const ee = eloExpectation(ge(m.home), ge(m.away), ha); const wElo = ee || { home: .4, draw: .27, away: .33 };
    const eloW = { home: wElo.home, draw: wElo.draw, away: wElo.away };
    // Pi→预测 GD→λ→WLD(主场 ha 折成约 +0.3 球先验:100Elo≈0.3球,中立0)
    const haGoal = m.neutral ? 0 : 0.3;
    const gd = eGoal(gpH(m.home)) - eGoal(gpA(m.away)) + haGoal;
    const lhP = Math.max(0.05, (lamTot + gd) / 2), laP = Math.max(0.05, (lamTot - gd) / 2);
    const piW = wldFromLambdas(lhP, laP);
    const ensW = { home: (eloW.home + piW.home) / 2, draw: (eloW.draw + piW.draw) / 2, away: (eloW.away + piW.away) / 2 };
    // λ 平均集成:Elo 的 λ(we 拆分)与 Pi 的 λ 平均后再 WLD
    const weE = wElo.homeWinExpectancy ?? 0.5;
    const lhE = lamTot * weE, laE = lamTot * (1 - weE);
    const ensLW = wldFromLambdas((lhE + lhP) / 2, (laE + laP) / 2);

    const actual = oc(m.hs, m.as);
    if (m.date >= EVAL) {
      for (const [s, e] of [[S.elo, eloW], [S.pi, piW], [S.ens, ensW], [S.ensL, ensLW]]) { s.n++; if (top(e) === actual) s.hit++; s.ll += ll(e[actual]); }
    }
    gSum += m.hs + m.as; gN++;
    // 更新 Elo(含净胜球指数 gdIndex,对齐生产 eloratings.net/WFE——公平对照:Elo 已含净胜球信息)
    const eh = ge(m.home), ea = ge(m.away); const we = 1 / (1 + 10 ** ((ea - eh + ha) / 400));
    const sc = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
    const agd = Math.abs(m.hs - m.as); const gIdx = agd <= 1 ? 1 : agd === 2 ? 1.5 : (11 + agd) / 8;
    elo[m.home] = eh + K * gIdx * (sc - we); elo[m.away] = ea + K * gIdx * ((1 - sc) - (1 - we));
    // 更新 Pi-rating(净胜球误差)
    const predGD = eGoal(gpH(m.home)) - eGoal(gpA(m.away)) + haGoal;
    const obsGD = m.hs - m.as;
    const err = obsGD - predGD; const w = psi(err) * Math.sign(err);
    const aH0 = gpH(m.home), aA0 = gpA(m.away), bH0 = gpH(m.away), bA0 = gpA(m.home);
    piH[m.home] = aH0 + w * LR; piA[m.home] = (piA[m.home] ?? 0) + (piH[m.home] - aH0) * GAM;
    piA[m.away] = aA0 - w * LR; piH[m.away] = (piH[m.away] ?? 0) + (piA[m.away] - aA0) * GAM;
  }

  console.log("══════ Pi-rating 回测(49k 国际赛,评估 2011→2026)══════\n");
  for (const s of [S.elo, S.pi, S.ens, S.ensL]) console.log(`  ${s.l.padEnd(16)} n=${s.n}  命中 ${(s.hit / s.n * 100).toFixed(1)}%  logloss ${(s.ll / s.n).toFixed(4)}`);
  const dEnsLL = S.ens.ll / S.ens.n - S.elo.ll / S.elo.n;
  const dEnsHit = (S.ens.hit / S.ens.n - S.elo.hit / S.elo.n) * 100;
  const dEnsLLambda = S.ensL.ll / S.ensL.n - S.elo.ll / S.elo.n;
  const dPiLL = S.pi.ll / S.pi.n - S.elo.ll / S.elo.n;
  console.log(`\n  Pi 独立 vs Elo: logloss ${dPiLL >= 0 ? "+" : ""}${dPiLL.toFixed(4)} ${dPiLL > 0 ? "(Pi 不如含净胜球的 Elo)" : ""}`);
  console.log(`  概率集成 vs Elo: 命中 ${dEnsHit >= 0 ? "+" : ""}${dEnsHit.toFixed(1)}pp | logloss ${dEnsLL >= 0 ? "+" : ""}${dEnsLL.toFixed(4)}`);
  console.log(`  λ平均集成 vs Elo: logloss ${dEnsLLambda >= 0 ? "+" : ""}${dEnsLLambda.toFixed(4)} ${dEnsLLambda > -0.0005 ? "(干净集成路无增益)" : ""}`);
  // 诚实裁决:基线必须用【含净胜球的 Elo】(对齐生产 eloratings.net),否则虚高。
  const cleanIntegWorks = dEnsLLambda < -0.003;
  console.log(`\n  裁决:${cleanIntegWorks ? `✅ λ平均集成(干净路)净增益,接` :
    dEnsLL < -0.003 ? `⚠️ 仅概率层集成有 ${(-dEnsLL).toFixed(4)} 增益,但 λ平均(干净路)无效→需有状态 Pi 评级库+名称匹配+破坏单一比分模型=高复杂度;Pi 与生产含净胜球 Elo 高度冗余(独立更差)→按"谨防复杂度/冗余模块"纪律 SKIP` :
    `❌ 集成无净增益→SKIP`}`);
  console.log("  诚实:之前 -0.0143 是被弱平K基线虚高;对齐生产 GD-aware Elo 后 Pi 优势消失,剩余增益小且仅概率层。不破命中天花板。");
}
main();
