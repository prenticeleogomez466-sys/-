/**
 * 赔率版 Walk-Forward 回测(V 档 — 实战级"全融合"对比)
 * ────────────────────────────────────────────────────────────
 * 数据源:football-data.co.uk(赛果 + 赔率,训练/测试同源、命名自洽)。
 * 终于能把**赔率隐含概率**纳入对比,跑出 prediction-engine 实战路径的真实表现:
 *   market           —— 市场赔率隐含概率(去 vig)= 要打败的基准
 *   dc               —— 纯 Dixon-Coles
 *   blend            —— blendWithOdds(market, dc) = 实战 prior
 *   blend+fusion     —— + 贝叶斯信号融合(h2h/streak/clean-sheet/fatigue/赛季阶段)
 *   blend+fusion+cal —— + calibration 收缩
 *
 * 防泄漏:每个测试日只用严格更早的比赛拟合 DC + 装配 context。
 * 诚实定位:市场赔率含全部公开信息(伤停/阵容/盘口),极难打败;能接近/打平
 * 已是好结果。本回测量化"模型+融合相对市场还差多少"。
 */

import { fitFromMatches, predictFromFitted, blendWithOdds } from "./dixon-coles-engine.js";
import { loadFootballDataMatches } from "./footballdata-loader.js";
import { canonicalTeamName } from "./team-aliases.js";
import { buildFusionContext } from "./fusion-context-builder.js";
import { fuseSignals } from "./signal-fusion-layer.js";
import { calibrateProbabilities } from "./model-calibration.js";

const OUTCOMES = ["home", "draw", "away"];
const BUCKETS = [[0.33, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.01]];

function actualOutcome(hg, ag) {
  if (hg > ag) return "home";
  if (hg < ag) return "away";
  return "draw";
}
function brier(p, a) { return OUTCOMES.reduce((s, o) => s + (p[o] - (a === o ? 1 : 0)) ** 2, 0); }
function rps(p, a) {
  const ord = ["home", "draw", "away"];
  let cp = 0, ca = 0, s = 0;
  for (let i = 0; i < 2; i++) { cp += p[ord[i]]; ca += a === ord[i] ? 1 : 0; s += (cp - ca) ** 2; }
  return s / 2;
}
function logLoss(p, a) { return -Math.log(Math.max(1e-12, p[a])); }
function round(v) { return Math.round(v * 10000) / 10000; }

// 选择性推荐 hit-vs-coverage:只推 blend top-prob ≥ 阈值的比赛,看推荐命中率随覆盖率的权衡。
// 实际推荐时设一个阈值,命中率↑但覆盖率(能推几场)↓。诚实展示这个 trade-off。
function selectiveCoverage(samples, thresholds = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75]) {
  const total = samples.length || 1;
  return {
    total: samples.length,
    curve: thresholds.map((t) => {
      const sel = samples.filter((s) => s.topProb >= t);
      const hit = sel.filter((s) => s.hit).length;
      return {
        threshold: t,
        recommended: sel.length,
        coverage: round(sel.length / total),
        hitRate: sel.length ? round(hit / sel.length) : null
      };
    })
  };
}

function makeAcc() {
  const buckets = {};
  for (const [lo, hi] of BUCKETS) buckets[`${Math.round(lo * 100)}-${Math.round(hi * 100)}`] = { n: 0, predSum: 0, hit: 0 };
  return { n: 0, hit: 0, brier: 0, rps: 0, logLoss: 0, buckets };
}
function record(acc, p, a) {
  const top = OUTCOMES.reduce((x, y) => (p[y] > p[x] ? y : x), "home");
  const hit = top === a;
  acc.n++; if (hit) acc.hit++;
  acc.brier += brier(p, a); acc.rps += rps(p, a); acc.logLoss += logLoss(p, a);
  for (const [lo, hi] of BUCKETS) {
    if (p[top] >= lo && p[top] < hi) {
      const b = acc.buckets[`${Math.round(lo * 100)}-${Math.round(hi * 100)}`];
      b.n++; b.predSum += p[top]; if (hit) b.hit++; break;
    }
  }
}
function finalize(acc) {
  const n = acc.n || 1;
  const reliability = {};
  for (const [k, v] of Object.entries(acc.buckets)) {
    reliability[k] = { samples: v.n, predicted: v.n ? round(v.predSum / v.n) : null, actual: v.n ? round(v.hit / v.n) : null, gap: v.n ? round(v.hit / v.n - v.predSum / v.n) : null };
  }
  return { tested: acc.n, accuracy: round(acc.hit / n), brier: round(acc.brier / n), rps: round(acc.rps / n), logLoss: round(acc.logLoss / n), reliability };
}

/**
 * @param {Object} opts
 *   testDates: 回测最近多少个测试日(default 40)
 *   minTrainMatches: 训练集门槛(default 300)
 *   maxTrainMatches: 每次拟合最多用多少最近场次(控速,default 1500)
 *   leagues/seasons: 透传 football-data 加载器
 */
export async function runWalkForwardWithOdds(opts = {}) {
  const maxTestDates = opts.testDates ?? 40;
  const minTrainMatches = opts.minTrainMatches ?? 300;
  const maxTrainMatches = opts.maxTrainMatches ?? 1500;

  const loaded = await loadFootballDataMatches({ leagues: opts.leagues, seasons: opts.seasons, fetch: opts.fetch });
  if (!loaded.ok) return { ok: false, reason: "football-data 加载失败(网络?)", arms: null };

  // 预计算 canonical,供 DC 拟合 + context 装配统一命名
  const matches = loaded.matches.map((m) => ({
    ...m,
    homeCanon: canonicalTeamName(m.home),
    awayCanon: canonicalTeamName(m.away)
  }));

  // 按日期升序;取末尾的若干测试日
  const dates = [...new Set(matches.map((m) => m.date))].sort();
  const testDates = dates.slice(-maxTestDates);
  const firstTestDate = testDates[0];

  const arms = { market: makeAcc(), dc: makeAcc(), dcShot: makeAcc(), blend: makeAcc(), blendShot: makeAcc(), blendFusion: makeAcc(), blendFusionCal: makeAcc(), blendFusionLineMove: makeAcc() };
  const coverageSamples = []; // 选择性推荐:blend 臂每场 {topProb, hit},供 hit-vs-coverage 曲线
  let usedDates = 0, skipped = 0, noOdds = 0, fusionApplied = 0, lineMoveFired = 0, shotApplied = 0;

  for (const date of testDates) {
    const prior = matches.filter((m) => m.date < date);
    if (prior.length < minTrainMatches) { skipped++; continue; }
    const train = prior.slice(-maxTrainMatches);
    const fit = fitFromMatches(train, { referenceDate: date });
    if (!fit?.usable) { skipped++; continue; }
    // shot-regressed 臂(分析师 P0):同一训练集,把进球向射门期望回归去噪后拟合。
    const fitShot = fitFromMatches(train, { referenceDate: date, goalSignal: "shot-regressed", shotWeight: opts.shotWeight ?? 0.5 });
    if (fitShot?.shotApplied) shotApplied += fitShot.shotApplied;
    usedDates++;
    const histForCtx = prior; // 已是 {date,homeTeam,awayTeam,homeCanon,awayCanon,homeGoals,awayGoals}
    const dayMatches = matches.filter((m) => m.date === date);
    for (const m of dayMatches) {
      const actual = actualOutcome(m.homeGoals, m.awayGoals);
      const fixture = { id: `${date}-${m.homeCanon}-${m.awayCanon}`, homeTeam: m.home, awayTeam: m.away, competition: m.league, date };

      const pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away });
      if (!pred?.probabilities) continue;
      const dcProbs = pred.probabilities;
      record(arms.dc, dcProbs, actual);

      // shot-regressed 纯 DC
      const predShot = predictFromFitted(fitShot, { homeTeam: m.home, awayTeam: m.away });
      if (predShot?.probabilities) record(arms.dcShot, predShot.probabilities, actual);

      if (!m.odds) { noOdds++; continue; } // 无赔率的场次不计入 market/blend 臂
      record(arms.market, m.odds, actual);

      const blended = blendWithOdds(m.odds, pred, { competition: m.league });
      const blendProbs = blended.probabilities ?? m.odds;
      record(arms.blend, blendProbs, actual);
      {
        const top = OUTCOMES.reduce((x, y) => (blendProbs[y] > blendProbs[x] ? y : x), "home");
        coverageSamples.push({ topProb: blendProbs[top], hit: top === actual });
      }

      // market + shot-regressed DC
      if (predShot?.probabilities) {
        const blendedShot = blendWithOdds(m.odds, predShot, { competition: m.league });
        record(arms.blendShot, blendedShot.probabilities ?? m.odds, actual);
      }

      const ctx = buildFusionContext(fixture, histForCtx);
      const fusion = fuseSignals(blendProbs, fixture, {}, ctx);
      if (fusion.applied) fusionApplied++;
      record(arms.blendFusion, fusion.probabilities, actual);

      const cal = calibrateProbabilities(fusion.probabilities, undefined, { fixture, hasMarketPrior: true });
      record(arms.blendFusionCal, cal.probabilities ?? fusion.probabilities, actual);

      // 第 6 臂(X 档):+ 盘口移动信号。prior 仍用开盘 blend,信号把它朝收盘 sharp 价微调。
      // 诚实测量:收盘比开盘准 +0.64pp,这条信号能恢复多少?(收盘只在 kickoff 已知 → 这是上限)
      const ctxLM = { ...ctx, openingOdds: m.odds, currentOdds: m.oddsClose ?? m.odds };
      const fusionLM = fuseSignals(blendProbs, fixture, {}, ctxLM);
      if (fusionLM.evidence?.some((e) => e.name === "line-movement")) lineMoveFired++;
      const calLM = calibrateProbabilities(fusionLM.probabilities, undefined, { fixture, hasMarketPrior: true });
      record(arms.blendFusionLineMove, calLM.probabilities ?? fusionLM.probabilities, actual);
    }
  }

  return {
    ok: true,
    source: "football-data.co.uk",
    loadedMatches: matches.length,
    withOdds: loaded.withOdds,
    byLeague: loaded.byLeague,
    testDatesUsed: usedDates,
    skippedDates: skipped,
    noOddsMatches: noOdds,
    fusionAppliedRate: round(fusionApplied / (arms.blendFusion.n || 1)),
    lineMoveFiredRate: round(lineMoveFired / (arms.blendFusionLineMove.n || 1)),
    shotRegressedSamples: shotApplied,
    selectiveCoverage: selectiveCoverage(coverageSamples),
    arms: {
      market: finalize(arms.market),
      dc: finalize(arms.dc),
      dcShot: finalize(arms.dcShot),
      blend: finalize(arms.blend),
      blendShot: finalize(arms.blendShot),
      blendFusion: finalize(arms.blendFusion),
      blendFusionCal: finalize(arms.blendFusionCal),
      blendFusionLineMove: finalize(arms.blendFusionLineMove)
    },
    note: "market=市场赔率隐含(基准,含全部公开信息,极难打败);dc/dcShot=纯 DC(进球 vs 射门去噪);blend/blendShot=赔率+对应 DC;后三臂叠加融合/校准。"
  };
}
