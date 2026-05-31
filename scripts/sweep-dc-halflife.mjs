/**
 * DC 时间衰减半衰期调优(2026-05-31)——leak-safe 扫描,数据扩到 5.1 万场后重验最优。
 * ════════════════════════════════════════════════════════════════════
 * DC 用 0.5^(daysAgo/halfLife) 加权,halfLife 默认 180 天(经典 EPL 文献值),
 * 但本库现 51k 场跨 47 联赛,最优可能不同。扫 90/180/365/730/无衰减,
 * 看 1X2 RPS(越低越好)+ 大小球 Brier。显著更优才改默认(否则保留 180)。
 *
 * 用法:node scripts/sweep-dc-halflife.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const all = collectHistoricalMatches(4000)
  .filter((m) => m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.7);
const train = all.slice(0, cut), test = all.slice(cut);
console.log(`store ${all.length} 场 | train ${train.length} / test ${test.length}`);

const pOver25 = (lh, la) => { const lt = lh + la; const p0 = Math.exp(-lt); return 1 - p0 - p0 * lt - p0 * lt * lt / 2; };
// 3 序数结果 RPS(home<draw<away 累积)
function rps(p, y) {
  const c1 = p.home - (y === "home" ? 1 : 0);
  const c2 = (p.home + p.draw) - (y === "home" || y === "draw" ? 1 : 0);
  return 0.5 * (c1 * c1 + c2 * c2);
}

const HALF_LIVES = [90, 180, 365, 730, 100000]; // 100000 ≈ 无衰减
console.log("\n半衰期(天)  样本   1X2_RPS   大小球Brier  1X2命中");
const results = [];
for (const hl of HALF_LIVES) {
  const fitted = fitFromMatches(train, { decayDays: hl });
  let n = 0, sumRps = 0, sumBrier = 0, hit = 0;
  for (const m of test) {
    const pred = predictFromFitted(fitted, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities || !pred.expectedGoals) continue;
    const p = pred.probabilities;
    const y = m.homeGoals > m.awayGoals ? "home" : m.homeGoals === m.awayGoals ? "draw" : "away";
    sumRps += rps(p, y);
    const po = pOver25(pred.expectedGoals.home, pred.expectedGoals.away);
    const yo = (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0;
    sumBrier += (po - yo) ** 2;
    const top = p.home >= p.draw && p.home >= p.away ? "home" : p.draw >= p.away ? "draw" : "away";
    if (top === y) hit++;
    n++;
  }
  const r = { hl, n, rps: sumRps / n, brier: sumBrier / n, hit: hit / n };
  results.push(r);
  console.log(
    String(hl === 100000 ? "无衰减" : hl).padStart(8), String(n).padStart(7),
    r.rps.toFixed(4).padStart(9), r.brier.toFixed(4).padStart(11), (r.hit * 100).toFixed(1).padStart(7) + "%");
}

const cur = results.find((r) => r.hl === 180);
const best = results.reduce((b, r) => (r.rps < b.rps ? r : b), results[0]);
console.log(`\n当前默认 180:RPS ${cur.rps.toFixed(4)} | 最优 ${best.hl === 100000 ? "无衰减" : best.hl}:RPS ${best.rps.toFixed(4)} | Δ=${(cur.rps - best.rps).toFixed(4)}`);
if (best.hl === 180 || (cur.rps - best.rps) < 0.001) {
  console.log("→ 180 已最优或差异<0.001(噪声内),保留默认 decayDays=180,不改。");
} else {
  console.log(`→ halfLife=${best.hl} 显著更优(RPS Δ${(cur.rps - best.rps).toFixed(4)}),建议改 dixon-coles-engine 默认 decayDays。`);
}
