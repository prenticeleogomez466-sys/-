// 大小球(O/U 2.5)模型 vs 收盘市场线 · 市场低效检验(过夜轮10)
// ───────────────────────────────────────────────────────────────────────────
// 与 run-overunder-backtest.mjs 互补:那个测"联赛级 over 率"经验维度;本脚本测**模型 DC 矩阵 P(over)
//   能否打过收盘大小球市场线**(记忆 reference-top-analyst-essence 指 edge 在大小球;实测说话)。
// 方法:leak-safe 月度重拟合 DC → pred.overUnder.over=模型 P(over) vs m.overProbClose=收盘隐含;
//   比命中/Brier/LogLoss;并测"|模型−市场|≥阈值时跟模型方向下注"命中 vs 市场隐含(有 edge 才是真发现)。
// 跑法:node scripts/run-overunder-vs-market-backtest.mjs
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const minTrain = 400, maxTrain = 4000;
const { matches } = await loadFootballDataMatches();
const usable = matches
  .filter((m) => Number.isFinite(m.overProbClose) && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
console.log(`可用 ${usable.length} 场(带收盘大小球线+赛果)`);

function acc() { return { n: 0, hit: 0, brier: 0, logLoss: 0 }; }
function rec(a, pOver, actualOver) {
  a.n++; if ((pOver >= 0.5) === actualOver) a.hit++;
  const e = actualOver ? 1 : 0;
  a.brier += (pOver - e) ** 2;
  const p = Math.min(0.999, Math.max(0.001, pOver));
  a.logLoss += -(e * Math.log(p) + (1 - e) * Math.log(1 - p));
}
function fin(a) { return a.n ? { n: a.n, acc: a.hit / a.n, brier: a.brier / a.n, logLoss: a.logLoss / a.n } : null; }

const arms = { model: acc(), market: acc(), blend: acc() };
const THRS = [0.05, 0.08, 0.12];
const disagree = THRS.map((thr) => ({ thr, n: 0, won: 0, impliedSum: 0 }));

let curYm = null, fit = null;
for (let i = 0; i < usable.length; i++) {
  const m = usable[i];
  const ym = String(m.date).slice(0, 7);
  if (ym !== curYm) {
    const prior = usable.slice(0, i);
    if (prior.length >= minTrain) {
      const f = fitFromMatches(prior.slice(-maxTrain), { referenceDate: m.date });
      if (f?.usable) fit = f;
    }
    curYm = ym;
  }
  if (!fit) continue;
  const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
  const pModel = pred?.overUnder?.over;
  if (!Number.isFinite(pModel)) continue;
  const pMarket = m.overProbClose;
  const actualOver = (m.homeGoals + m.awayGoals) > 2.5;
  rec(arms.model, pModel, actualOver);
  rec(arms.market, pMarket, actualOver);
  rec(arms.blend, 0.5 * pModel + 0.5 * pMarket, actualOver);
  for (const d of disagree) {
    if (Math.abs(pModel - pMarket) >= d.thr) {
      const betOver = pModel > pMarket;
      d.n++; if (betOver === actualOver) d.won++;
      d.impliedSum += betOver ? pMarket : (1 - pMarket);
    }
  }
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
console.log("\n=== 模型 DC P(over) vs 收盘市场线(O/U 2.5)===");
for (const [k, a] of Object.entries(arms)) {
  const f = fin(a); if (!f) continue;
  console.log(`${k}: n=${f.n} 命中=${pct(f.acc)} Brier=${f.brier.toFixed(4)} LogLoss=${f.logLoss.toFixed(4)}`);
}
console.log("\n=== 分歧下注:|模型−市场|≥阈值,跟模型方向 ===");
console.log("阈值 | 样本 | 跟模型命中 | 市场该侧平均隐含 | 命中−隐含");
for (const d of disagree) {
  if (!d.n) { console.log(`${d.thr} | 0 | — | — | —`); continue; }
  const win = d.won / d.n, implied = d.impliedSum / d.n;
  const edge = (win - implied) * 100;
  console.log(`${d.thr} | ${d.n} | ${pct(win)} | ${pct(implied)} | ${edge.toFixed(1)}pp ${edge >= 2 ? "✅有edge" : edge <= -2 ? "❌反edge" : "≈市场"}`);
}
console.log("\n诚实判读:model 臂 Brier < market 臂 → 模型大小球更准;或分歧下注命中−隐含 >2pp 且样本足 → 真 edge。否则市场高效,如实记录不硬接(符合 reference-signal-backtest-findings)。");
