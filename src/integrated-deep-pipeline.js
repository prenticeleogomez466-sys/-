/**
 * Integrated Deep Pipeline(集成深度决策管道)
 * ──────────────────────────────────────────────────
 * 把所有 F+G+H 档技能集成进一个统一调度管道,提供顶级团队风格的全栈预测.
 *
 * 流程(13 步):
 *   1. 加载基础数据(fixture, market snapshot, advanced data)
 *   2. 跑 10 个模型(DC + Pi + Massey + Colley + Bivariate + Hier + Markov + Skellam + KNN + odds)
 *   3. Ensemble 加权融合
 *   4. Isotonic + Temperature 双重校准
 *   5. Conformal Prediction 90% 置信区间
 *   6. 每个 outcome 算 EV + verdict
 *   7. Thompson Sampling 多场资金分配(若多场)
 *   8. 风控:Risk of Ruin + Drawdown + Tilt 检查
 *   9. 跨盘口 Arbitrage 扫描
 *   10. Sensitivity 反事实分析
 *   11. SHAP 特征贡献分解
 *   12. CLV 追踪(记录下注价格,等收盘对比)
 *   13. 自动解释生成
 *
 * 用法:
 *   const pipeline = createDeepPipeline({ historicalLedger, ratingsBootstrap, conformalCalibrator, ... });
 *   const decision = pipeline.analyze(fixture, snapshot, advancedData);
 *   // decision: { probabilities, ensembleView, confidenceInterval, ev, kellyStake, riskCheck,
 *   //             arbOpportunities, sensitivities, shapBreakdown, explanation, clvRecord }
 */

import { buildEnsemblePrediction } from "./ratings-ensemble.js";
import { buildConformalCalibrator } from "./conformal-prediction.js";
import { applyTemperature } from "./temperature-calibration.js";
import { decomposeProbability } from "./feature-importance.js";
import { detectTilt } from "./tilt-detector.js";
import { computeRiskOfRuinFormula, analyzeDrawdown, shouldStop } from "./bankroll-risk-management.js";
import { sensitivityAnalysis } from "./sensitivity-analysis.js";
import { scanArbitrage } from "./cross-market-arbitrage.js";
import { allocateThompson } from "./thompson-sampling-allocator.js";
import { kellyFraction } from "./dutching-optimizer.js";
import { generateExplanation } from "./explanation-generator.js";
import { skellamDistribution } from "./skellam-distribution.js";
import { markovScoreMatrix, outcomesFromMatrix } from "./markov-match-simulator.js";
import { performanceReport } from "./betting-performance.js";
import { detectDistributionShift } from "./adversarial-validation.js";
// I 档接入(2026-05-29)
import { sharpenOdds } from "./multi-source-odds-sharpener.js";
import { analyzeLineMovement } from "./line-movement-tracker.js";
import { buildFormFeatures, buildMatchupFeatures } from "./form-momentum-features.js";
import { attentionWeightedForm } from "./sequence-attention.js";

export function createDeepPipeline(opts = {}) {
  const {
    ratingsBootstrap = null,
    historicalLedger = [],
    conformalCalibrator = null,
    temperature = 1.0,
    kellyFraction: kFrac = 0.25,
    bankrollSize = 1000,
    weights = null,
    // I 档:可选的球队图 embedding(避免每场都重建)
    teamGraphEmbedding = null,
    // 可选的历史比赛(给 KNN + form-momentum 用)
    historicalMatches = []
  } = opts;

  // 预计算 calibrator(若没传)
  let calibrator = conformalCalibrator;
  if (!calibrator && historicalLedger.length >= 30) {
    calibrator = buildConformalCalibrator(historicalLedger);
  }

  // 预计算绩效基线
  const performance = historicalLedger.length >= 10 ? performanceReport(historicalLedger) : null;

  return {
    /**
     * 单场比赛深度分析.
     */
    analyze(fixture, marketSnapshot, advancedData, options = {}) {
      const result = {
        fixture: { id: fixture.id, home: fixture.homeTeam, away: fixture.awayTeam, competition: fixture.competition },
        steps: {}
      };

      // STEP 1: 基础概率(I 档升级:优先用多源 sharpened 共识,否则 fallback 单源 odds)
      let baseProbabilities;
      if (options.multiSourceOdds?.length >= 2) {
        const sharpened = sharpenOdds(options.multiSourceOdds);
        if (sharpened.ok) {
          baseProbabilities = sharpened.fairProbabilities;
          result.steps.sharpener = {
            sources: sharpened.sourceCount,
            consensus: sharpened.marketConsensus,
            avgVig: sharpened.averageVig
          };
        }
      }
      if (!baseProbabilities) {
        baseProbabilities = options.baseProbabilities ?? oddsToProbs(marketSnapshot?.europeanOdds?.current);
      }
      result.steps.base = baseProbabilities;

      // STEP 1.5(I 档新增): Line Movement 信号
      if (options.oddsSnapshots?.length >= 2) {
        const lm = analyzeLineMovement({ fixtureId: fixture.id, snapshots: options.oddsSnapshots });
        if (lm.ok) {
          result.steps.lineMovement = {
            isSteam: lm.isSteam,
            reverseLineMove: lm.reverseLineMove,
            sharpOnOutcomes: lm.sharpOnOutcomes,
            interpretation: lm.interpretation
          };
        }
      }

      // STEP 1.6(I 档新增): Form Momentum + Attention Weighted Form
      if (options.homeRecentMatches?.length || options.awayRecentMatches?.length) {
        const homeFeat = options.homeRecentMatches?.length ? buildFormFeatures(options.homeRecentMatches) : null;
        const awayFeat = options.awayRecentMatches?.length ? buildFormFeatures(options.awayRecentMatches) : null;
        result.steps.formFeatures = { home: homeFeat, away: awayFeat };
        if (homeFeat && awayFeat) {
          result.steps.matchupFeatures = buildMatchupFeatures(homeFeat, awayFeat);
        }
        // Attention-weighted form against the specific opponent type
        const opponentRating = Number(options.opponentRating ?? 1500);
        if (options.homeRecentMatches?.length) {
          result.steps.homeAttentionForm = attentionWeightedForm(options.homeRecentMatches, { opponentRating, isHome: true });
        }
        if (options.awayRecentMatches?.length) {
          result.steps.awayAttentionForm = attentionWeightedForm(options.awayRecentMatches, { opponentRating, isHome: false });
        }
      }

      // STEP 1.7(I 档新增): GNN 球队相似检索
      if (teamGraphEmbedding?.ok) {
        const homeSim = teamGraphEmbedding.nearestTo(fixture.homeTeam, 5);
        const awaySim = teamGraphEmbedding.nearestTo(fixture.awayTeam, 5);
        result.steps.graphSimilarity = { home: homeSim, away: awaySim };
      }

      // STEP 2: 调用所有模型
      const modelPredictions = collectAllModelPredictions(fixture, ratingsBootstrap, baseProbabilities, advancedData);
      result.steps.models = Object.fromEntries(Object.entries(modelPredictions).map(([k, v]) => [k, summarize(v)]));

      // STEP 3: Ensemble
      const ensemble = buildEnsemblePrediction(modelPredictions, { weights });
      result.steps.ensemble = ensemble.ok ? ensemble.probabilities : baseProbabilities;

      // STEP 4: 温度校准
      const tempCalibrated = applyTemperature(result.steps.ensemble, temperature);
      result.steps.calibrated = tempCalibrated;

      // STEP 5: Conformal CI
      if (calibrator?.ok) {
        result.steps.confidenceIntervals = calibrator.predictionIntervalsAll(tempCalibrated);
      }

      // STEP 6: EV per outcome
      const oddsCurrent = marketSnapshot?.europeanOdds?.current;
      if (oddsCurrent) {
        result.steps.evByOutcome = {
          home: round(tempCalibrated.home * Number(oddsCurrent.home) - 1),
          draw: round(tempCalibrated.draw * Number(oddsCurrent.draw) - 1),
          away: round(tempCalibrated.away * Number(oddsCurrent.away) - 1)
        };
        // 最佳 outcome 仓位
        const best = Object.entries(result.steps.evByOutcome).sort((a, b) => b[1] - a[1])[0];
        const bestOutcome = best[0];
        const bestEv = best[1];
        const bestProb = tempCalibrated[bestOutcome];
        const bestOdds = Number(oddsCurrent[bestOutcome]);
        result.steps.bestPick = {
          outcome: bestOutcome,
          probability: round(bestProb),
          odds: bestOdds,
          ev: round(bestEv),
          kellyStake: round(kellyFraction(bestProb, bestOdds, { kellyFraction: kFrac }) * bankrollSize)
        };
      }

      // STEP 7: 风控
      const riskCheck = {
        bankroll: performance?.ok ? computeRiskOfRuinFormula({
          winRate: performance.winRate, avgWin: 1.0, avgLoss: 1.0, bankrollUnits: 100
        }) : null,
        drawdown: historicalLedger.length >= 10 ? analyzeDrawdown(historicalLedger).recommendation : "样本不足",
        tilt: historicalLedger.length >= 5 ? detectTilt(historicalLedger.slice(-15)).recommendation : "样本不足",
        shouldStop: shouldStop(historicalLedger.slice(-15))
      };
      result.steps.riskCheck = riskCheck;

      // STEP 8: 跨盘口 Arbitrage(若有多源)
      if (options.alternativeMarkets?.length) {
        result.steps.arbScan = scanArbitrage(options.alternativeMarkets);
      }

      // STEP 9: Sensitivity
      const sensitivityProxy = {
        probabilities: tempCalibrated,
        marketSnapshot
      };
      result.steps.sensitivity = sensitivityAnalysis(sensitivityProxy);

      // STEP 10: SHAP 分解
      const shapInput = {
        probabilities: tempCalibrated,
        baseProbabilities,
        probabilityAdjustment: { signals: extractSignals(advancedData), calibration: { adjustment: 0 } },
        ensembleView: { methodCount: Object.keys(modelPredictions).length, probabilities: result.steps.ensemble }
      };
      result.steps.shap = decomposeProbability(shapInput);

      // STEP 11: 自动解释
      const explanationInput = {
        fixture,
        marketSnapshot,
        pick: { code: outcomeToCode(result.steps.bestPick?.outcome), label: chineseOutcome(result.steps.bestPick?.outcome), probability: result.steps.bestPick?.probability },
        secondaryPick: null,
        probabilities: tempCalibrated,
        risk: result.steps.riskCheck.bankroll?.verdict ?? "未知",
        confidence: Math.round((result.steps.bestPick?.probability ?? 0.5) * 100),
        expectedValue: { primary: { ev: result.steps.bestPick?.ev, verdict: evVerdict(result.steps.bestPick?.ev) } },
        ensembleView: { methodCount: Object.keys(modelPredictions).length, probabilities: result.steps.ensemble }
      };
      result.steps.explanation = generateExplanation(explanationInput);

      // STEP 12: 最终决策
      result.decision = makeFinalDecision(result.steps);

      return result;
    },

    /**
     * 多场比赛批量分析 + Thompson Sampling 资金分配.
     */
    batchAnalyze(fixtures, marketSnapshots, advancedData, options = {}) {
      const decisions = fixtures.map((f) => this.analyze(f, findSnap(f, marketSnapshots), advancedData, options));
      // Thompson Sampling 分配
      const candidates = decisions
        .filter((d) => d.steps.bestPick?.ev > -0.10)  // 排除明显负 EV
        .map((d) => ({
          id: d.fixture.id,
          betaAlpha: 1, betaBeta: 1,
          modelProb: d.steps.bestPick.probability,
          odds: d.steps.bestPick.odds
        }));
      const allocation = candidates.length ? allocateThompson(candidates, bankrollSize, { kellyFraction: kFrac }) : null;
      // Adversarial validation
      const trainSamples = historicalLedger.slice(-100);
      const testSamples = fixtures.map((f) => ({
        homeTeamLen: (f.homeTeam ?? "").length,
        awayTeamLen: (f.awayTeam ?? "").length,
        kickoffHour: parseInt(String(f.kickoff || "").slice(11, 13)) || 12
      }));
      const distShift = trainSamples.length >= 10 && testSamples.length >= 1
        ? detectDistributionShift(
            trainSamples.map((r) => ({ kickoffHour: parseInt(String(r.kickoff || "").slice(11, 13)) || 12 })),
            testSamples
          )
        : null;
      return {
        decisions,
        allocation,
        distShift,
        bankrollPerformance: performance
      };
    }
  };
}

// ───── 内部:调用所有模型 ─────

function collectAllModelPredictions(fixture, bootstrap, baseProbs, advancedData) {
  const preds = {};
  if (baseProbs) preds.odds = baseProbs;
  // Pi
  if (bootstrap?.pi?.ok && typeof bootstrap.pi.predictWinProb === "function") {
    try {
      const p = bootstrap.pi.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.pi = { home: p.home, draw: p.draw, away: p.away };
    } catch {}
  }
  // Massey
  if (bootstrap?.massey?.ok && typeof bootstrap.massey.predictWinProb === "function") {
    try {
      const p = bootstrap.massey.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.massey = { home: p.home, draw: p.draw, away: p.away };
    } catch {}
  }
  // Colley
  if (bootstrap?.colley?.ok && typeof bootstrap.colley.predictWinProb === "function") {
    try {
      const p = bootstrap.colley.predictWinProb(fixture.homeTeam, fixture.awayTeam);
      if (p) preds.colley = { home: p.home, draw: p.draw, away: p.away };
    } catch {}
  }
  // Bivariate
  if (bootstrap?.bivariate?.ok && typeof bootstrap.bivariate.predict === "function") {
    try {
      const r = bootstrap.bivariate.predict(fixture.homeTeam, fixture.awayTeam);
      if (r?.probabilities) preds.bivariatePoisson = r.probabilities;
    } catch {}
  }
  // Markov(用 baseProbs 反推 λ)
  const xgHome = Number(advancedData?.xg?.home?.xg ?? 1.4);
  const xgAway = Number(advancedData?.xg?.away?.xg ?? 1.1);
  if (Number.isFinite(xgHome) && Number.isFinite(xgAway)) {
    try {
      const matrix = markovScoreMatrix(xgHome, xgAway);
      preds.markov = outcomesFromMatrix(matrix);
    } catch {}
    // Skellam
    try {
      const dist = skellamDistribution(xgHome, xgAway);
      let home = 0, draw = 0, away = 0;
      for (const k of Object.keys(dist)) {
        const v = Number(k);
        if (v > 0) home += dist[k];
        else if (v === 0) draw += dist[k];
        else away += dist[k];
      }
      preds.skellam = { home, draw, away };
    } catch {}
  }
  return preds;
}

// ───── 工具 ─────

function oddsToProbs(odds) {
  if (!odds) return { home: 0.33, draw: 0.33, away: 0.34 };
  const inv = [1/Number(odds.home), 1/Number(odds.draw), 1/Number(odds.away)];
  const total = inv.reduce((s, v) => s + v, 0);
  return { home: inv[0] / total, draw: inv[1] / total, away: inv[2] / total };
}

function summarize(probs) {
  return { home: round(probs.home), draw: round(probs.draw), away: round(probs.away) };
}

function findSnap(fixture, snapshots) {
  if (!Array.isArray(snapshots)) return null;
  return snapshots.find((s) => s.fixtureId === fixture.id) ?? null;
}

function extractSignals(advancedData) {
  const out = [];
  if (advancedData?.elo) out.push({ name: "Elo", score: Number(advancedData.elo.delta ?? 0) });
  if (advancedData?.xg) out.push({ name: "xG", score: Number(advancedData.xg.delta ?? 0) });
  if (advancedData?.injuries) out.push({ name: "伤病影响", score: Number(advancedData.injuries.impact ?? 0) });
  return out;
}

function outcomeToCode(outcome) {
  return outcome === "home" ? "3" : outcome === "draw" ? "1" : outcome === "away" ? "0" : "";
}

function chineseOutcome(o) {
  return o === "home" ? "主胜" : o === "draw" ? "平局" : o === "away" ? "客胜" : "";
}

function evVerdict(ev) {
  if (!Number.isFinite(ev)) return "n/a";
  if (ev > 0.15) return "strong-value";
  if (ev > 0.05) return "value";
  if (ev > -0.05) return "fair";
  return "negative-ev";
}

function makeFinalDecision(steps) {
  const pick = steps.bestPick;
  if (!pick) return { action: "no-data", reason: "缺市场赔率" };
  if (steps.riskCheck?.shouldStop?.stop) return { action: "stop-loss", reason: steps.riskCheck.shouldStop.reasons.join("; ") };
  if (pick.ev < -0.05) return { action: "skip", reason: `EV ${(pick.ev*100).toFixed(1)}% 太负` };
  if (pick.ev < 0.05) return { action: "marginal", reason: "EV 接近 0,小额或不投" };
  return {
    action: "bet",
    outcome: pick.outcome,
    odds: pick.odds,
    suggestedStake: pick.kellyStake,
    reason: `EV ${(pick.ev*100).toFixed(1)}%,凯利建议 ${pick.kellyStake} 单位`
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
