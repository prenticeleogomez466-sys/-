/**
 * Dixon-Coles 时间衰减半衰期 · walk-forward 调参回测(2026-05-31 学习轮 6)
 * ─────────────────────────────────────────────────────────────────────────
 * 目的:DC 引擎 fit 现用 decayDays 默认 **180 天**(2^(-Δt/halfLife) 加权)。学界(2025)
 *       建议半衰期应用样本外似然调优而非写死。本回测网格搜半衰期 → 样本外 Brier/LogLoss
 *       最低者,看 180 是否近最优。遵 feedback-hitrate-closed-loop:数据说话、不盲改。
 *
 * 方法(leak-safe walk-forward):
 *   1. football-data big-5 全赛季,按日期升序。
 *   2. 取后 30% 当测试期,按月分块;每月块用**严格早于该月**的历史 fit(防泄漏),预测该月每场。
 *   3. 对每个候选半衰期独立重拟合,累计测试期 WLD Brier + LogLoss(都是越低越好)。
 *
 * 用法:node scripts/run-decay-tune-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const HALF_LIVES = [60, 90, 120, 180, 240, 360, 540]; // 候选半衰期(天)
const EPS = 1e-12;

function outcome(m) {
  return m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw";
}
function monthKey(date) {
  return date.slice(0, 7); // YYYY-MM
}

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const cut = Math.floor(all.length * 0.7);
const trainPool = all.slice(0, cut); // 仅作初始历史下限参照
const testStartDate = all[cut].date;
const test = all.slice(cut);
console.log(`big-5 ${all.length} 场;测试期从 ${testStartDate} 起共 ${test.length} 场(按月块重拟合)\n`);

// 测试期按月分块
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();

const results = [];
for (const halfLife of HALF_LIVES) {
  let brier = 0, logloss = 0, n = 0, hit = 0;
  for (const mk of months) {
    const monthMatches = test.filter((m) => monthKey(m.date) === mk);
    // 该月块的历史 = 严格早于该月第一天的所有场
    const monthStart = monthMatches[0].date;
    const history = all.filter((m) => m.date < monthStart);
    if (history.length < 200) continue;
    const fitted = fitFromMatches(history, { decayDays: halfLife, referenceDate: monthStart });
    if (!fitted?.usable) continue;
    for (const m of monthMatches) {
      const out = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
      const p = out?.probabilities;
      if (!p || !Number.isFinite(p.home)) continue;
      const y = outcome(m);
      const py = Math.max(EPS, p[y]);
      brier += (p.home - (y === "home")) ** 2 + (p.draw - (y === "draw")) ** 2 + (p.away - (y === "away")) ** 2;
      logloss += -Math.log(py);
      const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
      if (pick === y) hit++;
      n++;
    }
  }
  results.push({ halfLife, brier: brier / n, logloss: logloss / n, acc: hit / n, n });
}

results.sort((a, b) => a.logloss - b.logloss);
console.log("半衰期(天) | 样本外 Brier | LogLoss | 命中率 | 场数   (按 LogLoss 升序)");
for (const r of results) {
  const star = r.halfLife === 180 ? " ←现默认" : "";
  console.log(`  ${String(r.halfLife).padStart(4)}      | ${r.brier.toFixed(4)}     | ${r.logloss.toFixed(4)} | ${(r.acc * 100).toFixed(1)}% | ${r.n}${star}`);
}
const best = results[0];
const cur = results.find((r) => r.halfLife === 180);
console.log(`\n最优(LogLoss):${best.halfLife}天 LogLoss ${best.logloss.toFixed(4)} / Brier ${best.brier.toFixed(4)}`);
console.log(`现默认 180天:LogLoss ${cur.logloss.toFixed(4)} / Brier ${cur.brier.toFixed(4)}`);
const dLog = ((cur.logloss - best.logloss) / cur.logloss) * 100;
console.log(`差距:最优比现默认 LogLoss 低 ${dLog.toFixed(2)}% —— ${Math.abs(dLog) < 0.5 ? "差距<0.5%,180天已近最优,不强改(诚实)" : "差距显著,建议调默认半衰期"}`);
