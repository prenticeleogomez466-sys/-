/**
 * Dixon-Coles 主场优势 homeAdvantage · walk-forward 调参回测(2026-05-31 学习轮 10)
 * ─────────────────────────────────────────────────────────────────────────
 * 动机:homeAdvantage(home λ 乘子)现**硬编码 1.28**。2025 实证主场优势持续下降
 *       (英超主场 PPG 0.59→0.18 两季,~0.25 球)→ 固定 1.28 可能已偏高。
 *       网格搜 → 样本外 Brier/LogLoss + 主胜校准。像轮8收缩一样可能真改善;1.28 仍最优则诚实记录。
 *
 * 方法:homeAdvantage 参与 fit(影响 attack/defense 估计)→ 必须按候选重拟合。
 *       big-5 后30%测试期按月块,每候选独立重拟合(生产 opts decayDays180+shrinkageK2);
 *       算样本外 WLD Brier/LogLoss + 主胜校准(预测主胜均概 vs 实际主胜率)。
 *
 * 用法:node scripts/run-homeadv-tune-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const HAS = [1.20, 1.22, 1.24, 1.26, 1.28];
const EPS = 1e-12;
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const monthKey = (d) => d.slice(0, 7);

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const cut = Math.floor(all.length * 0.7);
const test = all.slice(cut);
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();
console.log(`big-5 ${all.length} 场;测试期 ${test.length} 场(后30%,按月块重拟合每候选)\n`);

function scoreForHA(ha) {
  let brier = 0, ll = 0, n = 0, hit = 0, homePredSum = 0, homeActual = 0;
  for (const mk of months) {
    const monthMatches = test.filter((m) => monthKey(m.date) === mk);
    const monthStart = monthMatches[0].date;
    const history = all.filter((m) => m.date < monthStart);
    if (history.length < 200) continue;
    const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: monthStart, shrinkageK: 2, homeAdvantage: ha });
    if (!fitted?.usable) continue;
    for (const m of monthMatches) {
      const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away })?.probabilities;
      if (!p || !Number.isFinite(p.home)) continue;
      const y = outcome(m);
      brier += (p.home - (y === "home")) ** 2 + (p.draw - (y === "draw")) ** 2 + (p.away - (y === "away")) ** 2;
      ll += -Math.log(Math.max(EPS, p[y]));
      n++;
      const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
      if (pick === y) hit++;
      homePredSum += p.home;
      if (y === "home") homeActual++;
    }
  }
  return { ha, brier: brier / n, ll: ll / n, acc: hit / n, homePred: homePredSum / n, homeAct: homeActual / n, n };
}

const rows = HAS.map(scoreForHA);
console.log("homeAdv | Brier  | LogLoss | 命中率 | 预测主胜均概 | 实际主胜率 | 主胜校准gap");
for (const r of rows) {
  const star = r.ha === 1.28 ? " ←现默认" : "";
  const gap = (r.homePred - r.homeAct) * 100;
  console.log(`  ${r.ha.toFixed(2)}  | ${r.brier.toFixed(4)} | ${r.ll.toFixed(4)} | ${(r.acc * 100).toFixed(1)}% | ${(r.homePred * 100).toFixed(1)}%       | ${(r.homeAct * 100).toFixed(1)}%     | ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp${star}`);
}
const bestLL = [...rows].sort((a, b) => a.ll - b.ll)[0];
const cur = rows.find((r) => r.ha === 1.28);
const bestCal = [...rows].sort((a, b) => Math.abs(a.homePred - a.homeAct) - Math.abs(b.homePred - b.homeAct))[0];
console.log(`\n最优LogLoss:homeAdv=${bestLL.ha}(${bestLL.ll.toFixed(4)} vs 现默认 ${cur.ll.toFixed(4)},差 ${(((cur.ll - bestLL.ll) / cur.ll) * 100).toFixed(2)}%)`);
console.log(`主胜校准最佳:homeAdv=${bestCal.ha}(gap ${((bestCal.homePred - bestCal.homeAct) * 100).toFixed(1)}pp)`);
const gainLL = ((cur.ll - bestLL.ll) / cur.ll) * 100;
const accBest = rows.find((r) => r.ha === bestLL.ha).acc;
const enable = bestLL.ha !== 1.28 && gainLL > 0.3 && accBest >= cur.acc;
console.log(`\n诚实结论:${enable ? `homeAdv=${bestLL.ha} 显著优于 1.28(LogLoss +${gainLL.toFixed(2)}%、命中不劣)→ 建议改默认;` : `1.28 仍近最优(最优${bestLL.ha},LogLoss 差 ${gainLL.toFixed(2)}%<0.3% 或命中劣化)→ 不强改;`}主胜校准 gap 见上(正=高估主胜,印证主场优势下降则现默认应略偏高)。`);
