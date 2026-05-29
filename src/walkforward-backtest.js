/**
 * Walk-Forward 回测(V 档 — 诚实命中率量化)
 * ────────────────────────────────────────────────────────────
 * backtest:evolution 用的是 ledger 已结算预测(冷启动期只有 2 条),用不上
 * 回填的 3600+ 场历史。本模块用历史赛果做**时间前向**回测:对每个测试日,
 * 只用**严格早于该日**的赛果拟合 Dixon-Coles(防泄漏),预测当日每场,
 * 跟真实赛果比对,累计胜平负命中率 + Brier + RPS + LogLoss。
 *
 * 这是对模型**核心概率引擎**的诚实评估(纯 DC,无赔率泄漏);竞彩实战还会
 * 叠加赔率+信号融合,但本回测专测"模型自身预测力"的下限。
 */

import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { fitFromFixtureStore, predictFromFitted } from "./dixon-coles-engine.js";

const OUTCOMES = ["home", "draw", "away"];

function actualOutcome(result) {
  if (result.home > result.away) return "home";
  if (result.home < result.away) return "away";
  return "draw";
}

function brierScore(probs, actual) {
  let s = 0;
  for (const o of OUTCOMES) {
    const y = actual === o ? 1 : 0;
    s += (probs[o] - y) ** 2;
  }
  return s;
}

// Ranked Probability Score(胜平负按有序 home>draw>away 处理)
function rankedProbabilityScore(probs, actual) {
  const order = ["home", "draw", "away"];
  const p = order.map((o) => probs[o]);
  const a = order.map((o) => (actual === o ? 1 : 0));
  let cumP = 0;
  let cumA = 0;
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) {
    cumP += p[i];
    cumA += a[i];
    s += (cumP - cumA) ** 2;
  }
  return s / (order.length - 1);
}

function logLoss(probs, actual) {
  const eps = 1e-12;
  return -Math.log(Math.max(eps, probs[actual]));
}

/**
 * @param {Object} opts
 *   testDates: 最多回测多少个最近的测试日(default 50)
 *   minTrainMatches: 训练集最少场次门槛(default 200)
 *   maxDates: 每次拟合回看多少日(传给 fitFromFixtureStore,default 240)
 */
export function runWalkForwardBacktest(opts = {}) {
  const maxTestDates = opts.testDates ?? 50;
  const minTrainMatches = opts.minTrainMatches ?? 200;
  const maxDates = opts.maxDates ?? 240;

  // listFixtureDates 是 DESC(最新在前);取有赛果的日期
  const datesDesc = listFixtureDates();
  const datesWithResults = [];
  for (const date of datesDesc) {
    const { fixtures } = loadFixtures(date);
    const withResult = (fixtures || []).filter(
      (f) => f.result && Number.isFinite(Number(f.result.home)) && Number.isFinite(Number(f.result.away))
    );
    if (withResult.length) datesWithResults.push({ date, matches: withResult });
  }

  const agg = { tested: 0, hit: 0, brier: 0, rps: 0, logLoss: 0, coldStartPreds: 0, skippedDates: 0 };
  const byConfidence = {}; // 校准:预测最高概率分桶 → 实际命中率
  const buckets = [[0.33, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.01]];
  for (const [lo, hi] of buckets) byConfidence[`${Math.round(lo * 100)}-${Math.round(hi * 100)}`] = { n: 0, predSum: 0, hit: 0 };

  let usedDates = 0;
  // datesWithResults 是 DESC;从最近往前取测试日(每个都用更早的数据拟合)
  for (const { date, matches } of datesWithResults) {
    if (usedDates >= maxTestDates) break;
    const fit = fitFromFixtureStore({ beforeDate: date, maxDates });
    if (!fit?.usable || fit.coldStart || (fit.matches ?? 0) < minTrainMatches) {
      agg.skippedDates++;
      continue;
    }
    usedDates++;
    for (const f of matches) {
      const pred = predictFromFitted(fit, { homeTeam: f.homeTeam, awayTeam: f.awayTeam });
      if (!pred?.probabilities) continue;
      const probs = pred.probabilities;
      const actual = actualOutcome(f.result);
      const top = OUTCOMES.reduce((a, b) => (probs[b] > probs[a] ? b : a), "home");
      const isHit = top === actual;
      agg.tested++;
      if (isHit) agg.hit++;
      if (pred.coldStart) agg.coldStartPreds++;
      agg.brier += brierScore(probs, actual);
      agg.rps += rankedProbabilityScore(probs, actual);
      agg.logLoss += logLoss(probs, actual);
      const topProb = probs[top];
      for (const [lo, hi] of buckets) {
        if (topProb >= lo && topProb < hi) {
          const key = `${Math.round(lo * 100)}-${Math.round(hi * 100)}`;
          byConfidence[key].n++;
          byConfidence[key].predSum += topProb;
          if (isHit) byConfidence[key].hit++;
          break;
        }
      }
    }
  }

  const n = agg.tested || 1;
  const reliability = {};
  for (const [k, v] of Object.entries(byConfidence)) {
    reliability[k] = {
      samples: v.n,
      predicted: v.n ? round(v.predSum / v.n) : null,
      actual: v.n ? round(v.hit / v.n) : null,
      gap: v.n ? round(v.hit / v.n - v.predSum / v.n) : null
    };
  }

  return {
    testDatesUsed: usedDates,
    skippedDates: agg.skippedDates,
    tested: agg.tested,
    accuracy: round(agg.hit / n),
    brier: round(agg.brier / n),
    rps: round(agg.rps / n),
    logLoss: round(agg.logLoss / n),
    coldStartPredRate: round(agg.coldStartPreds / n),
    reliability,
    note: "纯 Dixon-Coles 模型核心(无赔率/信号融合)在历史赛果上的时间前向命中率;胜平负三分类随机基线≈0.33,赔率隐含上限≈0.50-0.55。"
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
