import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeExpectedValueLabels } from "../src/prediction-engine.js";
import { buildComboRecommendations } from "../src/combo-builder.js";

describe("computeExpectedValueLabels", () => {
  it("computes positive EV when probability beats implied probability", () => {
    // p=0.55, odds=2.1 -> EV = 0.55 * 2.1 - 1 = 0.155
    const ranked = [
      { code: "3", label: "主胜", probability: 0.55 },
      { code: "1", label: "平局", probability: 0.25 }
    ];
    const snapshot = { europeanOdds: { current: { home: 2.1, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    assert.ok(result);
    assert.equal(result.primary.code, "3");
    assert.ok(Math.abs(result.primary.ev - 0.155) < 0.001, `got EV ${result.primary.ev}`);
    assert.equal(result.primary.valueBet, true);
    // 0.155 > 0.15 阈值,所以 verdict 是 strong-value
    assert.equal(result.primary.verdict, "strong-value");
  });

  it("marks strong-value when EV > 0.15", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.6 }];
    const snapshot = { europeanOdds: { current: { home: 2.5, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    // 0.6 * 2.5 - 1 = 0.5
    assert.equal(result.primary.verdict, "strong-value");
    assert.equal(result.primary.valueBet, true);
  });

  it("marks negative-ev when odds too low", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.50 }];
    const snapshot = { europeanOdds: { current: { home: 1.5, draw: 3.4, away: 6.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    // 0.50 * 1.5 - 1 = -0.25
    assert.equal(result.primary.valueBet, false);
    assert.equal(result.primary.verdict, "negative-ev");
  });

  it("returns null when snapshot has no european odds", () => {
    assert.equal(computeExpectedValueLabels([{ code: "3", label: "主胜", probability: 0.55 }], null), null);
    assert.equal(computeExpectedValueLabels([{ code: "3", label: "主胜", probability: 0.55 }], { europeanOdds: null }), null);
  });

  it("returns ev=null for legs with invalid odds (NaN, 1.0)", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.55 }];
    const snapshot = { europeanOdds: { current: { home: 1.0, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    assert.equal(result.primary.ev, null);
    assert.equal(result.primary.valueBet, false);
  });
});

describe("buildComboRecommendations", () => {
  function fakePrediction({ id, home, away, code, prob, odds, ev }) {
    return {
      fixture: { id, sequence: id, homeTeam: home, awayTeam: away, competition: "测试联赛" },
      probabilities: { home: code === "3" ? prob : 0.2, draw: code === "1" ? prob : 0.2, away: code === "0" ? prob : 0.2 },
      expectedValue: {
        primary: { code, label: code === "3" ? "主胜" : code === "1" ? "平局" : "客胜", odds, ev, valueBet: ev > 0.05, verdict: ev > 0.15 ? "strong-value" : "value" }
      },
      confidence: "medium",
      risk: "medium"
    };
  }

  it("builds 2-leg combos from value bets and ranks by combined EV", () => {
    const predictions = [
      fakePrediction({ id: "f1", home: "A", away: "B", code: "3", prob: 0.6, odds: 2.0, ev: 0.20 }),
      fakePrediction({ id: "f2", home: "C", away: "D", code: "3", prob: 0.55, odds: 2.2, ev: 0.21 }),
      fakePrediction({ id: "f3", home: "E", away: "F", code: "1", prob: 0.32, odds: 3.4, ev: 0.088 })
    ];
    const result = buildComboRecommendations(predictions);
    assert.ok(result.twoLeg.length >= 1, `got ${result.twoLeg.length} combos`);
    // f1+f2: prob = 0.6*0.55 = 0.33, odds = 4.4, EV = 0.33*4.4 - 1 = 0.452
    const top = result.twoLeg[0];
    assert.ok(top.combinedEv > 0.10);
    assert.equal(top.legs.length, 2);
  });

  it("filters out legs outside SP 1.8-3.5 range", () => {
    const predictions = [
      // odds=1.5 — too low
      fakePrediction({ id: "f1", home: "A", away: "B", code: "3", prob: 0.7, odds: 1.5, ev: 0.05 }),
      fakePrediction({ id: "f2", home: "C", away: "D", code: "3", prob: 0.55, odds: 2.2, ev: 0.21 })
    ];
    const result = buildComboRecommendations(predictions);
    // f1 should be filtered, so no 2-leg combo possible
    assert.equal(result.twoLeg.length, 0);
    assert.equal(result.summary.candidatePool, 1);
  });

  it("filters out legs without valueBet flag", () => {
    const predictions = [
      fakePrediction({ id: "f1", home: "A", away: "B", code: "3", prob: 0.4, odds: 2.2, ev: -0.12 }),
      fakePrediction({ id: "f2", home: "C", away: "D", code: "3", prob: 0.55, odds: 2.2, ev: 0.21 })
    ];
    const result = buildComboRecommendations(predictions);
    assert.equal(result.summary.candidatePool, 1);
    assert.equal(result.twoLeg.length, 0);
  });

  it("computes half-kelly stake on combos", () => {
    const predictions = [
      fakePrediction({ id: "f1", home: "A", away: "B", code: "3", prob: 0.6, odds: 2.0, ev: 0.20 }),
      fakePrediction({ id: "f2", home: "C", away: "D", code: "3", prob: 0.55, odds: 2.2, ev: 0.21 })
    ];
    const result = buildComboRecommendations(predictions, { kellyFraction: 0.125 });
    const top = result.twoLeg[0];
    assert.ok(top.kellyStake > 0, `kelly stake ${top.kellyStake}`);
    // full kelly = (0.33 * 3.4 - 0.67) / 3.4 ≈ 0.133; half-kelly fraction 0.125 -> ≈ 0.0166
    assert.ok(top.kellyStake < 0.1, `expected fractional kelly to be small, got ${top.kellyStake}`);
  });

  it("rejects 3-leg combos when joint probability drops below 8%", () => {
    const predictions = [
      fakePrediction({ id: "f1", home: "A", away: "B", code: "3", prob: 0.35, odds: 2.5, ev: -0.125 }),
      fakePrediction({ id: "f2", home: "C", away: "D", code: "3", prob: 0.35, odds: 2.5, ev: -0.125 }),
      fakePrediction({ id: "f3", home: "E", away: "F", code: "3", prob: 0.35, odds: 2.5, ev: -0.125 })
    ];
    // All three legs are EV-negative so they're filtered before combo building
    const result = buildComboRecommendations(predictions);
    assert.equal(result.twoLeg.length, 0);
    assert.equal(result.threeLeg.length, 0);
  });

  it("respects summary fields", () => {
    const result = buildComboRecommendations([]);
    assert.equal(result.summary.minLegOdds, 1.8);
    assert.equal(result.summary.maxLegOdds, 3.5);
    assert.equal(result.summary.kellyFraction, 0.125);
  });
});
