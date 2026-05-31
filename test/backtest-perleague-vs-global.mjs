/**
 * 对决:每联赛"独立全面学习"(fitPerLeague,各联赛单独跑完整 Dixon-Coles,每队攻防全学)
 *       vs 全局一锅炖(fit,所有联赛混拟合,球队系数自动吸收联赛差异)
 * 时序 walk-forward:用 cutoff 前训练,cutoff 后测试(不泄漏)。
 * 指标:胜平负 RPS(越低越好)+ 比分 Poisson LogLoss + 命中率。
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, fitPerLeague, predictFromFitted } from "../src/dixon-coles-engine.js";

const all = collectHistoricalMatches(400).filter(m => m.home && m.away && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.date);
all.sort((a, b) => (a.date < b.date ? -1 : 1));

// 多个 cutoff 滚动,累计测试集(更稳);测试窗=cutoff 后 45 天
const cutoffs = ["2025-09-01", "2025-11-01", "2026-01-01", "2026-03-01"];
const lnFact = (k) => { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; };
const poNLL = (k, lam) => { lam = Math.max(0.05, lam); return -(k * Math.log(lam) - lam - lnFact(k)); };
const outcome = (h, a) => (h > a ? 0 : h === a ? 1 : 2); // 0=主 1=平 2=客
// RPS for 3-outcome ordered [home, draw, away]
function rps(probs, obs) {
  const o = [0, 0, 0]; o[obs] = 1;
  let cumP = 0, cumO = 0, s = 0;
  for (let i = 0; i < 2; i++) { cumP += probs[i]; cumO += o[i]; s += (cumP - cumO) ** 2; }
  return s; // 不除2,相对比较即可(两模型同口径)
}

const acc = { global: { rps: 0, nll: 0, hit: 0, n: 0 }, perLeague: { rps: 0, nll: 0, hit: 0, n: 0 } };

for (const cutoff of cutoffs) {
  const train = all.filter(m => m.date < cutoff);
  const test = all.filter(m => m.date >= cutoff && m.date < nextWeek(cutoff));
  if (train.length < 200 || test.length < 20) continue;

  const gModel = fitFromMatches(train, {});
  const plModel = fitPerLeague(train.map(m => ({ ...m, league: m.league })), {});

  for (const m of test) {
    const fx = { homeTeam: m.home, awayTeam: m.away, competition: m.league };
    const obs = outcome(m.homeGoals, m.awayGoals);
    for (const [name, model] of [["global", gModel], ["perLeague", plModel]]) {
      const r = predictFromFitted(model, fx);
      if (!r?.probabilities) continue;
      const p = [r.probabilities.home, r.probabilities.draw, r.probabilities.away];
      const eg = r.expectedGoals ?? {};
      acc[name].rps += rps(p, obs);
      acc[name].hit += (p.indexOf(Math.max(...p)) === obs ? 1 : 0);
      if (Number.isFinite(eg.home) && Number.isFinite(eg.away))
        acc[name].nll += poNLL(m.homeGoals, eg.home) + poNLL(m.awayGoals, eg.away);
      acc[name].n++;
    }
  }
}

function nextWeek(d) { const dt = new Date(d + "T00:00:00Z"); dt.setUTCDate(dt.getUTCDate() + 45); return dt.toISOString().slice(0, 10); }

for (const name of ["global", "perLeague"]) {
  const a = acc[name];
  console.log(`${name.padEnd(10)} | 测试 ${a.n} 场 | RPS ${(a.rps / a.n).toFixed(4)} | 比分LogLoss ${(a.nll / a.n).toFixed(4)} | 命中 ${(100 * a.hit / a.n).toFixed(2)}%`);
}
const g = acc.global, pl = acc.perLeague;
console.log(`\n分联赛独立 相对 全局:`);
console.log(`  RPS:  ${((pl.rps / pl.n - g.rps / g.n) >= 0 ? "+" : "")}${(pl.rps / pl.n - g.rps / g.n).toFixed(4)}  ${pl.rps / pl.n < g.rps / g.n ? "✅独立更好" : "❌独立没赢"}`);
console.log(`  命中: ${((100 * pl.hit / pl.n) - (100 * g.hit / g.n)).toFixed(2)}pp`);
