/**
 * similar-match-knn 信号 · 诚实留出回测(决定是否接入生产)
 * ─────────────────────────────────────────────────────────────
 * 问题:findSimilarMatches(kNN 相似历史比赛)作为一路 1X2 信号,样本外是否比市场更准?
 *       —— 只有"变好"才接入(feedback-hitrate-closed-loop / no-fabrication）。
 *
 * leak-safe 设计:
 *   - 目标场唯一干净的赛前特征 = 开盘赔率隐含差(home-away)+ 联赛。
 *     (射正/xG 是赛后结果,绝不能当目标场特征 → 排除,避免泄漏。)
 *   - 时间切分:按日期排序,前 cutoff 比例冻结为"历史池",后段做样本外 test。
 *     test 场只在严格更早的历史池里检索 → 无未来泄漏。
 *   - 历史池行带各自的赛后 actual(3/1/0),这是 kNN 的标签来源。
 *
 * 对比预测器(多分类 LogLoss / Brier / RPS / top-1 命中):
 *   - openMarket:开盘赔率隐含概率(我们下注时能拿到的价 = 真 baseline)
 *   - closeMarket:收盘赔率隐含(博彩界最有效价,只作天花板参照)
 *   - kNN:纯 kNN 概率
 *   - blend_w:(1-w)·openMarket + w·kNN,w∈{0.1,0.2,0.3,0.5}
 *
 * 判据:任一 blend 的 LogLoss 与 RPS 同时 < openMarket(样本外)→ kNN 有独立增量 → 接入。
 *       否则诚实拒绝、不接。
 *
 * 用法:node scripts/run-knn-signal-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";
import { findSimilarMatches } from "../src/similar-match-knn.js";

const CUTOFF = 0.7;            // 前 70% 历史池 / 后 30% 样本外
const HISTORY_CAP = 16000;    // 历史池上限(取最靠近 cutoff 的若干场,控时长)
const K = 20;

const actualOf = (m) => (m.homeGoals > m.awayGoals ? 3 : m.homeGoals < m.awayGoals ? 0 : 1);
const probsToVec = (p) => [p.home, p.draw, p.away];               // [home, draw, away]
const outcomeVec = (a) => (a === 3 ? [1, 0, 0] : a === 1 ? [0, 1, 0] : [0, 0, 1]);

function logLoss(p, a) {
  const v = probsToVec(p), o = outcomeVec(a);
  let s = 0;
  for (let i = 0; i < 3; i++) if (o[i]) s += -Math.log(Math.max(v[i], 1e-12));
  return s;
}
function brier(p, a) {
  const v = probsToVec(p), o = outcomeVec(a);
  let s = 0; for (let i = 0; i < 3; i++) s += (v[i] - o[i]) ** 2; return s;
}
function rps(p, a) {
  // ranked probability score(有序 home>draw>away 的累积差),越低越好
  const v = probsToVec(p), o = outcomeVec(a);
  let cumP = 0, cumO = 0, s = 0;
  for (let i = 0; i < 2; i++) { cumP += v[i]; cumO += o[i]; s += (cumP - cumO) ** 2; }
  return s;
}
function top1Hit(p, a) {
  const v = probsToVec(p);
  const arg = v.indexOf(Math.max(...v));
  const want = a === 3 ? 0 : a === 1 ? 1 : 2;
  return arg === want ? 1 : 0;
}
const blend = (m, k, w) => ({
  home: (1 - w) * m.home + w * k.home,
  draw: (1 - w) * m.draw + w * k.draw,
  away: (1 - w) * m.away + w * k.away,
});

const { matches } = await loadFootballDataMatches();
// 只保留有开盘赔率 + 有结果的场
const usable = matches
  .filter((m) => m.odds && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const splitIdx = Math.floor(usable.length * CUTOFF);
const trainAll = usable.slice(0, splitIdx);
const test = usable.slice(splitIdx);

// 历史池行:带 kNN 特征 + actual。取最靠近 cutoff 的 HISTORY_CAP 场(更近≈更相关、且控时长)
const history = trainAll.slice(-HISTORY_CAP).map((m) => ({
  oddsImpliedDiff: m.odds.home - m.odds.away,
  league: m.league,
  date: m.date,
  actual: actualOf(m),
}));

console.log(`总可用 ${usable.length} 场 | 历史池 ${history.length} | 样本外 test ${test.length} | K=${K}`);

const WS = [0.1, 0.2, 0.3, 0.5];
const acc = {
  openMarket: { ll: 0, br: 0, rps: 0, hit: 0 },
  closeMarket: { ll: 0, br: 0, rps: 0, hit: 0, n: 0 },
  kNN: { ll: 0, br: 0, rps: 0, hit: 0 },
};
for (const w of WS) acc[`blend_${w}`] = { ll: 0, br: 0, rps: 0, hit: 0 };

let n = 0, knnOk = 0;
for (const m of test) {
  const a = actualOf(m);
  const target = { oddsImpliedDiff: m.odds.home - m.odds.away, league: m.league };
  const knn = findSimilarMatches(target, history, { k: K });
  const market = { home: m.odds.home, draw: m.odds.draw, away: m.odds.away };

  n++;
  acc.openMarket.ll += logLoss(market, a);
  acc.openMarket.br += brier(market, a);
  acc.openMarket.rps += rps(market, a);
  acc.openMarket.hit += top1Hit(market, a);

  if (m.oddsClose) {
    const c = { home: m.oddsClose.home, draw: m.oddsClose.draw, away: m.oddsClose.away };
    acc.closeMarket.ll += logLoss(c, a);
    acc.closeMarket.br += brier(c, a);
    acc.closeMarket.rps += rps(c, a);
    acc.closeMarket.hit += top1Hit(c, a);
    acc.closeMarket.n++;
  }

  if (knn.ok) {
    knnOk++;
    const kp = knn.probabilities;
    acc.kNN.ll += logLoss(kp, a);
    acc.kNN.br += brier(kp, a);
    acc.kNN.rps += rps(kp, a);
    acc.kNN.hit += top1Hit(kp, a);
    for (const w of WS) {
      const bp = blend(market, kp, w);
      acc[`blend_${w}`].ll += logLoss(bp, a);
      acc[`blend_${w}`].br += brier(bp, a);
      acc[`blend_${w}`].rps += rps(bp, a);
      acc[`blend_${w}`].hit += top1Hit(bp, a);
    }
  } else {
    // kNN 不可用时退回市场(公平:接入后也会这么兜底)
    for (const w of WS) {
      acc[`blend_${w}`].ll += logLoss(market, a);
      acc[`blend_${w}`].br += brier(market, a);
      acc[`blend_${w}`].rps += rps(market, a);
      acc[`blend_${w}`].hit += top1Hit(market, a);
    }
    acc.kNN.ll += logLoss(market, a);
    acc.kNN.br += brier(market, a);
    acc.kNN.rps += rps(market, a);
    acc.kNN.hit += top1Hit(market, a);
  }
}

const fmt = (x) => x.toFixed(4);
const row = (name, o, denom) => {
  const d = denom ?? n;
  return `${name.padEnd(12)} | LogLoss ${fmt(o.ll / d)} | Brier ${fmt(o.br / d)} | RPS ${fmt(o.rps / d)} | 命中 ${(100 * o.hit / d).toFixed(1)}%`;
};

console.log(`\nkNN 可用率 ${(100 * knnOk / n).toFixed(1)}% (${knnOk}/${n})`);
console.log("\n样本外结果(LogLoss/Brier/RPS 越低越好):");
console.log(row("openMarket", acc.openMarket));
console.log(row("closeMarket", acc.closeMarket, acc.closeMarket.n) + "  ← 天花板参照");
console.log(row("kNN", acc.kNN));
for (const w of WS) console.log(row(`blend_${w}`, acc[`blend_${w}`]));

// 判据
const base = acc.openMarket;
let winner = null;
for (const w of WS) {
  const b = acc[`blend_${w}`];
  if (b.ll < base.ll && b.rps < base.rps) {
    if (!winner || b.ll < acc[`blend_${winner}`].ll) winner = w;
  }
}
console.log("\n判据:任一 blend 的 LogLoss 与 RPS 同时低于 openMarket → 接入");
if (winner !== null) {
  const b = acc[`blend_${winner}`];
  console.log(`✅ 有增量:blend_${winner} LogLoss ${fmt(b.ll / n)} < ${fmt(base.ll / n)}、RPS ${fmt(b.rps / n)} < ${fmt(base.rps / n)} → 建议以 w=${winner} 接入`);
} else {
  console.log("❌ 无增量:没有任何 blend 同时在 LogLoss+RPS 上打过开盘市场 → 不接入(诚实拒绝)");
}
