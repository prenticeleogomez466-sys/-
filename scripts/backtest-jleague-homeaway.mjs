// 日职·per-team 主客场异质性回测(2026-06-06)——诚实测:各队专属主场强度(替全局1.22)能否提命中。
// 假设:全局 homeAdv 抹平了"主场龙客场虫"队的真实主场优势→模型系统看错→纠正可提命中。
// 守 feedback_hitrate_closed_loop:变好才采纳。无兜底:样本不足的队不臆造tilt。
import { readFileSync, readdirSync } from "node:fs";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { canonicalTeamName } from "../src/team-aliases.js";

const dir = "D:/football-model-data/fixtures";
const JL = /日本职业|日职|J1|J League|Kashima|Kawasaki|Vissel|Urawa|Yokohama|Sanfrecce|Nagoya|Cerezo|Gamba|Sagan|Avispa|Albirex|Consadole|Shimizu|Machida|Fagiano|Kyoto|Kashiwa|FC Tokyo|Tokyo Verdy/i;
const all = [];
for (const f of readdirSync(dir).filter((x) => /^20(2[0-6])-/.test(x) && x.endsWith(".json"))) {
  try { for (const m of (() => { const a = JSON.parse(readFileSync(dir + "/" + f, "utf8")); return Array.isArray(a) ? a : a.fixtures || []; })()) {
    const hg = m.result?.home ?? m.result?.homeGoals, ag = m.result?.away ?? m.result?.awayGoals;
    if (JL.test((m.competition || "") + (m.homeTeam || "") + (m.awayTeam || "")) && Number.isFinite(Number(hg)) && Number.isFinite(Number(ag)) && m.date)
      all.push({ home: m.homeTeam, hC: canonicalTeamName(m.homeTeam), away: m.away, aC: canonicalTeamName(m.awayTeam), hg: +hg, ag: +ag, homeGoals: +hg, awayGoals: +ag, date: m.date });
  } } catch {}
}
all.sort((a, b) => a.date.localeCompare(b.date));
const oc = (h, a) => h > a ? "3" : h < a ? "0" : "1";
const cut = Math.floor(all.length * 0.6);
const test = all.slice(cut).slice(-250);

// 每队主/客场 ppg(只用预测日之前的数据,避免泄漏)
function homeAwayTilt(team, isHome, beforeDate) {
  const k = canonicalTeamName(team);
  const games = all.filter((m) => m.date < beforeDate && (m.hC === k || m.aC === k));
  if (games.length < 10) return 0; // 样本不足→不tilt(不臆造)
  let hP = 0, hN = 0, aP = 0, aN = 0;
  for (const m of games) {
    if (m.hC === k) { hN++; hP += m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0; }
    else { aN++; aP += m.ag > m.hg ? 3 : m.hg === m.ag ? 1 : 0; }
  }
  if (hN < 5 || aN < 5) return 0;
  const homePpg = hP / hN, awayPpg = aP / aN;
  // "主场龙客场虫"程度 = 主客ppg差 - 联赛平均主客差(约0.5)。正=该队主场异常强
  const gap = (homePpg - awayPpg) - 0.5;
  return isHome ? gap : -gap; // 主队:gap正→加主胜;客队同理反向
}

let n = 0, baseHit = 0, haHit = 0;
const K = 0.06; // tilt 系数
for (const m of test) {
  const train = all.filter((x) => x.date < m.date);
  if (train.length < 100) continue;
  const fit = fitFromMatches(train, { minMatches: 60 });
  if (!fit?.usable) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.probabilities) continue;
  const P = pred.probabilities; const act = oc(m.hg, m.ag);
  n++;
  const basePick = [["3", P.home], ["1", P.draw], ["0", P.away]].sort((a, b) => b[1] - a[1])[0][0];
  if (basePick === act) baseHit++;
  // per-team 主客场 tilt
  const tilt = K * (homeAwayTilt(m.home, true, m.date) + homeAwayTilt(m.away, false, m.date));
  const ph = Math.max(0, P.home + tilt), pa = Math.max(0, P.away - tilt), pd = P.draw, s = ph + pa + pd;
  const haPick = [["3", ph / s], ["1", pd / s], ["0", pa / s]].sort((a, b) => b[1] - a[1])[0][0];
  if (haPick === act) haHit++;
}
console.log("=== 日职 per-team 主客场异质性回测(测试", n, "场,K=" + K + ") ===");
console.log("胜负平  基线DC           :", (baseHit / n * 100).toFixed(1) + "%");
console.log("胜负平  +per-team主客场tilt:", (haHit / n * 100).toFixed(1) + "%",
  haHit > baseHit ? `(+${((haHit - baseHit) / n * 100).toFixed(1)}pp ✅真增益!)` : haHit < baseHit ? `(${((haHit - baseHit) / n * 100).toFixed(1)}pp ❌变差)` : "(持平)");
