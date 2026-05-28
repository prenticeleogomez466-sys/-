import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markovScoreMatrix, inPlayProbabilities, outcomesFromMatrix } from "../src/markov-match-simulator.js";
import { findSimilarMatches } from "../src/similar-match-knn.js";
import { allocateThompson, sampleBeta, sampleGamma, buildBetaPosteriorsFromLedger } from "../src/thompson-sampling-allocator.js";
import { scanArbitrage, findMiddleBets } from "../src/cross-market-arbitrage.js";
import { detectTilt } from "../src/tilt-detector.js";
import { fitTemperature, applyTemperature } from "../src/temperature-calibration.js";

describe("markov-match-simulator", () => {
  it("matrix sums to ~1", () => {
    const m = markovScoreMatrix(1.5, 0.9);
    let sum = 0;
    for (const row of m) for (const p of row) sum += p;
    assert.ok(Math.abs(sum - 1) < 0.05, `sum=${sum}`);
  });

  it("favorite home → home wins more than away", () => {
    const m = markovScoreMatrix(2.0, 0.5);
    const o = outcomesFromMatrix(m);
    assert.ok(o.home > o.away);
  });

  it("inPlayProbabilities at minute 0 ≈ full-match probabilities", () => {
    const inplay = inPlayProbabilities({ home: 0, away: 0, minute: 0 }, 1.5, 0.9);
    const sum = inplay.probabilities.home + inplay.probabilities.draw + inplay.probabilities.away;
    assert.ok(Math.abs(sum - 1) < 0.01);
    assert.ok(inplay.probabilities.home > inplay.probabilities.away);
  });

  it("inPlayProbabilities with lead at 75 min → leader wins overwhelmingly", () => {
    const inplay = inPlayProbabilities({ home: 2, away: 0, minute: 75 }, 1.5, 0.9);
    assert.ok(inplay.probabilities.home > 0.85);
    assert.ok(inplay.probabilities.away < 0.05);
  });

  it("red card to home reduces home probability", () => {
    const normal = inPlayProbabilities({ home: 0, away: 0, minute: 30 }, 2.0, 1.0);
    const redCard = inPlayProbabilities({ home: 0, away: 0, minute: 30 }, 2.0, 1.0, { homeRedCard: true });
    assert.ok(redCard.probabilities.home < normal.probabilities.home);
    assert.ok(redCard.probabilities.away > normal.probabilities.away);
  });
});

describe("similar-match-knn", () => {
  it("rejects insufficient history", () => {
    const r = findSimilarMatches({ eloDiff: 50 }, [{ eloDiff: 50, actual: 3 }]);
    assert.equal(r.ok, false);
  });

  it("finds similar matches and returns probability distribution", () => {
    const history = [];
    // 高 Elo 差(200-249) → 主胜
    for (let i = 0; i < 30; i++) {
      history.push({ eloDiff: 220 + i, oddsImpliedDiff: 0.4, league: "EPL", actual: 3 });
    }
    // 低 Elo 差(-50..0)→ 平局/客胜
    for (let i = 0; i < 40; i++) {
      history.push({ eloDiff: -50 + i, oddsImpliedDiff: 0.0, league: "EPL", actual: i < 20 ? 1 : 0 });
    }
    const r = findSimilarMatches({ eloDiff: 250, oddsImpliedDiff: 0.4, league: "EPL" }, history, { k: 10 });
    assert.equal(r.ok, true);
    assert.ok(r.probabilities.home > r.probabilities.away, `home=${r.probabilities.home}, away=${r.probabilities.away}`);
    const s = r.probabilities.home + r.probabilities.draw + r.probabilities.away;
    assert.ok(Math.abs(s - 1) < 0.01, `sum=${s}`);
  });
});

describe("thompson-sampling-allocator", () => {
  it("sampleBeta returns in (0,1)", () => {
    for (let i = 0; i < 50; i++) {
      const b = sampleBeta(2, 5);
      assert.ok(b > 0 && b < 1);
    }
  });

  it("sampleGamma is positive", () => {
    for (let i = 0; i < 30; i++) {
      assert.ok(sampleGamma(2.5) > 0);
    }
  });

  it("allocateThompson distributes more to higher-EV candidates", () => {
    const candidates = [
      { id: "A", betaAlpha: 30, betaBeta: 10, modelProb: 0.75, odds: 2.0 },  // hit rate ≈ 0.75, EV +0.5
      { id: "B", betaAlpha: 10, betaBeta: 30, modelProb: 0.25, odds: 2.0 },  // hit rate ≈ 0.25, EV -0.5
    ];
    const r = allocateThompson(candidates, 1000, { samples: 200 });
    assert.equal(r.ok, true);
    const a = r.allocations.find((x) => x.id === "A");
    const b = r.allocations.find((x) => x.id === "B");
    assert.ok(a.stake > b.stake, `A=${a.stake}, B=${b.stake}`);
  });

  it("buildBetaPosteriorsFromLedger builds posteriors", () => {
    const rows = [
      { hit: true, method: "main" },
      { hit: false, method: "main" },
      { hit: true, method: "main" },
      { hit: true, method: "ensemble" },
      { hit: true, method: "ensemble" }
    ];
    const post = buildBetaPosteriorsFromLedger(rows);
    assert.ok(post.main);
    assert.equal(post.main.alpha, 3);  // prior 1 + 2 wins
    assert.equal(post.main.beta, 2);   // prior 1 + 1 loss
    assert.equal(post.ensemble.alpha, 3);
  });
});

describe("cross-market-arbitrage", () => {
  it("detects arbitrage when sum(1/best) < 1", () => {
    const quotes = [
      { bookmaker: "A", fixtureId: "f1", market: "1x2", odds: { home: 2.5, draw: 3.5, away: 3.0 } },
      { bookmaker: "B", fixtureId: "f1", market: "1x2", odds: { home: 2.7, draw: 3.8, away: 3.2 } }
    ];
    // best: home 2.7, draw 3.8, away 3.2 → 1/2.7 + 1/3.8 + 1/3.2 = 0.370 + 0.263 + 0.3125 = 0.946 < 1
    const r = scanArbitrage(quotes);
    assert.equal(r.ok, true);
    assert.equal(r.arbitrageOpportunities.length, 1);
    assert.ok(r.arbitrageOpportunities[0].profitMargin > 0);
  });

  it("returns no arbitrage with high-vig markets", () => {
    const quotes = [
      { bookmaker: "A", fixtureId: "f2", market: "1x2", odds: { home: 1.8, draw: 3.0, away: 4.0 } }
    ];
    const r = scanArbitrage(quotes);
    assert.equal(r.arbitrageOpportunities.length, 0);
  });

  it("flags value bet when single bookmaker odds > 10% above mean", () => {
    const quotes = [
      { bookmaker: "A", fixtureId: "f3", market: "1x2", odds: { home: 2.0, draw: 3.4, away: 3.5 } },
      { bookmaker: "B", fixtureId: "f3", market: "1x2", odds: { home: 2.0, draw: 3.5, away: 3.5 } },
      { bookmaker: "C", fixtureId: "f3", market: "1x2", odds: { home: 2.4, draw: 3.4, away: 3.5 } }
    ];
    const r = scanArbitrage(quotes);
    const valueHome = r.valueBets.find((v) => v.outcome === "home" && v.bookmaker === "C");
    assert.ok(valueHome);
    assert.ok(valueHome.upsidePct > 0.10);
  });

  it("findMiddleBets detects middle window", () => {
    const r = findMiddleBets(
      { fixtureId: "f1", line: -0.5, odds: { home: 1.95, away: 1.95 } },
      { fixtureId: "f1", line: +0.5, odds: { home: 1.95, away: 1.95 } }
    );
    assert.ok(r);
    assert.deepEqual(r.middleRange, [-0.5, 0.5]);
  });
});

describe("tilt-detector", () => {
  it("returns none for stable behavior", () => {
    const bets = [
      { timestamp: "2026-05-20T10:00:00Z", stake: 10, hit: true, kellySuggestedStake: 10 },
      { timestamp: "2026-05-22T10:00:00Z", stake: 10, hit: false, kellySuggestedStake: 10 },
      { timestamp: "2026-05-24T10:00:00Z", stake: 10, hit: true, kellySuggestedStake: 10 }
    ];
    const r = detectTilt(bets);
    assert.equal(r.severity, "none");
  });

  it("flags critical on consecutive losses + escalation", () => {
    const bets = [];
    for (let i = 0; i < 10; i++) {
      bets.push({
        timestamp: `2026-05-28T10:${String(i * 3).padStart(2, "0")}:00Z`,
        stake: 10 + i * 5,  // 仓位放大
        hit: false,
        kellySuggestedStake: 5
      });
    }
    const r = detectTilt(bets);
    assert.ok(["high", "critical"].includes(r.severity), `severity=${r.severity}`);
    assert.ok(r.signals.some((s) => s.name === "consecutive-losses"));
    assert.ok(r.signals.some((s) => s.name === "stake-escalation"));
  });

  it("flags rapid-betting", () => {
    const bets = [];
    const t0 = Date.parse("2026-05-28T20:00:00Z");
    for (let i = 0; i < 6; i++) {
      bets.push({ timestamp: new Date(t0 + i * 60 * 1000).toISOString(), stake: 10, hit: i < 4 ? false : true });
    }
    const r = detectTilt(bets);
    assert.ok(r.signals.some((s) => s.name === "rapid-betting"));
  });
});

describe("temperature-calibration", () => {
  it("rejects insufficient samples", () => {
    const r = fitTemperature([{ probabilities: { home: 0.5, draw: 0.3, away: 0.2 }, actual: "3" }]);
    assert.equal(r.ok, false);
  });

  it("finds T > 1 for overconfident model", () => {
    // 模型给 0.9 主胜概率,实际 50% 命中 → 过度自信 → 需 T > 1 软化
    const samples = [];
    for (let i = 0; i < 100; i++) {
      samples.push({
        probabilities: { home: 0.9, draw: 0.05, away: 0.05 },
        actual: i < 50 ? "3" : "0"
      });
    }
    const r = fitTemperature(samples);
    assert.equal(r.ok, true);
    assert.ok(r.temperature > 1.0, `T=${r.temperature}`);
  });

  it("applyTemperature preserves ranking", () => {
    const probs = { home: 0.6, draw: 0.3, away: 0.1 };
    const calibrated = applyTemperature(probs, 1.5);
    // Argmax 不变(都是 home)
    const before = ["home", "draw", "away"].sort((a, b) => probs[b] - probs[a])[0];
    const after = ["home", "draw", "away"].sort((a, b) => calibrated[b] - calibrated[a])[0];
    assert.equal(before, after);
    // 概率和 = 1
    const sum = calibrated.home + calibrated.draw + calibrated.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });

  it("T > 1 softens confidence", () => {
    const probs = { home: 0.8, draw: 0.15, away: 0.05 };
    const soft = applyTemperature(probs, 2.0);
    assert.ok(soft.home < probs.home);
    assert.ok(soft.draw > probs.draw);
  });
});
