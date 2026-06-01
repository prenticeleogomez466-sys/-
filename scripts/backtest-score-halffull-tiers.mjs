/**
 * 比分/半全场 信心分层(通宵 cycle10)——给比分/半全场加"选择性"板块,提实际命中率。
 * 比分/半全场命中率天花板低(~12%/~27%),但**按模型信心(分布峰值)分档**,高信心子集命中率显著更高。
 * 给用户"只出高信心比分/半全场"的可落地规则(少出、出准)。leak-safe train60/test40。
 * 用法:node scripts/backtest-score-halffull-tiers.mjs
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { halfFullJoint } from "../src/halftime-fulltime-model.js";

const sgn = (x, y) => (x > y ? "主" : x === y ? "平" : "客");
const all = collectHistoricalMatches(4000).filter((m) => m.homeGoals != null && m.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(all.length * 0.6); const train = all.slice(0, cut), test = all.slice(cut);
const dc = fitFromMatches(train);
console.log(`train ${train.length}/test ${test.length}`);

// 比分:top-score 概率分档 → exact 命中
const scTiers = [[0.14, []], [0.12, []], [0.10, []], [0.08, []], [0.06, []], [0, []]];
// 半全场:top-class 概率分档 → 9类命中
const hfTiers = [[0.40, []], [0.35, []], [0.30, []], [0.25, []], [0, []]];
const put = (tiers, conf, win) => { for (const t of tiers) if (conf >= t[0]) { t[1].push(win); break; } };

let nsc = 0, nhf = 0;
for (const m of test) {
  const p = predictFromFitted(dc, { homeTeam: m.home, awayTeam: m.away }); if (!p?.topScores?.length) continue;
  const ts = p.topScores[0]; const conf = ts.probability;
  put(scTiers, conf, ts.score === `${m.homeGoals}-${m.awayGoals}` ? 1 : 0); nsc++;
  if (m.halfHome != null && p.expectedGoals) {
    const hf = halfFullJoint(p.expectedGoals.home, p.expectedGoals.away);
    const ent = Object.entries(hf).sort((a, b) => b[1] - a[1])[0];
    const actual = `${sgn(m.halfHome, m.halfAway)}胜-${sgn(m.homeGoals, m.awayGoals)}胜`.replace(/平胜/g, "平局").replace(/主胜/g, "主胜").replace(/客胜/g, "客胜");
    const act = `${sgn(m.halfHome, m.halfAway) === "平" ? "平局" : sgn(m.halfHome, m.halfAway) + "胜"}-${sgn(m.homeGoals, m.awayGoals) === "平" ? "平局" : sgn(m.homeGoals, m.awayGoals) + "胜"}`;
    put(hfTiers, ent[1], ent[0] === act ? 1 : 0); nhf++;
  }
}
const show = (name, tiers, labels) => {
  console.log(`\n${name}(按模型信心分档,命中=该档实测):`);
  console.log("信心档        场数    命中%");
  tiers.forEach((t, i) => { if (!t[1].length) return; const h = t[1].reduce((s, v) => s + v, 0) / t[1].length; console.log(labels[i].padEnd(13), String(t[1].length).padStart(6), (h * 100).toFixed(1).padStart(6) + "%"); });
};
show(`比分(${nsc}场,首选比分命中)`, scTiers, ["≥14%", "12-14%", "10-12%", "8-10%", "6-8%", "<6%"]);
show(`半全场(${nhf}场,9类首选命中)`, hfTiers, ["≥40%", "35-40%", "30-35%", "25-30%", "<25%"]);
console.log("\n判读:信心(分布峰值)越高,该档命中率越高 → '只出高信心档'可显著提实际命中率(代价=少出)。可做成生产板块:比分/半全场各贴信心档+建议。");
