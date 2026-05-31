// 大小球(O/U 2.5)模型 vs 收盘市场线 · 市场低效检验(过夜轮10)
// ───────────────────────────────────────────────────────────────────────────
// 与 run-overunder-backtest.mjs 互补:那个测"联赛级 over 率"经验维度;本脚本测**模型 DC 矩阵 P(over)
//   能否打过收盘大小球市场线**(记忆 reference-top-analyst-essence 指 edge 在大小球;实测说话)。
// 方法:leak-safe 月度重拟合 DC → pred.overUnder.over=模型 P(over) vs m.overProbClose=收盘隐含;
//   比命中/Brier/LogLoss;并测"|模型−市场|≥阈值时跟模型方向下注"命中 vs 市场隐含(有 edge 才是真发现)。
// 跑法:node scripts/run-overunder-vs-market-backtest.mjs
import { loadFootballDataMatches, EXTENDED_LEAGUES, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const minTrain = 400, maxTrain = 4000;
// 联赛组(2026-06-01 轮13 加):--leagues big5|extended|all,验冷门联赛市场是否较不 sharp。
const BIG5 = ALL_LEAGUES.filter((l) => !EXTENDED_LEAGUES.includes(l));
const grp = (process.argv.find((a) => a.startsWith("--leagues="))?.split("=")[1]) ?? "big5";
const LG = grp === "extended" ? EXTENDED_LEAGUES : grp === "all" ? ALL_LEAGUES : BIG5;
console.log(`联赛组=${grp}(${LG.length} 联赛:${LG.join(",")})`);
const { matches } = await loadFootballDataMatches({ leagues: LG });
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
// 速度/CLV 检验(轮13):模型与**开盘线**分歧时,**收盘线是否朝模型方向移动**(=模型有早期信息)。
//   clvSum = 朝模型侧的收盘移动量(开→收,正=收盘确认模型);movedToward = 收盘确认模型的场数。
const clv = { n: 0, movedToward: 0, clvSum: 0 };

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
  // 速度/CLV:模型 vs 开盘线(m.overProb)分歧≥0.05 时,看收盘线相对开盘是否朝模型方向移动。
  if (Number.isFinite(m.overProb) && Math.abs(pModel - m.overProb) >= 0.05) {
    const modelHigher = pModel > m.overProb;       // 模型比开盘更看好 over
    const closeMove = pMarket - m.overProb;          // 收盘 P(over) 相对开盘的移动
    const towardModel = modelHigher ? closeMove : -closeMove; // 朝模型侧为正
    clv.n++; if (towardModel > 0) clv.movedToward++; clv.clvSum += towardModel;
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
console.log(`\n=== 速度/CLV:模型 vs 开盘线分歧时,收盘是否朝模型移动 ===`);
if (clv.n) {
  console.log(`样本 ${clv.n} · 收盘朝模型移动占比=${pct(clv.movedToward / clv.n)} · 平均朝模型移动=${(clv.clvSum / clv.n * 100).toFixed(2)}pp`);
  console.log(`(占比>52% 且 平均>0.3pp → 模型有早期信息=速度 edge;≈50%/≈0 → 模型领先不了市场)`);
}
console.log("\n诚实判读:model 臂 Brier < market 臂 → 模型大小球更准;或分歧下注命中−隐含 >2pp 且样本足 → 真 edge。否则市场高效,如实记录不硬接(符合 reference-signal-backtest-findings)。");
