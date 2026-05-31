#!/usr/bin/env node
/**
 * 让球玩法方法对比回测(2026-05-31)——验证"让球按 DC-τ 覆盖分布出胜平负"是否优于
 * 现行"跟胜平负方向 + 让球线"的朴素法(全样本 45.55%,低于随机基线=真弱点)。
 * leak-safe 月度重拟合;用 football-data 亚盘线 + 真实赛果结算。
 * 用法:node scripts/run-handicap-method-backtest.mjs
 */
import "../src/env.js";
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { handicapCoverFromMatrix } from "../src/derived-score-model.js";

function devig(o) { const r = { home: 1 / o.home, draw: 1 / o.draw, away: 1 / o.away }; const t = r.home + r.draw + r.away; return { home: r.home / t, draw: r.draw / t, away: r.away / t }; }

// 整数/半球线在真实比分下的让球结果:home 让 line(line<0=主让)。adj=homeGoals+line。
function settle(homeGoals, awayGoals, line) {
  const adj = homeGoals + line;
  if (Math.abs(adj - awayGoals) < 1e-9) return "push";
  return adj > awayGoals ? "home" : "away";
}

const { matches } = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
// 需要:赛果 + 欧赔(定 wld 热门)+ 亚盘线;线取整数或半球(避免 1/4 球分注复杂结算)
const M = matches
  .filter((m) => m.homeGoals != null && m.oddsClose && (m.asian?.lineClose ?? m.asian?.line) != null)
  .map((m) => ({ ...m, _line: Number(m.asian?.lineClose ?? m.asian?.line) }))
  .filter((m) => Number.isFinite(m._line) && Math.abs(m._line * 2 - Math.round(m._line * 2)) < 1e-9) // 整/半线
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const monthOf = (d) => String(d).slice(0, 7);
let fit = null, fitMonth = null, train = [];
let naiveN = 0, naiveHit = 0, dcN = 0, dcHit = 0;
let coincide = 0;

for (let i = 0; i < M.length; i++) {
  const m = M[i];
  const mo = monthOf(m.date);
  if (mo !== fitMonth) {
    train = M.slice(0, i);
    if (train.length >= 400) { try { fit = fitFromMatches(train, { goalSignal: "actual" }); } catch { fit = null; } }
    fitMonth = mo;
  }
  if (!fit) continue;
  let pred; try { pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away }); } catch { pred = null; }
  if (!pred?.matrix) continue;
  const cov = handicapCoverFromMatrix(pred.matrix, m._line)?.cover;
  if (!cov) continue;
  const actual = settle(m.homeGoals, m.awayGoals, m._line);

  // 朴素法:跟 wld 热门方向覆盖(主热→押 home cover、客热→押 away cover;平热→push)
  const p = devig(m.oddsClose);
  const wldFav = p.home >= p.draw && p.home >= p.away ? "home" : p.away >= p.draw && p.away >= p.home ? "away" : "push";
  naiveN++; if (wldFav === actual) naiveHit++;

  // DC-τ 法:让球覆盖分布 argmax(让主胜/走盘/让客胜)
  const dcPick = ["home", "push", "away"].reduce((b, k) => (cov[k] > cov[b] ? k : b), "home");
  dcN++; if (dcPick === actual) dcHit++;
  if (dcPick === wldFav) coincide++;
}

const pct = (h, n) => (n ? (h / n * 100).toFixed(2) : "0") + "%";
console.log("═".repeat(60));
console.log("让球玩法方法对比(leak-safe,整/半球线)");
console.log("═".repeat(60));
console.log(`样本: ${dcN} 场`);
console.log(`① 朴素法(跟胜平负方向覆盖): ${pct(naiveHit, naiveN)}`);
console.log(`② DC-τ 让球覆盖分布 argmax : ${pct(dcHit, dcN)}`);
console.log(`   提升: ${((dcHit / dcN - naiveHit / naiveN) * 100).toFixed(2)}pp`);
console.log(`   两法选择一致占比: ${pct(coincide, dcN)}(不一致处才是 DC-τ 的差异来源)`);
console.log("═".repeat(60));
