/**
 * Walk-Forward 回测(V 档 — 诚实命中率 + 分层边际贡献)
 * ────────────────────────────────────────────────────────────
 * backtest:evolution 用的是 ledger 已结算预测(冷启动期只有 2 条),用不上
 * 回填的 3600+ 场历史。本模块用历史赛果做**时间前向**回测:对每个测试日,
 * 只用**严格早于该日**的赛果拟合 Dixon-Coles + 装配历史 context(防泄漏),
 * 跟真实赛果比对,累计胜平负命中率 + Brier + RPS + LogLoss。
 *
 * 三臂对比,量化每一层的边际贡献:
 *   A. dc        —— 纯 Dixon-Coles 模型核心
 *   B. fusion    —— DC + 贝叶斯信号融合(h2h/streak/clean-sheet/fatigue/赛季阶段…)
 *   C. calibrated—— B + calibration 收缩(治 65%+ 强热门过度自信)
 */

import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { fitFromFixtureStore, predictFromFitted } from "./dixon-coles-engine.js";
import { loadHistoricalResults, buildFusionContext } from "./fusion-context-builder.js";
import { fuseSignals } from "./signal-fusion-layer.js";
import { calibrateProbabilities } from "./model-calibration.js";

const OUTCOMES = ["home", "draw", "away"];
const BUCKETS = [[0.33, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.01]];

function actualOutcome(result) {
  if (result.home > result.away) return "home";
  if (result.home < result.away) return "away";
  return "draw";
}

function brierScore(probs, actual) {
  let s = 0;
  for (const o of OUTCOMES) s += (probs[o] - (actual === o ? 1 : 0)) ** 2;
  return s;
}

// Ranked Probability Score(胜平负按有序 home>draw>away 处理)
function rankedProbabilityScore(probs, actual) {
  const order = ["home", "draw", "away"];
  let cumP = 0;
  let cumA = 0;
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) {
    cumP += probs[order[i]];
    cumA += actual === order[i] ? 1 : 0;
    s += (cumP - cumA) ** 2;
  }
  return s / (order.length - 1);
}

function logLoss(probs, actual) {
  return -Math.log(Math.max(1e-12, probs[actual]));
}

function makeAcc() {
  const buckets = {};
  for (const [lo, hi] of BUCKETS) buckets[`${Math.round(lo * 100)}-${Math.round(hi * 100)}`] = { n: 0, predSum: 0, hit: 0 };
  return { tested: 0, hit: 0, brier: 0, rps: 0, logLoss: 0, buckets };
}

function record(acc, probs, actual) {
  const top = OUTCOMES.reduce((a, b) => (probs[b] > probs[a] ? b : a), "home");
  const isHit = top === actual;
  acc.tested++;
  if (isHit) acc.hit++;
  acc.brier += brierScore(probs, actual);
  acc.rps += rankedProbabilityScore(probs, actual);
  acc.logLoss += logLoss(probs, actual);
  const topProb = probs[top];
  for (const [lo, hi] of BUCKETS) {
    if (topProb >= lo && topProb < hi) {
      const b = acc.buckets[`${Math.round(lo * 100)}-${Math.round(hi * 100)}`];
      b.n++;
      b.predSum += topProb;
      if (isHit) b.hit++;
      break;
    }
  }
}

function finalize(acc) {
  const n = acc.tested || 1;
  const reliability = {};
  for (const [k, v] of Object.entries(acc.buckets)) {
    reliability[k] = {
      samples: v.n,
      predicted: v.n ? round(v.predSum / v.n) : null,
      actual: v.n ? round(v.hit / v.n) : null,
      gap: v.n ? round(v.hit / v.n - v.predSum / v.n) : null
    };
  }
  return {
    tested: acc.tested,
    accuracy: round(acc.hit / n),
    brier: round(acc.brier / n),
    rps: round(acc.rps / n),
    logLoss: round(acc.logLoss / n),
    reliability
  };
}

/**
 * @param {Object} opts
 *   testDates: 最多回测多少个最近的测试日(default 50)
 *   minTrainMatches: 训练集最少场次门槛(default 200)
 *   maxDates: 每次拟合回看多少日(default 240)
 */
export function runWalkForwardBacktest(opts = {}) {
  const maxTestDates = opts.testDates ?? 50;
  const minTrainMatches = opts.minTrainMatches ?? 200;
  const maxDates = opts.maxDates ?? 240;

  const allHistory = loadHistoricalResults(); // 全量(每场带 date),按日期就地过滤防泄漏
  const datesDesc = listFixtureDates();
  const datesWithResults = [];
  for (const date of datesDesc) {
    const { fixtures } = loadFixtures(date);
    const withResult = (fixtures || []).filter(
      (f) => f.result && Number.isFinite(Number(f.result.home)) && Number.isFinite(Number(f.result.away))
    );
    if (withResult.length) datesWithResults.push({ date, matches: withResult });
  }

  const accDc = makeAcc();
  const accFusion = makeAcc();
  const accCal = makeAcc();
  let usedDates = 0;
  let skippedDates = 0;
  let coldStartPreds = 0;
  let fusionApplied = 0;

  for (const { date, matches } of datesWithResults) {
    if (usedDates >= maxTestDates) break;
    const fit = fitFromFixtureStore({ beforeDate: date, maxDates });
    if (!fit?.usable || fit.coldStart || (fit.matches ?? 0) < minTrainMatches) {
      skippedDates++;
      continue;
    }
    usedDates++;
    const histBefore = allHistory.filter((m) => m.date < date);
    for (const f of matches) {
      const pred = predictFromFitted(fit, { homeTeam: f.homeTeam, awayTeam: f.awayTeam });
      if (!pred?.probabilities) continue;
      const actual = actualOutcome(f.result);
      const fixture = { id: f.id, homeTeam: f.homeTeam, awayTeam: f.awayTeam, competition: f.competition, date };
      if (pred.coldStart) coldStartPreds++;

      // A. 纯 DC
      const probsDc = pred.probabilities;
      record(accDc, probsDc, actual);

      // B. DC + 信号融合(历史 context 让 h2h/streak/clean-sheet/fatigue fire)
      const ctx = buildFusionContext(fixture, histBefore);
      const fusion = fuseSignals(probsDc, fixture, {}, ctx);
      if (fusion.applied) fusionApplied++;
      const probsFusion = fusion.probabilities;
      record(accFusion, probsFusion, actual);

      // C. + calibration 收缩(空 profile → cold-start 路径,对 ≥0.65 强热门收缩)
      const cal = calibrateProbabilities(probsFusion, undefined, { fixture });
      record(accCal, cal.probabilities ?? probsFusion, actual);
    }
  }

  const tested = accDc.tested || 1;
  return {
    testDatesUsed: usedDates,
    skippedDates,
    coldStartPredRate: round(coldStartPreds / tested),
    fusionAppliedRate: round(fusionApplied / tested),
    // 顶层 = 纯 DC(向后兼容)
    ...finalize(accDc),
    arms: {
      dc: finalize(accDc),
      fusion: finalize(accFusion),
      calibrated: finalize(accCal)
    },
    note: "三臂对比:dc=纯模型核心,fusion=+贝叶斯信号融合,calibrated=+65%+收缩。胜平负随机基线≈0.33,纯模型(无赔率)上限≈0.50-0.55。"
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
