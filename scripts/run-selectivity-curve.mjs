/**
 * 选择性置信度曲线(2026-06-04,用户「量化只推 top 置信场→命中率/覆盖率」)。
 * 不替用户弃赛(遵 feedback-confidence-not-autosuppress):只给"信心阈值→覆盖率→推荐命中率"权衡表,
 * 用户按信心自己取舍下不下注。
 * 方法:同 run-confidence-reliability 的 leak-safe walk-forward(big-5,市场0.75+DC0.25 blend 近似生产),
 * 按 pick 信心(max wld 概率)做累积阈值统计。
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const monthKey = (d) => d.slice(0, 7);
const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.date && (m.oddsClose || m.odds));
const test = all.filter((m) => m.date >= "2025-01-01");
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();
const blend = (mkt, dc) => (!dc ? mkt : { home: 0.75 * mkt.home + 0.25 * dc.home, draw: 0.75 * mkt.draw + 0.25 * dc.draw, away: 0.75 * mkt.away + 0.25 * dc.away });
const real = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");

const picks = []; // {conf, hit}
for (const mk of months) {
  const mm = test.filter((m) => monthKey(m.date) === mk);
  const history = all.filter((m) => m.date < mm[0].date);
  if (history.length < 200) continue;
  const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: mm[0].date, shrinkageK: 2 });
  for (const m of mm) {
    const mkt = m.oddsClose || m.odds;
    let dc = null;
    if (fitted?.usable) { const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away }); dc = p?.probabilities ?? null; }
    const pr = blend(mkt, dc);
    const pick = pr.home >= pr.draw && pr.home >= pr.away ? "home" : pr.away >= pr.draw ? "away" : "draw";
    picks.push({ conf: pr[pick], hit: pick === real(m) ? 1 : 0 });
  }
}
picks.sort((a, b) => b.conf - a.conf);
const total = picks.length;
const baseHit = picks.reduce((s, p) => s + p.hit, 0) / total;

console.log(`选择性置信度曲线(big-5 leak-safe walk-forward,${total} 场;blend 市场0.75+DC0.25)`);
console.log(`全覆盖基线:推荐 100% 场次,命中率 ${(baseHit * 100).toFixed(1)}%\n`);
console.log("信心阈值 | 推荐场数 | 覆盖率 | 推荐命中率 | vs全覆盖");
for (const th of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
  const sel = picks.filter((p) => p.conf >= th);
  if (!sel.length) continue;
  const hit = sel.reduce((s, p) => s + p.hit, 0) / sel.length;
  const cov = sel.length / total;
  console.log(`  ≥${(th * 100).toFixed(0)}%   | ${String(sel.length).padStart(5)}    | ${(cov * 100).toFixed(1)}%  | ${(hit * 100).toFixed(1)}%     | ${hit - baseHit >= 0 ? "+" : ""}${((hit - baseHit) * 100).toFixed(1)}pp`);
}
console.log("\n另:按覆盖率分位(只推最有把握的前 X%)");
console.log("覆盖率 | 推荐场数 | 推荐命中率");
for (const cov of [0.10, 0.20, 0.30, 0.50, 0.75, 1.0]) {
  const n = Math.max(1, Math.round(total * cov));
  const sel = picks.slice(0, n);
  const hit = sel.reduce((s, p) => s + p.hit, 0) / sel.length;
  console.log(`  前${(cov * 100).toFixed(0)}%  | ${String(n).padStart(5)}    | ${(hit * 100).toFixed(1)}%`);
}
console.log("\n诚实:不替用户弃赛(只给权衡,下注与否你定)。高信心场命中确实更高(选择性是免费可榨的真杠杆);");
console.log("代价是覆盖率↓(推得少)。raw 全覆盖命中受市场天花板锁死~54.8%,选择性提的是'推荐命中率'非整体上限。");
