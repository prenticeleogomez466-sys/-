#!/usr/bin/env node
/**
 * 市场 λ 拆分回测 — expg_from_probabilities 的真正增量:用 1X2 赔率推 λ 的【主客拆分】。
 *
 * 生产现状:总进球 λ 已从大小球盘口推(lambdaTotalFromMarket,已验 +0.84pp);
 *   但比分 λ 的【主客拆分(supremacy)】来自模型(DC/Elo),非直接来自 1X2 赔率。
 * 检验:总量固定(市场大小球 λ),只比拆分——
 *   A 模型拆分:Elo we 拆(+Rue-Salvesen);
 *   B 市场拆分(expg):解 supremacy 使 Poisson WLD 贴合 Shin 去vig 的 1X2 → 用市场 supremacy 拆。
 *   两法都 NB+τ 比分矩阵,评精确比分 + WLD log-loss(holdout)。B 显著胜才接,否则 SKIP。
 * 数据:football-data 大联赛(AvgH/D/A 1X2 + Avg>2.5/<2.5 大小球 + FTHG/FTAG)。
 *
 * 用法: node scripts/run-market-lambda-split-backtest.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { shinDevig } from "../src/market-devig.js";

const EPS = 1e-9, MAXG = 12, RUE = 0.15, NB = 8, RHO = -0.08;
const ll = (p) => -Math.log(Math.max(p, EPS));
const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");
const lgC = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) { if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z); z -= 1; let x = lgC[0]; for (let i = 1; i < 9; i++) x += lgC[i] / (z + i); const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x); }
function nbPmf(mu, r) { const o = []; const lr = Math.log(r / (r + mu)), lm = Math.log(mu / (r + mu)); for (let k = 0; k <= MAXG; k++) o.push(Math.exp(lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * lr + k * lm)); return o; }
const tau = (h, a, lh, la) => h === 0 && a === 0 ? 1 - lh * la * RHO : h === 0 && a === 1 ? 1 + lh * RHO : h === 1 && a === 0 ? 1 + la * RHO : h === 1 && a === 1 ? 1 - RHO : 1;
function matrixOf(lh, la) {
  const ph = nbPmf(lh, NB), pa = nbPmf(la, NB); const M = []; let tot = 0;
  for (let i = 0; i <= MAXG; i++) { M[i] = []; for (let j = 0; j <= MAXG; j++) { const p = ph[i] * pa[j] * tau(i, j, lh, la); M[i][j] = p; tot += p; } }
  let home = 0, draw = 0, away = 0; for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) { M[i][j] /= tot; if (i > j) home += M[i][j]; else if (i === j) draw += M[i][j]; else away += M[i][j]; }
  return { home, draw, away, M };
}
// 从 P(over2.5) 解市场总进球 λtot(独立泊松和的尾)
function totalFromOver(pOver) {
  const pUnder3 = (lt) => { let p = Math.exp(-lt), s = p; for (let k = 1; k <= 2; k++) { p = p * lt / k; s += p; } return 1 - s; };
  let lo = 0.5, hi = 6; for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (pUnder3(m) < pOver) lo = m; else hi = m; } return (lo + hi) / 2;
}
// 解 supremacy s 使 Poisson(λh)/Poisson(λa) 的主胜概率≈目标(λh+λa=λtot)
function splitToMarket(lamTot, pHomeTarget) {
  const homeProbOf = (s) => { const lh = (lamTot + s) / 2, la = (lamTot - s) / 2; if (lh <= 0 || la <= 0) return s > 0 ? 1 : 0; const ph = []; let p = Math.exp(-lh); for (let k = 0; k <= MAXG; k++) { ph.push(p); p = p * lh / (k + 1); } const pa = []; p = Math.exp(-la); for (let k = 0; k <= MAXG; k++) { pa.push(p); p = p * la / (k + 1); } let hw = 0; for (let i = 0; i <= MAXG; i++) for (let j = 0; j < i; j++) hw += ph[i] * pa[j]; return hw; };
  let lo = -lamTot + 0.01, hi = lamTot - 0.01;
  for (let it = 0; it < 50; it++) { const m = (lo + hi) / 2; if (homeProbOf(m) < pHomeTarget) lo = m; else hi = m; }
  const s = (lo + hi) / 2; return [(lamTot + s) / 2, (lamTot - s) / 2];
}
function rueSplit(lh, la) { const d = (Math.log(Math.max(lh, .05)) - Math.log(Math.max(la, .05))) / 2; return [Math.exp(Math.log(Math.max(lh, .05)) - RUE * d), Math.exp(Math.log(Math.max(la, .05)) + RUE * d)]; }

function parseCSV(t) { const R = []; for (const l of t.split(/\r?\n/)) { if (!l) continue; const c = []; let s = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { s += '"'; i++; } else q = false; } else s += ch; } else if (ch === '"') q = true; else if (ch === ",") { c.push(s); s = ""; } else s += ch; } c.push(s); R.push(c); } return R; }

function parseDate(s) { // dd/mm/yy 或 dd/mm/yyyy → yyyy-mm-dd
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s || ""); if (!m) return "";
  let y = m[3]; if (y.length === 2) y = (+y > 50 ? "19" : "20") + y; return `${y}-${m[2]}-${m[1]}`;
}
function main() {
  const files = readdirSync("data/footballdata").filter((f) => f.endsWith(".csv"));
  // 按联赛(文件前缀)分组,自训练 Elo;每场记录赛前 Elo we(模型 supremacy)
  const byLeague = {};
  for (const f of files) {
    const lg = f.split("_")[0];
    const R = parseCSV(readFileSync(`data/footballdata/${f}`, "utf8")); const h = R[0]; const ix = (n) => h.indexOf(n);
    const c = { D: ix("Date"), HT: ix("HomeTeam"), AT: ix("AwayTeam"), FTHG: ix("FTHG"), FTAG: ix("FTAG"), AH: ix("AvgH"), AD: ix("AvgD"), AA: ix("AvgA"), OV: ix("Avg>2.5"), UN: ix("Avg<2.5") };
    for (let i = 1; i < R.length; i++) { const r = R[i]; const hg = +r[c.FTHG], ag = +r[c.FTAG], ah = +r[c.AH], ad = +r[c.AD], aa = +r[c.AA], ov = +r[c.OV], un = +r[c.UN];
      if (![hg, ag, ah, ad, aa, ov, un].every(Number.isFinite) || ah <= 1 || ov <= 1) continue;
      (byLeague[lg] ||= []).push({ date: parseDate(r[c.D]), ht: r[c.HT], at: r[c.AT], hg, ag, oddH: ah, oddD: ad, oddA: aa, ov, un }); }
  }
  const S = { A: { sc: 0, wld: 0, n: 0 }, B: { sc: 0, wld: 0, n: 0 }, C: { sc: 0, wld: 0, n: 0 }, D: { sc: 0, wld: 0, n: 0 } };
  const K = 30, HA = 60; // 俱乐部主场优势 ~60 Elo
  for (const lg of Object.keys(byLeague)) {
    const matches = byLeague[lg].sort((a, b) => (a.date < b.date ? -1 : 1));
    const elo = {}; const ge = (t) => (elo[t] ?? 1500); let seen = 0;
    for (const m of matches) {
      const pOver = (() => { const io = 1 / m.ov, iu = 1 / m.un; return io / (io + iu); })();
      const lamTot = totalFromOver(pOver);
      const mkt = shinDevig({ home: m.oddH, draw: m.oddD, away: m.oddA });
      // A:真自训练 Elo we 拆分(模型 supremacy,独立于本场赔率)
      const we = 1 / (1 + 10 ** ((ge(m.at) - ge(m.ht) - HA) / 400));
      const [aRh, aRa] = rueSplit(lamTot * we, lamTot * (1 - we));
      // B:市场 1X2 全量拆分(expg)
      const [bh, ba] = splitToMarket(lamTot, mkt.home);
      const [bRh, bRa] = rueSplit(bh, ba);
      // C:按【融合后 WLD】(0.5 Elo + 0.5 市场,拟生产概率融合)拆分=拟接入方案
      const blendHome = 0.5 * we + 0.5 * mkt.home; // 近似融合主胜概率
      const blendAway = 0.5 * (1 - we) + 0.5 * mkt.away;
      const [ch, ca] = splitToMarket(lamTot, blendHome);  // C:精确反演匹配融合主胜
      const [cRh, cRa] = rueSplit(ch, ca);
      // D:生产现行线性近似 homeShare=0.5+edge*0.75(edge=融合主胜−融合客胜)
      const edge = blendHome - blendAway; const hShare = Math.min(0.75, Math.max(0.25, 0.5 + edge * 0.75));
      const [dRh, dRa] = rueSplit(lamTot * hShare, lamTot * (1 - hShare));
      const actual = oc(m.hg, m.ag); const hi = Math.min(MAXG, m.hg), ai = Math.min(MAXG, m.ag);
      if (seen >= 200) { // burn-in 让 Elo 收敛
        const MA = matrixOf(aRh, aRa), MB = matrixOf(bRh, bRa), MC = matrixOf(cRh, cRa), MD = matrixOf(dRh, dRa);
        S.A.n++; S.A.wld += ll(MA[actual]); S.A.sc += ll(MA.M[hi][ai]);
        S.B.n++; S.B.wld += ll(MB[actual]); S.B.sc += ll(MB.M[hi][ai]);
        S.C.n++; S.C.wld += ll(MC[actual]); S.C.sc += ll(MC.M[hi][ai]);
        S.D.n++; S.D.wld += ll(MD[actual]); S.D.sc += ll(MD.M[hi][ai]);
      }
      // 更新 Elo
      const sc = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      elo[m.ht] = ge(m.ht) + K * (sc - we); elo[m.at] = ge(m.at) + K * ((1 - sc) - (1 - we)); seen++;
    }
  }
  const f = (s) => `比分LL ${(s.sc / s.n).toFixed(4)}  WLD-LL ${(s.wld / s.n).toFixed(4)}`;
  console.log(`══════ 市场 λ 拆分回测(${S.A.n} 场大联赛,真自训练 Elo;总量都用市场大小球 λ)══════\n`);
  console.log(`  A 纯模型拆分(自训练 Elo)        ${f(S.A)}`);
  console.log(`  B 市场1X2全量拆分(expg)        ${f(S.B)}`);
  console.log(`  C 融合WLD精确反演拆分           ${f(S.C)}  ← expg 精确反演`);
  console.log(`  D 生产线性近似(0.5+edge×0.75)  ${f(S.D)}  ← 生产【已在用】`);
  const dCD_sc = S.C.sc / S.C.n - S.D.sc / S.D.n, dCD_w = S.C.wld / S.C.n - S.D.wld / S.D.n;
  console.log(`\n  C−D(精确反演 vs 生产线性近似,真正增量): 比分 ${dCD_sc >= 0 ? "+" : ""}${dCD_sc.toFixed(4)} | WLD ${dCD_w >= 0 ? "+" : ""}${dCD_w.toFixed(4)}`);
  console.log(`\n  裁决:${(dCD_sc < -0.003 || dCD_w < -0.003) ? "✅ 精确反演胜线性近似,值得把生产 homeShare 换成精确反演" : "❌ 生产线性近似(0.5+edge×0.75)已≈精确反演→expg 已实质在生产中,无增量,SKIP"}`);
  console.log("  诚实:生产 estimateGoalLambdas 早已用融合WLD拆分比分λ(线性近似)=expg 本质已在;本测只问'精确反演'比'线性近似'强否。不破命中天花板。");
}
main();
