// 日职命中提升·多杠杆诊断回测(2026-06-06)——诚实测哪条真能提命中。
// 测试:①真实胜平负分布 vs 模型(系统偏差?) ②按信心分桶命中(选择性) ③主场优势homeAdv扫描
// ④进球水平(比分)。守 feedback_hitrate_closed_loop。日职无HT→半全场仍无法回测(诚实)。
import { readFileSync, readdirSync } from "node:fs";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const dir = "D:/football-model-data/fixtures";
const JL = /日本职业|日职|J1|J League|Kashima|Kawasaki|Vissel|Urawa|Yokohama|Sanfrecce|Nagoya|Cerezo|Gamba|Sagan|Avispa|Albirex|Consadole|Shimizu|Machida|Fagiano|Kyoto|Kashiwa|FC Tokyo|Tokyo Verdy/i;
const all = [];
for (const f of readdirSync(dir).filter((x) => /^20(2[0-6])-/.test(x) && x.endsWith(".json"))) {
  try { for (const m of (() => { const a = JSON.parse(readFileSync(dir + "/" + f, "utf8")); return Array.isArray(a) ? a : a.fixtures || []; })()) {
    const hg = m.result?.home ?? m.result?.homeGoals, ag = m.result?.away ?? m.result?.awayGoals;
    if (JL.test((m.competition || "") + (m.homeTeam || "") + (m.awayTeam || "")) && Number.isFinite(Number(hg)) && Number.isFinite(Number(ag)) && m.date)
      all.push({ home: m.homeTeam, away: m.awayTeam, homeGoals: +hg, awayGoals: +ag, date: m.date });
  } } catch {}
}
all.sort((a, b) => a.date.localeCompare(b.date));
const cut = Math.floor(all.length * 0.6);
const train0 = all.slice(0, cut), test = all.slice(cut);
const oc = (h, a) => h > a ? "3" : h < a ? "0" : "1";

// 真实分布
const actDist = { "3": 0, "1": 0, "0": 0 };
for (const m of test) actDist[oc(m.homeGoals, m.awayGoals)]++;
const T = test.length;
console.log("日职:", all.length, "场, 测试", T, "场(", test[0].date, "→", test.at(-1).date, ")");
console.log("\n① 真实胜平负分布:  主胜", (actDist["3"] / T * 100).toFixed(1) + "%  平", (actDist["1"] / T * 100).toFixed(1) + "%  客胜", (actDist["0"] / T * 100).toFixed(1) + "%");

// homeAdv 扫描(用增量训练:每场用其之前所有训练,但为速度按 homeAdv 分别全程跑一次单fit近似)
function runHit(homeAdv) {
  let n = 0, hit = 0, score = 0, sumPred = { "3": 0, "1": 0, "0": 0 };
  const buckets = { hi: [0, 0], mid: [0, 0], lo: [0, 0] }; // [hit,n] by max-prob
  for (const m of test) {
    const train = all.filter((x) => x.date < m.date);
    if (train.length < 100) continue;
    const fit = fitFromMatches(train, { minMatches: 60, homeAdvantage: homeAdv });
    if (!fit?.usable) continue;
    const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
    if (!pred?.probabilities) continue;
    const P = pred.probabilities; const act = oc(m.homeGoals, m.awayGoals);
    const ent = [["3", P.home], ["1", P.draw], ["0", P.away]].sort((a, b) => b[1] - a[1]);
    const pick = ent[0][0], top = ent[0][1];
    n++; sumPred["3"] += P.home; sumPred["1"] += P.draw; sumPred["0"] += P.away;
    const ok = pick === act ? 1 : 0; hit += ok;
    const b = top >= 0.55 ? "hi" : top >= 0.45 ? "mid" : "lo"; buckets[b][0] += ok; buckets[b][1]++;
    if (pred.expectedGoals && Math.round(pred.expectedGoals.home) === m.homeGoals && Math.round(pred.expectedGoals.away) === m.awayGoals) score++;
  }
  return { n, hit, score, buckets, sumPred };
}

console.log("\n③ 主场优势 homeAdv 扫描(日职专属 vs 全局1.22):");
let best = { ha: 1.22, hit: 0, n: 1 };
for (const ha of [1.18, 1.22, 1.32]) {
  const r = runHit(ha);
  const rate = r.hit / r.n * 100;
  if (r.hit / r.n > best.hit / best.n) best = { ha, hit: r.hit, n: r.n };
  console.log(`   homeAdv=${ha}: 胜平负命中 ${rate.toFixed(1)}% (n=${r.n})`);
}
console.log("   → 最佳 homeAdv =", best.ha, "(全局是1.22)");

// 用最佳 homeAdv 出②选择性 + ④比分 + 模型预测分布
const r = runHit(best.ha);
console.log("\n② 选择性·按信心(最高概率)分桶命中:");
for (const [k, label] of [["hi", "高信心(top≥55%)"], ["mid", "中(45-55%)"], ["lo", "低(<45%)"]]) {
  const [h, nn] = r.buckets[k]; if (nn) console.log(`   ${label}: ${(h / nn * 100).toFixed(1)}% (${nn}场, 覆盖${(nn / r.n * 100).toFixed(0)}%)`);
}
console.log("\n④ 模型预测均值分布:  主胜", (r.sumPred["3"] / r.n * 100).toFixed(1) + "%  平", (r.sumPred["1"] / r.n * 100).toFixed(1) + "%  客胜", (r.sumPred["0"] / r.n * 100).toFixed(1) + "%");
console.log("   (对比真实:主", (actDist["3"] / T * 100).toFixed(1) + "% 平", (actDist["1"] / T * 100).toFixed(1) + "% 客", (actDist["0"] / T * 100).toFixed(1) + "%) → 看模型有无系统低估/高估");
console.log("比分命中(best homeAdv):", (r.score / r.n * 100).toFixed(1) + "%");
console.log("\n诚实:日职历史无HT数据→半全场无法回测验证;无历史赔率→DC口径(生产叠加500实时赔率更强)。");
