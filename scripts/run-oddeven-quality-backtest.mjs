// 单双进球(总进球奇偶)模型质量回测(过夜轮18)——补一个竞彩玩法的诚实自知。
// ───────────────────────────────────────────────────────────────────────────
// 无市场单双赔率 → 模型质量测:模型从 DC 矩阵算 P(单)=Σ matrix[h][a] (h+a 为奇),vs 实际 + naive。
// 先验:总进球奇偶接近 50/50、极难预测,预期模型≈naive(诚实=正常,别夸大)。
// 跑法:node scripts/run-oddeven-quality-backtest.mjs
import { loadFootballDataMatches, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场`);

function oddProb(matrix) {
  let p = 0;
  for (let h = 0; h < matrix.length; h++)
    for (let a = 0; a < matrix[h].length; a++) if ((h + a) % 2 === 1) p += matrix[h][a];
  return p;
}

const agg = { n: 0, hit: 0, brier: 0, actualOdd: 0 };
const calib = {};
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
  const p = oddProb(pred.matrix);
  const odd = (m.homeGoals + m.awayGoals) % 2 === 1;
  agg.n++; if ((p >= 0.5) === odd) agg.hit++;
  agg.brier += (p - (odd ? 1 : 0)) ** 2;
  if (odd) agg.actualOdd++;
  const bk = Math.min(9, Math.floor(p * 10));
  (calib[bk] ??= { n: 0, odd: 0, psum: 0 }); calib[bk].n++; if (odd) calib[bk].odd++; calib[bk].psum += p;
  const lg = m.league; (byLeague[lg] ??= { n: 0, hit: 0, odd: 0 });
  byLeague[lg].n++; if ((p >= 0.5) === odd) byLeague[lg].hit++; if (odd) byLeague[lg].odd++;
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const baseOdd = agg.actualOdd / agg.n;
const naiveAcc = Math.max(baseOdd, 1 - baseOdd);
console.log(`\n=== 单双进球 模型质量(n=${agg.n})===`);
console.log(`实际单数率 ${pct(baseOdd)} · 模型命中 ${pct(agg.hit / agg.n)} vs naive 押多数类 ${pct(naiveAcc)} · Brier ${(agg.brier / agg.n).toFixed(4)}`);

console.log("\n=== 校准 ===");
let ece = 0;
for (let b = 0; b < 10; b++) {
  const c = calib[b]; if (!c || c.n < 50) continue;
  const predMean = c.psum / c.n, actual = c.odd / c.n;
  ece += (c.n / agg.n) * Math.abs(predMean - actual);
  console.log(`  ${b * 10}-${b * 10 + 10}%: 预测均 ${pct(predMean)} → 实际单 ${pct(actual)} (n=${c.n}) gap ${((actual - predMean) * 100).toFixed(1)}pp`);
}
console.log(`  ECE = ${(ece * 100).toFixed(2)}pp`);
console.log("\n诚实判读:总进球奇偶近 50/50 不可预测;模型≈naive、校准≈50% = 正常(单双本质抛硬币,模型不编造区分度)。");
