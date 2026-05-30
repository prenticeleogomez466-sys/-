/**
 * Dixon-Coles rho(低分校正)· walk-forward 调参回测(2026-05-31 学习轮 9)
 * ─────────────────────────────────────────────────────────────────────────
 * 目的:DC 的 rho(τ 修正:抬 0-0/1-1、压 1-0/0-1,纠泊松对平局的低估)现**硬编码 -0.08**。
 *       学界建议 MLE 估计、典型 -0.03~-0.15。本回测网格搜 rho → 样本外 WLD Brier/LogLoss
 *       + **平局校准**(预测平局概率 vs 实际平局率;平局是已知短板)。-0.08 近最优则诚实不改。
 *
 * 高效:rho 不影响 attack/defense 拟合,只改 scoreMatrix 的 tau → 每月块只 fit 一次,
 *       对每个候选 rho 覆盖 fitted.rho 再预测。生产 opts(decayDays 180 + shrinkageK 2)。
 *
 * 用法:node scripts/run-rho-tune-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const RHOS = [-0.02, -0.05, -0.08, -0.11, -0.14, -0.18];
const EPS = 1e-12;
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const monthKey = (d) => d.slice(0, 7);

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const cut = Math.floor(all.length * 0.7);
const test = all.slice(cut);
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();
console.log(`big-5 ${all.length} 场;测试期 ${test.length} 场(后30%,按月块 fit 一次复用各 rho)\n`);

const acc = {};
for (const rho of RHOS) acc[rho] = { brier: 0, ll: 0, n: 0, hit: 0, drawPredSum: 0, drawActual: 0 };

for (const mk of months) {
  const monthMatches = test.filter((m) => monthKey(m.date) === mk);
  const monthStart = monthMatches[0].date;
  const history = all.filter((m) => m.date < monthStart);
  if (history.length < 200) continue;
  const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: monthStart, shrinkageK: 2 });
  if (!fitted?.usable) continue;
  for (const rho of RHOS) {
    fitted.rho = rho;
    for (const m of monthMatches) {
      const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away })?.probabilities;
      if (!p || !Number.isFinite(p.home)) continue;
      const y = outcome(m);
      const a = acc[rho];
      a.brier += (p.home - (y === "home")) ** 2 + (p.draw - (y === "draw")) ** 2 + (p.away - (y === "away")) ** 2;
      a.ll += -Math.log(Math.max(EPS, p[y]));
      a.n++;
      const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
      if (pick === y) a.hit++;
      a.drawPredSum += p.draw;
      if (y === "draw") a.drawActual++;
    }
  }
}

console.log("  rho   | Brier  | LogLoss | 命中率 | 预测平局均概 | 实际平局率 | 平局校准gap");
const rows = RHOS.map((rho) => {
  const a = acc[rho];
  return { rho, brier: a.brier / a.n, ll: a.ll / a.n, acc: a.hit / a.n, drawPred: a.drawPredSum / a.n, drawAct: a.drawActual / a.n, n: a.n };
});
for (const r of rows) {
  const star = r.rho === -0.08 ? " ←现默认" : "";
  const gap = (r.drawPred - r.drawAct) * 100;
  console.log(`  ${r.rho.toFixed(2)} | ${r.brier.toFixed(4)} | ${r.ll.toFixed(4)} | ${(r.acc * 100).toFixed(1)}% | ${(r.drawPred * 100).toFixed(1)}%       | ${(r.drawAct * 100).toFixed(1)}%     | ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp${star}`);
}
const bestLL = [...rows].sort((a, b) => a.ll - b.ll)[0];
const cur = rows.find((r) => r.rho === -0.08);
const bestCal = [...rows].sort((a, b) => Math.abs(a.drawPred - a.drawAct) - Math.abs(b.drawPred - b.drawAct))[0];
console.log(`\n最优LogLoss:rho=${bestLL.rho}(${bestLL.ll.toFixed(4)} vs 现默认 ${cur.ll.toFixed(4)},差 ${(((cur.ll - bestLL.ll) / cur.ll) * 100).toFixed(2)}%)`);
console.log(`平局校准最佳:rho=${bestCal.rho}(gap ${((bestCal.drawPred - bestCal.drawAct) * 100).toFixed(1)}pp)`);
const gainLL = ((cur.ll - bestLL.ll) / cur.ll) * 100;
console.log(`\n诚实结论:${Math.abs(gainLL) < 0.3 && Math.abs(bestLL.rho - (-0.08)) <= 0.03 ? "-0.08 已近最优(LogLoss 差<0.3%),不强改;" : `rho=${bestLL.rho} 较优,可考虑调默认;`}注意 rho 只动 4 个低分格、对 WLD 影响小,主看平局校准 gap。`);
