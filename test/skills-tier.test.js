import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildConformalCalibrator, buildBucketedConformalCalibrator } from "../src/conformal-prediction.js";
import { computeCLV, buildCLVTracker } from "../src/clv-tracker.js";
import { classifyWaterLevel, analyzeAsianHandicapWater, analyzeMultipleBookmakers } from "../src/asian-handicap-water.js";
import { decomposeProbability } from "../src/feature-importance.js";
import { computeRiskOfRuinFormula, simulateRiskOfRuin, analyzeDrawdown, shouldStop } from "../src/bankroll-risk-management.js";

describe("conformal-prediction", () => {
  it("rejects insufficient samples", () => {
    const r = buildConformalCalibrator([{ favoriteProbability: 0.5, hit: 1 }]);
    assert.equal(r.ok, false);
  });

  it("builds 90% prediction interval", () => {
    const rows = [];
    for (let i = 0; i < 50; i++) {
      // 模型给概率 0.5,实际 50% 命中(完美校准)
      rows.push({ favoriteProbability: 0.5, hit: i < 25 ? 1 : 0 });
    }
    const cal = buildConformalCalibrator(rows);
    assert.equal(cal.ok, true);
    const interval = cal.predictionInterval(0.55);
    assert.ok(interval.lower <= 0.55);
    assert.ok(interval.upper >= 0.55);
    assert.ok(interval.width > 0);
  });

  it("bucketed conformal returns bucket info", () => {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ favoriteProbability: 0.55, hit: i < 22 ? 1 : 0 });
      rows.push({ favoriteProbability: 0.75, hit: i < 30 ? 1 : 0 });
    }
    const cal = buildBucketedConformalCalibrator(rows, { minBucketSamples: 10 });
    assert.equal(cal.ok, true);
    const r = cal.predictionInterval(0.55);
    assert.ok(r);
    assert.ok(r.bucket);
  });
});

describe("clv-tracker", () => {
  it("computeCLV positive when closing < bet odds", () => {
    // 下注 2.10,收盘 1.95 → 庄家压低 → 我们抓到价
    const r = computeCLV(2.10, 1.95);
    assert.ok(r.clv > 0, `clv=${r.clv}`);
    assert.ok(["positive", "strong-positive"].includes(r.verdict));
  });

  it("computeCLV negative when closing > bet odds", () => {
    // 下注 1.95,收盘 2.10 → 我们追的高 → 输价
    const r = computeCLV(1.95, 2.10);
    assert.ok(r.clv < 0);
    assert.ok(["negative", "neutral"].includes(r.verdict));
  });

  it("computeCLV invalid for bad input", () => {
    assert.equal(computeCLV(1.0, 2.0).clv, null);
    assert.equal(computeCLV("foo", "bar").clv, null);
  });

  it("tracker summary positive when most bets beat closing", () => {
    const t = buildCLVTracker();
    for (let i = 0; i < 10; i++) {
      t.recordBet({ fixtureId: `f${i}`, outcome: "home", betOdds: 2.10 });
      t.recordClose({ fixtureId: `f${i}`, outcome: "home", closingOdds: 1.95 });
    }
    const s = t.summary();
    assert.equal(s.ok, true);
    assert.equal(s.samples, 10);
    assert.equal(s.positiveRate, 1);
    assert.equal(s.longTermProfitable, true);
  });
});

describe("asian-handicap-water", () => {
  it("classifyWaterLevel buckets correctly", () => {
    assert.equal(classifyWaterLevel(0.70).level, "very-low");
    assert.equal(classifyWaterLevel(0.85).level, "low");
    assert.equal(classifyWaterLevel(0.95).level, "mid-low");   // 0.95 < 0.96 cut = mid-low
    assert.equal(classifyWaterLevel(1.00).level, "neutral");   // 0.96 <= x <= 1.05
    assert.equal(classifyWaterLevel(1.10).level, "mid-high");
    assert.equal(classifyWaterLevel(1.30).level, "very-high");
  });

  it("analyzeAsianHandicapWater detects 主队降水 (warning sign)", () => {
    const r = analyzeAsianHandicapWater({
      earlyHome: 0.95, earlyAway: 0.95, line: -1,
      lateHome: 0.82, lateAway: 1.10
    });
    assert.equal(r.movement, "主队降水");
    assert.equal(r.signal, "danger-home");
    assert.ok(r.implication.includes("dangerous"));
  });

  it("analyzeAsianHandicapWater detects 平稳", () => {
    const r = analyzeAsianHandicapWater({
      earlyHome: 0.95, earlyAway: 0.95, line: 0,
      lateHome: 0.96, lateAway: 0.94
    });
    assert.equal(r.movement, "水位平稳");
  });

  it("analyzeMultipleBookmakers consensus", () => {
    const r = analyzeMultipleBookmakers([
      { bookmaker: "皇冠", earlyHome: 0.95, earlyAway: 0.95, lateHome: 0.82, lateAway: 1.10, line: -1 },
      { bookmaker: "澳门", earlyHome: 0.94, earlyAway: 0.96, lateHome: 0.83, lateAway: 1.08, line: -1 },
      { bookmaker: "立博", earlyHome: 0.95, earlyAway: 0.95, lateHome: 0.85, lateAway: 1.05, line: -1 }
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.consensus.signal, "danger-home");
    assert.equal(r.consistency, 1);  // 3/3 一致
  });
});

describe("feature-importance", () => {
  it("decomposeProbability returns baseline + signals", () => {
    const r = decomposeProbability({
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
      baseProbabilities: { home: 0.50, draw: 0.28, away: 0.22 },
      probabilityAdjustment: {
        signals: [
          { name: "Elo", score: 0.15 },
          { name: "xG", score: 0.08 }
        ],
        calibration: { adjustment: 0.02 }
      }
    });
    assert.ok(r);
    assert.ok(r.contributions.length >= 4);  // baseline + odds + Elo + xG + calib
    // 最大贡献者排序
    assert.ok(Math.abs(r.contributions[0].probability.home) >= Math.abs(r.contributions[1].probability.home));
  });

  it("decomposeProbability handles ensemble drift", () => {
    const r = decomposeProbability({
      probabilities: { home: 0.50, draw: 0.30, away: 0.20 },
      baseProbabilities: { home: 0.50, draw: 0.30, away: 0.20 },
      ensembleView: {
        methodCount: 5,
        probabilities: { home: 0.40, draw: 0.35, away: 0.25 }
      }
    });
    // Drift -0.10 应该出现在 contributions 里
    const drift = r.contributions.find((c) => c.signal.includes("ensemble"));
    assert.ok(drift);
    assert.ok(drift.probability.home < 0);
  });

  it("decomposeProbability returns null for empty prediction", () => {
    assert.equal(decomposeProbability(null), null);
    assert.equal(decomposeProbability({}), null);
  });
});

describe("bankroll-risk-management", () => {
  it("computeRiskOfRuinFormula: positive edge → low RoR", () => {
    const r = computeRiskOfRuinFormula({ winRate: 0.58, avgWin: 1.0, avgLoss: 1.0, bankrollUnits: 100 });
    assert.equal(r.ok, true);
    assert.ok(r.edge > 0);
    assert.ok(r.riskOfRuin < 0.01, `ror=${r.riskOfRuin}`);
  });

  it("computeRiskOfRuinFormula: negative edge → RoR = 1", () => {
    const r = computeRiskOfRuinFormula({ winRate: 0.45, avgWin: 1.0, avgLoss: 1.0, bankrollUnits: 100 });
    assert.equal(r.riskOfRuin, 1.0);
    assert.ok(r.verdict.includes("破产"));
  });

  it("simulateRiskOfRuin returns reasonable result", () => {
    const r = simulateRiskOfRuin({ winRate: 0.55, avgWin: 1.0, avgLoss: 1.0, bankrollUnits: 50, simulations: 500, maxBets: 200 });
    assert.equal(r.ok, true);
    assert.ok(r.riskOfRuin >= 0 && r.riskOfRuin <= 1);
    assert.ok(r.avgFinalBankroll > 0);
  });

  it("analyzeDrawdown computes max DD", () => {
    const rows = [
      { hit: true, primaryOdds: 2.0, stakeUnitsPer100: 5 },
      { hit: true, primaryOdds: 2.0, stakeUnitsPer100: 5 },
      { hit: false, stakeUnitsPer100: 5 },
      { hit: false, stakeUnitsPer100: 5 },
      { hit: false, stakeUnitsPer100: 5 }
    ];
    const r = analyzeDrawdown(rows, { startBankroll: 100 });
    assert.equal(r.ok, true);
    assert.ok(r.maxDrawdown > 0);
    assert.equal(r.consecutiveLosses, 3);
  });

  it("shouldStop triggers on consecutive losses", () => {
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push({ hit: false, stakeUnitsPer100: 5 });
    const r = shouldStop(rows, { maxConsecLosses: 5 });
    assert.equal(r.stop, true);
    assert.ok(r.reasons.some((s) => s.includes("连败")));
  });

  it("shouldStop does not trigger on healthy run", () => {
    const rows = [
      { hit: true, primaryOdds: 2.0, stakeUnitsPer100: 5 },
      { hit: false, stakeUnitsPer100: 5 },
      { hit: true, primaryOdds: 2.0, stakeUnitsPer100: 5 }
    ];
    const r = shouldStop(rows);
    assert.equal(r.stop, false);
  });
});
