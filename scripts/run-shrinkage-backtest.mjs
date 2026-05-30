/**
 * 小样本球队评级 · 经验贝叶斯收缩调参回测(2026-05-31 学习轮 8)
 * ─────────────────────────────────────────────────────────────────────────
 * 目的:DC fit() 对出场少的队(升班马/赛季初)attack/defense 无收缩 → 噪声大易过拟合。
 *       新增 opts.shrinkageK(向均值1.0收缩,shrink=n/(n+K),K=0关闭)。本回测网格搜 K →
 *       样本外 Brier/LogLoss 最低者,**尤其看赛季初**(样本最少处收益应最大)。
 *       2503.19095 警示收缩非灵丹 → 无改善就诚实记录、默认仍 K=0。
 *
 * 方法(leak-safe walk-forward,与 decay 回测同构):big-5 后30%测试期按月块重拟合,
 *   每月块用严格早于该月的历史 fit(各 K 独立),累计 WLD Brier+LogLoss;另算赛季初(8-9月)子集。
 *
 * 用法:node scripts/run-shrinkage-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];
const KS = [0, 1, 2, 4, 6, 10, 15, 25]; // 收缩伪计数(0=现状关闭)
const EPS = 1e-12;
const outcome = (m) => (m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw");
const monthKey = (d) => d.slice(0, 7);
const isEarlySeason = (d) => ["08", "09"].includes(d.slice(5, 7)); // 赛季初(样本少)

const res = await loadFootballDataMatches({ leagues: BIG5 });
const all = res.matches.filter((m) => m.homeGoals != null && m.awayGoals != null && m.date);
const cut = Math.floor(all.length * 0.7);
const test = all.slice(cut);
const months = [...new Set(test.map((m) => monthKey(m.date)))].sort();
console.log(`big-5 ${all.length} 场;测试期 ${test.length} 场(后30%,按月块重拟合)\n`);

function scoreForK(K) {
  let brier = 0, ll = 0, n = 0, hit = 0;
  let eBrier = 0, eLL = 0, eN = 0; // 赛季初子集
  for (const mk of months) {
    const monthMatches = test.filter((m) => monthKey(m.date) === mk);
    const monthStart = monthMatches[0].date;
    const history = all.filter((m) => m.date < monthStart);
    if (history.length < 200) continue;
    const fitted = fitFromMatches(history, { decayDays: 180, referenceDate: monthStart, shrinkageK: K });
    if (!fitted?.usable) continue;
    for (const m of monthMatches) {
      const p = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away })?.probabilities;
      if (!p || !Number.isFinite(p.home)) continue;
      const y = outcome(m);
      const b = (p.home - (y === "home")) ** 2 + (p.draw - (y === "draw")) ** 2 + (p.away - (y === "away")) ** 2;
      const l = -Math.log(Math.max(EPS, p[y]));
      brier += b; ll += l; n++;
      const pick = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw ? "away" : "draw";
      if (pick === y) hit++;
      if (isEarlySeason(m.date)) { eBrier += b; eLL += l; eN++; }
    }
  }
  return { K, brier: brier / n, ll: ll / n, acc: hit / n, n, eBrier: eN ? eBrier / eN : null, eLL: eN ? eLL / eN : null, eN };
}

const results = KS.map(scoreForK);
console.log("收缩K | 样本外Brier | LogLoss | 命中率 | 赛季初Brier | 赛季初LogLoss | 赛季初场数");
for (const r of results) {
  const star = r.K === 0 ? " ←现默认(关闭)" : "";
  console.log(`  ${String(r.K).padStart(2)}  | ${r.brier.toFixed(4)}    | ${r.ll.toFixed(4)} | ${(r.acc * 100).toFixed(1)}% | ${r.eBrier?.toFixed(4) ?? "—"}      | ${r.eLL?.toFixed(4) ?? "—"}       | ${r.eN}${star}`);
}
const base = results.find((r) => r.K === 0);
const bestAll = [...results].sort((a, b) => a.ll - b.ll)[0];
const bestEarly = [...results].filter((r) => r.eLL != null).sort((a, b) => a.eLL - b.eLL)[0];
console.log(`\n全样本最优 K=${bestAll.K}(LogLoss ${bestAll.ll.toFixed(4)} vs 关闭 ${base.ll.toFixed(4)},差 ${(((base.ll - bestAll.ll) / base.ll) * 100).toFixed(2)}%)`);
console.log(`赛季初最优 K=${bestEarly.K}(LogLoss ${bestEarly.eLL.toFixed(4)} vs 关闭 ${base.eLL.toFixed(4)},差 ${(((base.eLL - bestEarly.eLL) / base.eLL) * 100).toFixed(2)}%)`);
const gainAll = ((base.ll - bestAll.ll) / base.ll) * 100;
const gainEarly = base.eLL && bestEarly.eLL ? ((base.eLL - bestEarly.eLL) / base.eLL) * 100 : 0;
// 决策规则:全样本不变差(gainAll≥0)+ 赛季初(小样本处)有意义改善(>0.3%)+ K温和 → 启用。
const accBest = results.find((r) => r.K === bestAll.K)?.acc ?? base.acc;
const noHarm = bestAll.ll <= base.ll && accBest >= base.acc;
const enable = noHarm && gainEarly > 0.3 && bestAll.K > 0 && bestAll.K <= 6;
console.log(`\n诚实结论:全样本 K=${bestAll.K} 增益 ${gainAll.toFixed(2)}%(${gainAll < 0.3 ? "噪声内" : "显著"}),赛季初(小样本)增益 ${gainEarly.toFixed(2)}%。`);
console.log(enable
  ? `→ 收缩在小样本处收益大且全样本/命中率不变差、K 温和(${bestAll.K}) → 建议启用 K=${bestAll.K}(只动小样本队)。`
  : `→ 未满足启用条件(需全样本不变差+赛季初>0.3%+K温和),默认仍 K=0。`);
