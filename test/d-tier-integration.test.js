import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootstrapRatings, collectHistoricalMatches, __resetBootstrapMemoForTests } from "../src/ratings-bootstrap.js";
import { buildEnsembleViewFromBootstrap } from "../src/prediction-engine.js";
import {
  parseScore, deriveWldFromScore, deriveHandicapFromScore,
  pickConsistentHalfFull, pickConsistentScore, firstHalfPlausible,
  verifyRecommendationConsistency
} from "../src/consistency-derivation.js";
import { kellyFraction, dutchingStakes, kellyCombo, detectArbitrage } from "../src/dutching-optimizer.js";
import { generateExplanation } from "../src/explanation-generator.js";

describe("ratings-bootstrap", () => {
  it("returns no-op result when no fixtures", () => {
    __resetBootstrapMemoForTests();
    const r = bootstrapRatings({ maxDates: 0 });
    assert.equal(r.samples, 0);
    assert.equal(r.pi, null);
  });
  it("memoizes within same options key", () => {
    __resetBootstrapMemoForTests();
    const r1 = bootstrapRatings({ maxDates: 0 });
    const r2 = bootstrapRatings({ maxDates: 0 });
    assert.equal(r1, r2);  // 同一引用
  });
  it("collectHistoricalMatches returns array", () => {
    const arr = collectHistoricalMatches(5);
    assert.ok(Array.isArray(arr));
  });
});

describe("buildEnsembleViewFromBootstrap", () => {
  it("returns null when no bootstrap", () => {
    assert.equal(buildEnsembleViewFromBootstrap({ homeTeam: "A", awayTeam: "B" }, null, null, null), null);
  });
  it("combines odds + DC even when ratings missing", () => {
    const view = buildEnsembleViewFromBootstrap(
      { homeTeam: "A", awayTeam: "B" },
      { pi: null, massey: null, colley: null, bivariate: null, hierarchical: null },
      { home: 0.5, draw: 0.3, away: 0.2 },
      { probabilities: { home: 0.55, draw: 0.25, away: 0.20 } }
    );
    assert.ok(view);
    assert.equal(view.methodCount, 2);  // odds + dixonColes
  });
  it("integrates Pi predictWinProb when available", () => {
    const fakePiRatings = {
      ok: true,
      predictWinProb: (h, a) => ({ home: 0.6, draw: 0.25, away: 0.15 })
    };
    const view = buildEnsembleViewFromBootstrap(
      { homeTeam: "A", awayTeam: "B" },
      { pi: fakePiRatings, massey: null, colley: null, bivariate: null },
      { home: 0.5, draw: 0.3, away: 0.2 },
      null
    );
    assert.ok(view);
    assert.ok(view.methodCount >= 2);  // odds + pi
    assert.ok(view.contributions.pi);
  });
});

describe("consistency-derivation", () => {
  it("parseScore handles X-Y format", () => {
    assert.deepEqual(parseScore("1-0"), { home: 1, away: 0 });
    assert.deepEqual(parseScore("2-1"), { home: 2, away: 1 });
    assert.equal(parseScore("invalid"), null);
  });

  it("deriveWldFromScore", () => {
    assert.equal(deriveWldFromScore("1-0"), "主胜");
    assert.equal(deriveWldFromScore("1-1"), "平局");
    assert.equal(deriveWldFromScore("0-2"), "客胜");
  });

  it("deriveHandicapFromScore: 1-0 + 让 -1 = 平局", () => {
    assert.equal(deriveHandicapFromScore("1-0", -1), "平局");
    assert.equal(deriveHandicapFromScore("2-0", -1), "主胜");
    assert.equal(deriveHandicapFromScore("2-0", -2), "平局");
    assert.equal(deriveHandicapFromScore("0-1", -1), "客胜");
    assert.equal(deriveHandicapFromScore("1-1", -1), "客胜");
  });

  it("firstHalfPlausible", () => {
    assert.equal(firstHalfPlausible("胜", 1, 0), true);
    assert.equal(firstHalfPlausible("胜", 0, 1), false);  // 主队没进球 → 不可能上半场领先
    assert.equal(firstHalfPlausible("平", 0, 0), true);
    assert.equal(firstHalfPlausible("平", 5, 5), true);
    assert.equal(firstHalfPlausible("负", 1, 0), false);
    assert.equal(firstHalfPlausible("负", 0, 1), true);
  });

  it("pickConsistentHalfFull picks lowest odds matching score", () => {
    const hfMap = { "胜胜": 2.02, "平胜": 3.90, "负胜": 27.00, "胜平": 18.00, "平平": 5.90 };
    const r = pickConsistentHalfFull("1-0", hfMap);
    assert.equal(r.label, "胜胜");
    assert.equal(r.odds, 2.02);
  });

  it("pickConsistentHalfFull respects plausibility(0-1 不能有 胜X)", () => {
    const hfMap = { "胜负": 55.00, "平负": 12.50, "负负": 11.50 };
    const r = pickConsistentHalfFull("0-1", hfMap);
    // "胜负" 上半场字符 胜 但全场 0-1 → plausibility check 应该排除
    assert.notEqual(r.label, "胜负");
    assert.ok(r.label === "平负" || r.label === "负负");
  });

  it("pickConsistentScore挑赔率最低", () => {
    const odds = { "1-0": 5.50, "2-0": 6.00, "0-0": 11.50, "1-1": 7.00, "0-1": 14.50 };
    const r = pickConsistentScore(odds);
    assert.equal(r.score, "1-0");
    assert.equal(r.wld, "主胜");
  });

  it("verifyRecommendationConsistency catches contradiction", () => {
    const errs = verifyRecommendationConsistency({
      score: "1-0", wld: "客胜", handicapDirection: "主胜", handicapLine: -1, halfFull: "胜胜"
    });
    assert.ok(errs.length >= 2);  // wld 矛盾 + handicap 矛盾
  });

  it("verifyRecommendationConsistency passes valid combo", () => {
    const errs = verifyRecommendationConsistency({
      score: "2-0", wld: "主胜", handicapDirection: "平局", handicapLine: -2, halfFull: "胜胜"
    });
    assert.equal(errs.length, 0);
  });
});

describe("dutching-optimizer", () => {
  it("kellyFraction returns 0 for negative EV", () => {
    assert.equal(kellyFraction(0.3, 2.0), 0);  // 0.3 * 2 = 0.6 < 1
  });

  it("kellyFraction returns positive for value bet", () => {
    const f = kellyFraction(0.55, 2.0);  // p=0.55, b=1, EV=0.1
    assert.ok(f > 0);
    assert.ok(f < 0.2);  // 1/4 Kelly
  });

  it("dutchingStakes computes equal-return stakes", () => {
    const out = dutchingStakes([
      { label: "home", probability: 0.5, odds: 2.0 },
      { label: "draw", probability: 0.3, odds: 3.5 },
      { label: "away", probability: 0.2, odds: 5.0 }
    ], { unitReturn: 100 });
    assert.equal(out.ok, true);
    // 每个 stake × odds 应该 = unitReturn
    for (const s of out.stakes) {
      assert.ok(Math.abs(s.stake * s.odds - 100) < 0.5);
    }
    // 隐含 = 1/2 + 1/3.5 + 1/5 ≈ 0.99 — 接近 arbitrage 边界
    assert.ok(out.impliedSum < 1.05);
  });

  it("dutchingStakes detects arbitrage", () => {
    const out = dutchingStakes([
      { label: "home", probability: 0.5, odds: 2.5 },
      { label: "draw", probability: 0.3, odds: 4.0 },
      { label: "away", probability: 0.2, odds: 6.0 }
    ], { unitReturn: 100 });
    // 1/2.5 + 1/4 + 1/6 = 0.4 + 0.25 + 0.167 = 0.817 < 1
    assert.equal(out.isArbitrage, true);
    assert.ok(out.profitIfAnyWin > 0);
  });

  it("kellyCombo for parlay", () => {
    const r = kellyCombo([
      { probability: 0.55, odds: 2.0 },
      { probability: 0.60, odds: 1.8 }
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.legs, 2);
    assert.ok(Math.abs(r.combinedOdds - 3.6) < 0.01);
    assert.ok(Math.abs(r.combinedProbability - 0.33) < 0.001);
  });

  it("detectArbitrage finds best odds across markets", () => {
    const r = detectArbitrage([
      { source: "bookie1", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
      { source: "bookie2", odds: { home: 1.9, draw: 3.8, away: 4.2 } }
    ]);
    assert.equal(r.bestOdds.home.odds, 2.0);
    assert.equal(r.bestOdds.away.odds, 4.2);
  });
});

describe("explanation-generator", () => {
  it("returns string for basic prediction", () => {
    const text = generateExplanation({
      fixture: { homeTeam: "A", awayTeam: "B" },
      pick: { code: "3", label: "主胜", probability: 0.55 },
      secondaryPick: { code: "1", label: "平局", probability: 0.25 },
      risk: "中", confidence: 65,
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 }
    });
    assert.ok(typeof text === "string");
    assert.ok(text.includes("主胜"));
    assert.ok(text.includes("55"));
  });

  it("notes ensemble drift when significant", () => {
    const text = generateExplanation({
      fixture: { homeTeam: "A", awayTeam: "B" },
      pick: { code: "3", label: "主胜", probability: 0.55 },
      secondaryPick: { code: "1", label: "平局", probability: 0.25 },
      probabilities: { home: 0.55, draw: 0.25, away: 0.20 },
      ensembleView: {
        methodCount: 4,
        probabilities: { home: 0.45, draw: 0.30, away: 0.25 }
      }
    });
    assert.ok(text.includes("ensemble"));
    assert.ok(text.includes("分歧"));
  });
});

