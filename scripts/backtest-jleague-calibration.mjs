// 日职域校准回测(2026-06-06)——诚实测:日职专属 homeAdv 是否比全局1.22更优(主场优势天生弱)。
// 假设:日职实际主胜40.9%<欧洲~45%→全局1.22高估日职主胜→专属较低homeAdv提校准。
// leak-safe:train严格早于test;守 feedback_hitrate_closed_loop:Brier+命中都变好才采纳。无兜底。
import { listFixtureDates, loadFixtures } from "../src/fixture-store.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { canonicalTeamName } from "../src/team-aliases.js";

const JL = /日本职业|日职|J1|J League|J\.League/i;
const all = [];
for (const d of listFixtureDates()) {
  for (const f of loadFixtures(d).fixtures) {
    if (!f.result || !Number.isFinite(f.result.home) || !Number.isFinite(f.result.away)) continue;
    all.push({ home: f.homeTeam, away: f.awayTeam, homeGoals: f.result.home, awayGoals: f.result.away,
      date: d, isJL: JL.test(f.competition || "") });
  }
}
all.sort((a, b) => a.date.localeCompare(b.date));
const cutoff = "2025-06-01"; // train < cutoff,test(日职) >= cutoff
const train = all.filter((m) => m.date < cutoff);
const testJL = all.filter((m) => m.date >= cutoff && m.isJL);
console.log(`train ${train.length} 场(全联赛) / test 日职 ${testJL.length} 场(>=${cutoff})\n`);

const oc = (h, a) => h > a ? "home" : h < a ? "away" : "draw";
function evalH(H) {
  const fit = fitFromMatches(train, { minMatches: 60, homeAdvantage: H });
  if (!fit?.usable) return null;
  let n = 0, hit = 0, brier = 0, predHome = 0, actHome = 0;
  for (const m of testJL) {
    const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities) continue;
    const P = pred.probabilities, act = oc(m.homeGoals, m.awayGoals);
    n++;
    const pick = [["home", P.home], ["draw", P.draw], ["away", P.away]].sort((a, b) => b[1] - a[1])[0][0];
    if (pick === act) hit++;
    for (const [k, p] of [["home", P.home], ["draw", P.draw], ["away", P.away]]) {
      const y = act === k ? 1 : 0; brier += (p - y) ** 2;
    }
    predHome += P.home; actHome += act === "home" ? 1 : 0;
  }
  return { H, n, hit: hit / n, brier: brier / n, predHomeAvg: predHome / n, actHomeRate: actHome / n };
}

console.log("homeAdv | 命中率 | Brier | 模型平均主胜概率 | 实际主胜率 | 校准差");
const results = [];
for (const H of [1.00, 1.08, 1.15, 1.22, 1.30]) {
  const r = evalH(H);
  if (!r) { console.log(`  ${H} | 拟合失败`); continue; }
  results.push(r);
  const calErr = (r.predHomeAvg - r.actHomeRate) * 100;
  console.log(`  ${r.H.toFixed(2)} | ${(r.hit * 100).toFixed(1)}% | ${r.brier.toFixed(4)} | ${(r.predHomeAvg * 100).toFixed(1)}% | ${(r.actHomeRate * 100).toFixed(1)}% | ${calErr >= 0 ? "+" : ""}${calErr.toFixed(1)}pp ${H === 1.22 ? "← 全局现状" : ""}`);
}
const base = results.find((r) => r.H === 1.22);
const best = results.slice().sort((a, b) => a.brier - b.brier)[0];
console.log(`\n基准(1.22): 命中${(base.hit*100).toFixed(1)}% Brier${base.brier.toFixed(4)} 校准差${((base.predHomeAvg-base.actHomeRate)*100).toFixed(1)}pp`);
console.log(`最优(${best.H}): 命中${(best.hit*100).toFixed(1)}% Brier${best.brier.toFixed(4)} 校准差${((best.predHomeAvg-best.actHomeRate)*100).toFixed(1)}pp`);
const better = best.H !== 1.22 && best.brier < base.brier - 0.0005 && best.hit >= base.hit - 0.005;
console.log(`\n裁决: ${better ? `✅ 日职专属 homeAdv=${best.H} 真变好(Brier-${((base.brier-best.brier)).toFixed(4)},命中${(best.hit*100).toFixed(1)}%)→可上` : "❌ 无稳健增益(在噪声内/命中变差)→不上,守纪律不过拟合"}`);
