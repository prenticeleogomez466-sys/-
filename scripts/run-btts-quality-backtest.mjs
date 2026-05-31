// BTTS(双方进球)模型校准质量回测(过夜轮15)——补一个玩法的诚实自知。
// ───────────────────────────────────────────────────────────────────────────
// football-data 无 BTTS 赔率 → 这是**模型质量**测(非市场 edge):模型从 DC 矩阵算 P(BTTS)
//   (=1−P(主0)−P(客0)+P(0-0)),在真实赛果上量 命中/Brier/校准 + 比 naive。
// 方法:leak-safe 月度重拟合 DC → matrix → P(BTTS) vs 实际(双方均≥1球)。
// 跑法:node scripts/run-btts-quality-backtest.mjs
import { loadFootballDataMatches, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场`);

// 从 DC 矩阵算 P(BTTS)
function bttsProb(matrix) {
  let p = 0;
  for (let h = 1; h < matrix.length; h++)
    for (let a = 1; a < matrix[h].length; a++) p += matrix[h][a];
  return p;
}

const agg = { n: 0, hit: 0, brier: 0, baseHit: 0, actualYes: 0 };
const calib = {}; // 概率桶(10%宽)→ {n, yes, psum}
const byLeague = {};
let curYm = null, fit = null;
for (let i = 0; i < usable.length; i++) {
  const m = usable[i];
  const ym = String(m.date).slice(0, 7);
  if (ym !== curYm) {
    const prior = usable.slice(0, i);
    if (prior.length >= minTrain) { const f = fitFromMatches(prior.slice(-maxTrain), { referenceDate: m.date }); if (f?.usable) fit = f; }
    curYm = ym;
  }
  if (!fit) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.matrix) continue;
  const p = bttsProb(pred.matrix);
  const yes = m.homeGoals >= 1 && m.awayGoals >= 1;
  agg.n++; if ((p >= 0.5) === yes) agg.hit++;
  agg.brier += (p - (yes ? 1 : 0)) ** 2;
  if (yes) agg.actualYes++;
  if (yes) agg.baseHit++; // naive "总押 BTTS-yes"(BTTS-yes 是多数类)
  const bk = Math.min(9, Math.floor(p * 10));
  (calib[bk] ??= { n: 0, yes: 0, psum: 0 }); calib[bk].n++; if (yes) calib[bk].yes++; calib[bk].psum += p;
  const lg = m.league; (byLeague[lg] ??= { n: 0, hit: 0, yes: 0 });
  byLeague[lg].n++; if ((p >= 0.5) === yes) byLeague[lg].hit++; if (yes) byLeague[lg].yes++;
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const baseYes = agg.actualYes / agg.n;
const naiveAcc = Math.max(baseYes, 1 - baseYes); // naive 押多数类的命中率
console.log(`\n=== BTTS 模型质量(n=${agg.n})===`);
console.log(`实际 BTTS-yes 率 ${pct(baseYes)} · 模型命中 ${pct(agg.hit / agg.n)} vs naive 押多数类 ${pct(naiveAcc)} · Brier ${(agg.brier / agg.n).toFixed(4)}`);

console.log("\n=== 校准(预测 P(BTTS) 桶 → 实际 yes 率)===");
let ece = 0;
for (let b = 0; b < 10; b++) {
  const c = calib[b]; if (!c || c.n < 30) continue;
  const predMean = c.psum / c.n, actual = c.yes / c.n;
  ece += (c.n / agg.n) * Math.abs(predMean - actual);
  console.log(`  ${b * 10}-${b * 10 + 10}%: 预测均 ${pct(predMean)} → 实际 ${pct(actual)} (n=${c.n}) gap ${((actual - predMean) * 100).toFixed(1)}pp`);
}
console.log(`  ECE(校准误差,越小越准)= ${(ece * 100).toFixed(2)}pp`);

console.log("\n=== 逐联赛(样本≥500)===");
for (const [lg, v] of Object.entries(byLeague).filter(([, v]) => v.n >= 500).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${LEAGUE_LABELS[lg] ?? lg}: 命中 ${pct(v.hit / v.n)} · 实际yes ${pct(v.yes / v.n)} (n=${v.n})`);
}
console.log("\n诚实判读:模型命中 > naive + ECE 小 = BTTS 校准良好有区分度;命中≈naive = 无区分(BTTS 接近抛硬币,正常)。");
