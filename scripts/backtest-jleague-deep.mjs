// 日职专项 walk-forward 回测(2026-06-06)——诚实测:近期状态(form)能否提升日职 胜负平/比分 命中率。
// 数据=日职历史936场带赛果(无赔率→DC模型口径,非对市场);半全场无HT数据不测。
// 守 feedback_hitrate_closed_loop:变好才采纳。无兜底:form 缺则该场不参与 form 臂。
import { readFileSync, readdirSync } from "node:fs";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { canonicalTeamName } from "../src/team-aliases.js";

const dir = "D:/football-model-data/fixtures";
const JL = /日本职业|日职|J1|J League|Kashima|Kawasaki|Vissel|Urawa|Yokohama|Sanfrecce|Nagoya|Cerezo|Gamba|Sagan|Avispa|Albirex|Consadole|Shimizu|Machida|Fagiano|Kyoto|Kashiwa|FC Tokyo|Tokyo Verdy/i;
const all = [];
for (const f of readdirSync(dir).filter((x) => /^20(2[0-6])-/.test(x) && x.endsWith(".json"))) {
  try {
    const arr = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
    for (const m of (Array.isArray(arr) ? arr : arr.fixtures || [])) {
      const isJ = JL.test((m.competition || "") + (m.homeTeam || "") + (m.awayTeam || ""));
      const hg = m.result?.home ?? m.result?.homeGoals, ag = m.result?.away ?? m.result?.awayGoals;
      if (isJ && Number.isFinite(Number(hg)) && Number.isFinite(Number(ag)) && m.date) {
        all.push({ home: m.homeTeam, away: m.awayTeam, homeGoals: +hg, awayGoals: +ag, date: m.date });
      }
    }
  } catch {}
}
all.sort((a, b) => a.date.localeCompare(b.date));
console.log("日职带赛果:", all.length, "场,", all[0]?.date, "→", all.at(-1)?.date);

// 每队历史结果(算 form):date→ list
const hist = new Map();
const pushHist = (t, r) => { const k = canonicalTeamName(t); if (!hist.has(k)) hist.set(k, []); hist.get(k).push(r); };
function formPoints(team, beforeIdx) {
  const k = canonicalTeamName(team);
  const list = (hist.get(k) || []).filter((r) => r.i < beforeIdx).slice(-5);
  if (list.length < 3) return null; // 样本不足→不臆造
  return list.reduce((s, r) => s + r.pts, 0) / list.length; // 场均积分 0~3
}

const outcome = (h, a) => h > a ? "3" : h < a ? "0" : "1";
const test = all.slice(Math.floor(all.length * 0.5)); // 后50%做测试,前50%起步训练
let n = 0, baseHit = 0, formHit = 0, baseScore = 0;
const K = 0.10; // form 倾斜系数(待测)

for (let gi = 0; gi < all.length; gi++) {
  const m = all[gi];
  // 先记历史(供后续场算form),本场预测只用 gi 之前
  if (gi >= all.length * 0.5) {
    const trainEnd = m.date;
    const train = all.filter((x) => x.date < trainEnd);
    if (train.length < 80) { /* 训练不足跳过 */ }
    else {
      const fit = fitFromMatches(train, { minMatches: 60 });
      if (fit?.usable) {
        const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
        if (pred?.probabilities) {
          const P = pred.probabilities;
          const act = outcome(m.homeGoals, m.awayGoals);
          // 基线:DC argmax
          const basePick = Object.entries({ "3": P.home, "1": P.draw, "0": P.away }).sort((a, b) => b[1] - a[1])[0][0];
          n++; if (basePick === act) baseHit++;
          // 比分:DC top
          if (pred.expectedGoals) { const eh = Math.round(pred.expectedGoals.home), ea = Math.round(pred.expectedGoals.away); if (eh === m.homeGoals && ea === m.awayGoals) baseScore++; }
          // form 臂:按场均积分差倾斜主客胜概率
          const fh = formPoints(m.home, gi), fa = formPoints(m.away, gi);
          let pick2 = basePick;
          if (fh != null && fa != null) {
            const tilt = K * (fh - fa); // 正=主队近况好
            const ph = Math.max(0, P.home + tilt), pa = Math.max(0, P.away - tilt), pd = P.draw;
            const s = ph + pa + pd;
            pick2 = Object.entries({ "3": ph / s, "1": pd / s, "0": pa / s }).sort((a, b) => b[1] - a[1])[0][0];
          }
          if (pick2 === act) formHit++;
        }
      }
    }
  }
  // 记录本场进各队历史
  pushHist(m.home, { i: gi, pts: m.homeGoals > m.awayGoals ? 3 : m.homeGoals === m.awayGoals ? 1 : 0 });
  pushHist(m.away, { i: gi, pts: m.awayGoals > m.homeGoals ? 3 : m.homeGoals === m.awayGoals ? 1 : 0 });
}

console.log("\n=== 日职 walk-forward 回测(测试", n, "场) ===");
console.log("胜负平命中  基线DC :", (baseHit / n * 100).toFixed(1) + "%");
console.log("胜负平命中  +form倾斜(K=" + K + "):", (formHit / n * 100).toFixed(1) + "%", formHit > baseHit ? `(+${((formHit - baseHit) / n * 100).toFixed(1)}pp ✅)` : formHit < baseHit ? `(${((formHit - baseHit) / n * 100).toFixed(1)}pp ❌变差)` : "(持平)");
console.log("比分命中    基线DC :", (baseScore / n * 100).toFixed(1) + "%", "(精确比分物理上限~13%)");
console.log("\n诚实:日职无HT数据→半全场无法回测;无历史赔率→此为DC模型口径非对市场。");
