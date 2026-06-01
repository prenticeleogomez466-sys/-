#!/usr/bin/env node
/**
 * 世界杯比分命中率实测(轮25,leak-safe)。能力地图写"比分物理上限12-15%"但没世界杯实测过,补上。
 * 自训练 Elo → we 分摊 λ → 泊松比分矩阵 top1/top3 → 对比实际比分。
 * 诚实:中立对称 λ(无球队具体进攻数据,只 Elo 强弱)→ 这是纯 Elo-Poisson 比分【下限】参考;
 *   生产路径用 DC-τ + 真实球队系数会更高。遵 feedback-no-fabrication。
 */
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { eloExpectation } from "../src/world-cup-priors.js";

const fact = (n) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / fact(k);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

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

function topScores(lh, la, max = 6) {
  const cells = [];
  for (let i = 0; i <= max; i++) for (let j = 0; j <= max; j++) cells.push({ i, j, p: pois(i, lh) * pois(j, la) });
  cells.sort((a, b) => b.p - a.p);
  return cells;
}

function main() {
  const rows = collect();
  const K = 40, BURNIN = 128;
  const elo = {}; const getElo = (t) => (elo[t] ?? 1500);
  let sumTot = 0, cnt = 0, n = 0, hit1 = 0, hit3 = 0;

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const eh = getElo(m.home), ea = getElo(m.away);
    const we = eloExpectation(eh, ea, 0).homeWinExpectancy;
    const lamTot = cnt >= 20 ? sumTot / cnt : 2.45;
    const lamH = lamTot * we, lamA = lamTot * (1 - we);
    if (i >= BURNIN) {
      const top = topScores(lamH, lamA);
      n++;
      if (top[0].i === m.hg && top[0].j === m.ag) hit1++;
      if (top.slice(0, 3).some((c) => c.i === m.hg && c.j === m.ag)) hit3++;
    }
    const sH = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    elo[m.home] = eh + K * (sH - we); elo[m.away] = ea + K * ((1 - sH) - (1 - we));
    sumTot += m.tot; cnt++;
  }
  const pct = (x) => (x * 100).toFixed(1) + "%";
  console.log("=== 世界杯比分命中率实测(Elo-Poisson,leak-safe,n=" + n + ")===");
  console.log(`比分 Top1 命中: ${pct(hit1 / n)}`);
  console.log(`比分 Top3 命中: ${pct(hit3 / n)}`);
  console.log("");
  console.log("对照:能力地图'比分物理上限 12-15%'。本数是【纯 Elo-Poisson 中立对称 λ 下限】(无球队具体进攻数据);");
  console.log("生产用 DC-τ + 真实球队 attack/defense 系数会更高。比分本就高方差、Top1 难,Top3 是更现实的展示口径。");
}

main();
