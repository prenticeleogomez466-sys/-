#!/usr/bin/env node
/**
 * Elo 作 Poisson 协变量探索(轮12,吸收轮8学界 Groll 方法)。
 * 纯 Elo(eloExpectation)只能出胜平负;学界主流是把 Elo 喂进 Poisson 算每队进球 λ,从而同时出
 *   比分/大小球/半全场。本脚本 leak-safe 验证:Elo 分摊 λ 的 Poisson 路径,wld 命中是否保持(vs 纯 Elo),
 *   并额外能出 over2.5。方法:自训练 Elo(K=40 中立)→ we=胜率期望;历史均值总进球 λ_tot;
 *   按 we 分摊 λ_home=λ_tot·we、λ_away=λ_tot·(1-we)(近似,诚实标注),泊松九宫格出 wld+over2.5。
 * 遵 feedback-no-fabrication / feedback-hitrate-closed-loop:有净增益才值得接,无则诚实记录。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { eloExpectation } from "../src/world-cup-priors.js";

const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);
function wldFromLambdas(lh, la, max = 8) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) {
    const p = pois(i, lh) * pois(j, la);
    if (i > j) h += p; else if (i === j) d += p; else a += p;
  }
  const s = h + d + a; return { home: h / s, draw: d / s, away: a / s };
}
const pOver = (lt, line = 2.5) => { let c = 0; for (let k = 0; k <= Math.floor(line); k++) c += pois(k, lt); return 1 - c; };

function collect() {
  const rows = [];
  for (const d of listFixtureDates()) {
    const { fixtures } = loadFixtures(d);
    for (const f of fixtures) {
      if (!(f.tags || []).includes("worldcup") || !f.result) continue;
      rows.push({ date: f.date, home: f.homeTeam, away: f.awayTeam, hg: f.result.home, ag: f.result.away, tot: f.result.home + f.result.away });
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function main() {
  const rows = collect();
  const K = 40, BURNIN = 128;
  const elo = {}; const getElo = (t) => (elo[t] ?? 1500);
  const oc = (h, a) => (h > a ? "home" : h === a ? "draw" : "away");
  let sumTot = 0, cnt = 0;
  let n = 0, hitEP = 0, hitElo = 0, brierOver = 0;

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const exp = eloExpectation(eh, ea, 0);
    const we = exp.homeWinExpectancy;
    const lamTot = cnt >= 20 ? sumTot / cnt : 2.45;
    const lamH = lamTot * we, lamA = lamTot * (1 - we);
    const ep = wldFromLambdas(lamH, lamA);
    const actual = oc(m.hg, m.ag);

    if (i >= BURNIN) {
      n++;
      const pEP = ["home", "draw", "away"].sort((x, y) => ep[y] - ep[x])[0];
      const pElo = ["home", "draw", "away"].sort((x, y) => exp[y] - exp[x])[0];
      if (pEP === actual) hitEP++;
      if (pElo === actual) hitElo++;
      brierOver += (pOver(lamTot) - (m.tot > 2.5 ? 1 : 0)) ** 2;
    }
    // 更新
    const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    elo[m.home] = eh + K * (sH - we);
    elo[m.away] = ea + K * ((1 - sH) - (1 - we));
    sumTot += m.tot; cnt++;
  }

  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log("=== Elo 作 Poisson 协变量探索(leak-safe,自训练 Elo)===");
  console.log(`评估 ${n} 场(前 ${BURNIN} burn-in)`);
  console.log("");
  console.log(`               胜平负命中`);
  console.log(`纯 Elo(wld)    ${pct(hitElo / n)}`);
  console.log(`Elo→Poisson    ${pct(hitEP / n)}  (额外能出 over2.5 Brier=${(brierOver / n).toFixed(4)} / 比分 / 半全场)`);
  console.log("");
  const dpp = (hitEP - hitElo) / n * 100;
  console.log(`wld 命中差(Poisson vs 纯Elo): ${dpp >= 0 ? "+" : ""}${dpp.toFixed(1)}pp`);
  console.log(Math.abs(dpp) < 1.5
    ? "→ wld 命中基本持平(差<1.5pp 噪声内);Elo→Poisson 的真实价值=在保持 wld 的同时【额外提供比分/大小球/半全场】,纯 Elo 给不了。值得作世界杯比分/大小球的 λ 来源(命中率不靠它涨,玩法覆盖靠它全)。"
    : dpp > 0 ? "→ Elo→Poisson 反而 wld 更高,可考虑接入。"
      : "→ Elo→Poisson wld 掉点,比分/大小球用它、wld 仍用纯 Elo 分解。");
  console.log("诚实:按 we 线性分摊 λ 是近似(we 是胜率非进球比);精确应泊松 GLM 拟合 Elo→进球,样本稀疏暂用近似。");
}

main();
