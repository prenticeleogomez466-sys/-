#!/usr/bin/env node
/**
 * 让球覆盖:市场亚盘水位 vs DC-τ 覆盖分布(2026-05-31 矫正)
 * 验证"让球玩法是否该融合市场亚盘水位"——亚盘是足球最 sharp 的盘口,
 * 类比 1X2(市场 54.8% > 纯模型 51%),市场隐含覆盖概率应优于纯 DC-τ。
 * leak-safe 月度重拟合;football-data 亚盘收盘线+收盘水位+真实赛果结算。
 * 用法:node scripts/run-handicap-market-backtest.mjs
 */
import "../src/env.js";
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";
import { handicapCoverFromMatrix } from "../src/derived-score-model.js";

// 让球结算:home 让 line(line<0=主让),adj=homeGoals+line。整/半线三态。
function settle(homeGoals, awayGoals, line) {
  const adj = homeGoals + line;
  if (Math.abs(adj - awayGoals) < 1e-9) return "push";
  return adj > awayGoals ? "home" : "away";
}
// 两路亚盘水位去 vig → P(home covers)/P(away covers)(两路,无 push 质量)
function marketCoverHA(homeWater, awayWater) {
  if (!(homeWater > 1 && awayWater > 1)) return null;
  const rh = 1 / homeWater, ra = 1 / awayWater, t = rh + ra;
  return { home: rh / t, away: ra / t };
}
const argmax3 = (c) => ["home", "push", "away"].reduce((b, k) => (c[k] > c[b] ? k : b), "home");

const { matches } = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const M = matches
  .filter((m) => m.homeGoals != null && m.oddsClose && (m.asian?.lineClose ?? m.asian?.line) != null)
  .map((m) => ({
    ...m,
    _line: Number(m.asian?.lineClose ?? m.asian?.line),
    _hw: Number(m.asian?.homeWaterClose ?? m.asian?.homeWater),
    _aw: Number(m.asian?.awayWaterClose ?? m.asian?.awayWater)
  }))
  .filter((m) => Number.isFinite(m._line) && Math.abs(m._line * 2 - Math.round(m._line * 2)) < 1e-9)
  .filter((m) => m._hw > 1 && m._aw > 1) // 必须有两路水位才能比市场
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const monthOf = (d) => String(d).slice(0, 7);
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1.0];
let fit = null, fitMonth = null;
let dcN = 0, dcHit = 0, mktN = 0, mktHit = 0;
const blendHit = Object.fromEntries(WEIGHTS.map((w) => [w, 0]));
let blendN = 0;

for (let i = 0; i < M.length; i++) {
  const m = M[i];
  const mo = monthOf(m.date);
  if (mo !== fitMonth) {
    const train = M.slice(0, i);
    if (train.length >= 400) { try { fit = fitFromMatches(train, { goalSignal: "actual" }); } catch { fit = null; } }
    fitMonth = mo;
  }
  if (!fit) continue;
  let pred; try { pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away }); } catch { pred = null; }
  if (!pred?.matrix) continue;
  const cov = handicapCoverFromMatrix(pred.matrix, m._line)?.cover;
  if (!cov) continue;
  const mkt = marketCoverHA(m._hw, m._aw);
  if (!mkt) continue;
  const actual = settle(m.homeGoals, m.awayGoals, m._line);

  // ② DC-τ 覆盖 argmax(现行生产)
  dcN++; if (argmax3(cov) === actual) dcHit++;

  // ③ 市场水位 argmax(仅 home/away,从不预测 push)
  mktN++; if ((mkt.home >= mkt.away ? "home" : "away") === actual) mktHit++;

  // ④ 融合:push 质量取自模型,非 push 内主客比例 = w·市场 + (1-w)·模型
  const push = cov.push ?? 0;
  const nonPush = Math.max(1e-9, 1 - push);
  const modelRatioHome = cov.home / Math.max(1e-9, cov.home + cov.away);
  blendN++;
  for (const w of WEIGHTS) {
    const ratioHome = w * mkt.home + (1 - w) * modelRatioHome;
    const blended = { home: nonPush * ratioHome, push, away: nonPush * (1 - ratioHome) };
    if (argmax3(blended) === actual) blendHit[w]++;
  }
}

const pct = (h, n) => (n ? (h / n * 100).toFixed(2) : "0") + "%";
console.log("═".repeat(64));
console.log("让球覆盖:市场亚盘水位 vs DC-τ(leak-safe,整/半球线,收盘水位)");
console.log("═".repeat(64));
console.log(`样本: ${dcN} 场(均有两路收盘水位)`);
console.log(`② DC-τ 覆盖分布 argmax(现行) : ${pct(dcHit, dcN)}`);
console.log(`③ 市场亚盘水位 argmax        : ${pct(mktHit, mktN)}`);
console.log("─".repeat(64));
console.log("④ 融合(push 取模型,主客比例 w·市场+(1-w)·模型):");
for (const w of WEIGHTS) {
  const tag = w === 0 ? " (=纯模型)" : w === 1 ? " (=市场比例+模型push)" : "";
  console.log(`   w=${w.toFixed(2)} : ${pct(blendHit[w], blendN)}${tag}`);
}
console.log("═".repeat(64));
const best = WEIGHTS.reduce((b, w) => (blendHit[w] > blendHit[b] ? w : b), 0);
console.log(`最优融合权重 w=${best.toFixed(2)} → ${pct(blendHit[best], blendN)}  vs 现行 DC-τ ${pct(dcHit, dcN)}  Δ=${((blendHit[best] / blendN - dcHit / dcN) * 100).toFixed(2)}pp`);
