// 诱盘判定真实性回测(过夜轮9,深化轮1 upsetTrap)——直接回答用户"是诱盘还是真实体现"。
// ───────────────────────────────────────────────────────────────────────────
// 方法:football-data 开+收盘隐含赔率 + leak-safe 月度重拟合 DC(独立模型概率)→ 对每场算 trapVerdict
//   → 按 verdict 桶统计「热门**实际**胜率 vs 收盘**隐含**胜率」。
// 关键判据(诚实):若"诱盘嫌疑"桶 实际 << 隐含(热门跑输市场定价)→ 诱盘判定有 edge;
//   若各桶 实际≈隐含 → 市场高效、诱盘判定只是模型与市场分歧(无下注 edge),如实标注、不夸大。
// 用 **纯 DC** 当 model(最大化分歧信号给诱盘判定最强检验);另跑一遍生产忠实的 blend model 对照。
// 跑法:node scripts/run-trap-verdict-backtest.mjs
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted, blendWithOdds } from "../src/dixon-coles-engine.js";
import { analyzeUpsetTrap, favoriteUpset } from "../src/upset-trap-detector.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => m.odds && m.oddsClose && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场(带开+收盘赔率+赛果)`);

function ymOf(d) { return String(d).slice(0, 7); }

// 桶:verdict → { n, impliedSum, favWon }
function newBuckets() { return {}; }
function addBucket(buckets, key, impliedFav, favWon) {
  (buckets[key] ??= { n: 0, impliedSum: 0, favWon: 0 });
  buckets[key].n++; buckets[key].impliedSum += impliedFav; if (favWon) buckets[key].favWon++;
}

const byVerdictDC = newBuckets();
const byVerdictBlend = newBuckets();

let curYm = null, fit = null, tested = 0;
for (let i = 0; i < usable.length; i++) {
  const m = usable[i];
  const ym = ymOf(m.date);
  if (ym !== curYm) {
    const prior = usable.slice(0, i);
    if (prior.length >= minTrain) {
      const train = prior.slice(-maxTrain);
      const f = fitFromMatches(train, { referenceDate: m.date });
      if (f?.usable) fit = f;
    }
    curYm = ym;
  }
  if (!fit) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  if (!pred?.probabilities) continue;
  const dcProbs = pred.probabilities;
  const blendProbs = blendWithOdds(m.oddsClose, pred, { competition: m.league }).probabilities ?? m.oddsClose;
  const u = favoriteUpset(m.oddsClose, { home: m.homeGoals, away: m.awayGoals });
  if (!u) continue;
  const impliedFav = m.oddsClose[u.favorite];
  tested++;
  const aDC = analyzeUpsetTrap({ opening: m.odds, closing: m.oddsClose, model: dcProbs });
  if (aDC) addBucket(byVerdictDC, aDC.trapVerdict, impliedFav, u.won);
  const aBl = analyzeUpsetTrap({ opening: m.odds, closing: m.oddsClose, model: blendProbs });
  if (aBl) addBucket(byVerdictBlend, aBl.trapVerdict, impliedFav, u.won);
}

function report(title, buckets) {
  console.log(`\n=== ${title} ===`);
  console.log("verdict | n | 收盘隐含均(热门) | 实际胜率(热门) | 实际−隐含");
  const rows = Object.entries(buckets).sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of rows) {
    const implied = v.impliedSum / v.n;
    const actual = v.favWon / v.n;
    const diff = actual - implied;
    const flag = Math.abs(diff) >= 0.03 ? (diff < 0 ? " ⬇热门跑输" : " ⬆热门跑赢") : "";
    console.log(`${k} | ${v.n} | ${(implied * 100).toFixed(1)}% | ${(actual * 100).toFixed(1)}% | ${(diff * 100).toFixed(1)}pp${flag}`);
  }
}

console.log(`\n参与统计 ${tested} 场`);
report("纯 DC 当 model(最大分歧检验)", byVerdictDC);
report("blend 当 model(生产忠实)", byVerdictBlend);
console.log("\n诚实判读:看「诱盘嫌疑」桶 实际−隐含 是否显著为负(热门跑输市场定价=诱盘判定有 edge);");
console.log("若各桶 实际≈隐含(差<3pp)→ 市场高效,诱盘判定=模型与市场分歧的透明读数,非下注 edge(符合记忆 reference-signal-backtest-findings)。");
