import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  halfFullFromDcResult,
  halfFullProbsFromLambdas,
  scoreFromDcResult
} from "../src/prediction-engine.js";

describe("score from Dixon-Coles topScores", () => {
  it("picks the highest-probability score that matches the outcome code", () => {
    const dcResult = {
      topScores: [
        { score: "0-0", probability: 0.12 },
        { score: "1-0", probability: 0.11 },
        { score: "2-1", probability: 0.10 },
        { score: "2-0", probability: 0.09 },
        { score: "1-1", probability: 0.085 }
      ]
    };
    // Home win (code "3"): best is 1-0 (probability 0.11)
    assert.equal(scoreFromDcResult(dcResult, "3"), "1-0");
    // Draw (code "1"): best is 0-0 (probability 0.12)
    assert.equal(scoreFromDcResult(dcResult, "1"), "0-0");
    // Away win: no away scores in topScores, returns null
    assert.equal(scoreFromDcResult(dcResult, "0"), null);
  });

  it("respects the excluded set so secondary picks differ from primary", () => {
    const dcResult = {
      topScores: [
        { score: "1-0", probability: 0.15 },
        { score: "2-0", probability: 0.11 },
        { score: "2-1", probability: 0.09 }
      ]
    };
    assert.equal(scoreFromDcResult(dcResult, "3"), "1-0");
    assert.equal(scoreFromDcResult(dcResult, "3", new Set(["1-0"])), "2-0");
    assert.equal(scoreFromDcResult(dcResult, "3", new Set(["1-0", "2-0"])), "2-1");
  });

  it("returns null when dcResult is missing or topScores is empty", () => {
    assert.equal(scoreFromDcResult(null, "3"), null);
    assert.equal(scoreFromDcResult({}, "3"), null);
    assert.equal(scoreFromDcResult({ topScores: [] }, "3"), null);
  });
});

describe("half-full probabilities from Poisson lambdas", () => {
  it("sums to ~1 across all 9 outcome cells", () => {
    const probs = halfFullProbsFromLambdas(1.5, 0.9);
    const sum = Object.values(probs).reduce((acc, v) => acc + v, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `sum=${sum}`);
  });

  it("strong home favorite gets 主胜-主胜 as the dominant outcome", () => {
    const probs = halfFullProbsFromLambdas(2.6, 0.4);
    const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    assert.equal(entries[0][0], "主胜-主胜");
    // Should be > all other 主胜-* options combined-share is meaningful
    assert.ok(probs["主胜-主胜"] > probs["平局-主胜"]);
    assert.ok(probs["主胜-主胜"] > probs["客胜-主胜"]);
  });

  it("strong away favorite gets 客胜-客胜 as the dominant outcome", () => {
    const probs = halfFullProbsFromLambdas(0.5, 2.4);
    const entries = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    assert.equal(entries[0][0], "客胜-客胜");
  });

  it("balanced match has 平局-* outcomes spread across the three final codes", () => {
    const probs = halfFullProbsFromLambdas(1.2, 1.2);
    // 平局-平局 should be highest among the 平局-* family
    assert.ok(probs["平局-平局"] > probs["平局-主胜"]);
    assert.ok(probs["平局-平局"] > probs["平局-客胜"]);
    // Symmetric: 主胜-主胜 ≈ 客胜-客胜 (within noise)
    assert.ok(Math.abs(probs["主胜-主胜"] - probs["客胜-客胜"]) < 0.005);
  });

  it("zero or negative lambdas degrade to 0-0 only (concentrating mass on 平局-平局)", () => {
    const probs = halfFullProbsFromLambdas(0, 0);
    assert.equal(probs["平局-平局"], 1);
    assert.equal(probs["主胜-主胜"], 0);
    assert.equal(probs["客胜-客胜"], 0);
  });
});

describe("halfFullFromDcResult outcome selection", () => {
  it("picks highest-probability half-full matching the requested outcome", () => {
    const dcResult = { expectedGoals: { home: 1.8, away: 0.7 } };
    // Code 3 (home win) — should pick 主胜-主胜 or 平局-主胜
    const pick = halfFullFromDcResult(dcResult, "3");
    assert.ok(pick.endsWith("-主胜"), `expected 主胜-胜 ending, got ${pick}`);
  });

  it("filters out excluded values", () => {
    const dcResult = { expectedGoals: { home: 1.8, away: 0.7 } };
    const first = halfFullFromDcResult(dcResult, "3");
    const second = halfFullFromDcResult(dcResult, "3", new Set([first]));
    assert.notEqual(first, second);
    assert.ok(second.endsWith("-主胜"));
  });

  it("returns null when dcResult lacks expectedGoals", () => {
    assert.equal(halfFullFromDcResult(null, "3"), null);
    assert.equal(halfFullFromDcResult({}, "3"), null);
    assert.equal(halfFullFromDcResult({ expectedGoals: null }, "3"), null);
  });

  it("respects score consistency constraint (no 主胜-X if score is 0-2)", () => {
    const dcResult = { expectedGoals: { home: 1.4, away: 1.4 } };
    // Score 0-2 — any half-full ending in "主胜" is inconsistent so should be filtered.
    // We request code 0 (away win), so only 客胜-客胜 / 平局-客胜 / 主胜-客胜 satisfy.
    // Of these, only 平局-客胜 and 客胜-客胜 are consistent with 0-2 (no home goal possible in first half).
    const pick = halfFullFromDcResult(dcResult, "0", new Set(), "0-2");
    assert.ok(["平局-客胜", "客胜-客胜"].includes(pick), `unexpected pick: ${pick}`);
  });
});
