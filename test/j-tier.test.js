import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computePerMethodRPS, inverseRpsWeights, softmaxWeights,
  coordinateDescentWeights, autoOptimizeWeights
} from "../src/auto-weight-optimizer.js";
import { normalizeMatchRow, summarizeMatchEvents } from "../src/statsbomb-loader.js";
import { computeScorecard } from "../src/model-scorecard-cli.js";
import { createDeepPipeline } from "../src/integrated-deep-pipeline.js";

describe("auto-weight-optimizer", () => {
  it("computePerMethodRPS calculates per-method mean RPS", () => {
    const samples = {
      methodA: [
        { probabilities: { "3": 0.6, "1": 0.2, "0": 0.2 }, actual: "3" },
        { probabilities: { "3": 0.55, "1": 0.25, "0": 0.2 }, actual: "3" }
      ],
      methodB: [
        { probabilities: { "3": 0.3, "1": 0.4, "0": 0.3 }, actual: "3" },
        { probabilities: { "3": 0.35, "1": 0.4, "0": 0.25 }, actual: "3" }
      ]
    };
    const r = computePerMethodRPS(samples);
    assert.ok(r.methodA < r.methodB);
  });

  it("inverseRpsWeights assigns more weight to lower-RPS method", () => {
    const weights = inverseRpsWeights({ methodA: 0.18, methodB: 0.25, methodC: 0.30 });
    assert.ok(weights.methodA > weights.methodB);
    assert.ok(weights.methodB > weights.methodC);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.001);
  });

  it("softmaxWeights with low T = sharp; high T = uniform", () => {
    const sharp = softmaxWeights({ A: 0.18, B: 0.25 }, { temperature: 0.01 });
    const soft = softmaxWeights({ A: 0.18, B: 0.25 }, { temperature: 1.0 });
    assert.ok(sharp.A > soft.A);  // 锐化时 A 权重更高
  });

  it("coordinateDescentWeights finds non-trivial weight optimum", () => {
    const aligned = {
      A: [
        { probabilities: { "3": 0.7, "1": 0.2, "0": 0.1 }, actual: "3" },
        { probabilities: { "3": 0.6, "1": 0.3, "0": 0.1 }, actual: "3" }
      ],
      B: [
        { probabilities: { "3": 0.2, "1": 0.6, "0": 0.2 }, actual: "3" },
        { probabilities: { "3": 0.3, "1": 0.5, "0": 0.2 }, actual: "3" }
      ]
    };
    const r = coordinateDescentWeights(aligned, { iterations: 20 });
    assert.ok(r);
    // A 更准 → A 权重应高
    assert.ok(r.weights.A > r.weights.B);
  });

  it("autoOptimizeWeights with inverse-rps strategy", () => {
    const samples = {
      A: [{ probabilities: { "3": 0.6, "1": 0.2, "0": 0.2 }, actual: "3" }],
      B: [{ probabilities: { "3": 0.4, "1": 0.4, "0": 0.2 }, actual: "3" }]
    };
    const r = autoOptimizeWeights(samples, { strategy: "inverse-rps" });
    assert.ok(r.weights);
    assert.equal(r.strategy, "inverse-rps");
  });
});

describe("statsbomb-loader extractors", () => {
  it("normalizeMatchRow flattens StatsBomb match", () => {
    const raw = {
      match_id: 12345,
      match_date: "2022-12-18",
      competition: { competition_name: "FIFA World Cup" },
      season: { season_name: "2022" },
      home_team: { home_team_name: "Argentina" },
      away_team: { away_team_name: "France" },
      home_score: 3,
      away_score: 3
    };
    const r = normalizeMatchRow(raw);
    assert.equal(r.matchId, 12345);
    assert.equal(r.home, "Argentina");
    assert.equal(r.homeGoals, 3);
    assert.equal(r.competition, "FIFA World Cup");
  });

  it("summarizeMatchEvents counts shots + xG", () => {
    const events = [
      { team: { name: "A" }, type: { name: "Shot" }, shot: { statsbomb_xg: 0.3, outcome: { name: "Goal" } } },
      { team: { name: "A" }, type: { name: "Shot" }, shot: { statsbomb_xg: 0.15, outcome: { name: "Saved" } } },
      { team: { name: "B" }, type: { name: "Shot" }, shot: { statsbomb_xg: 0.4, outcome: { name: "Off T" } } },
      { team: { name: "A" }, type: { name: "Pass" }, pass: { shot_assist: true } },
      { team: { name: "B" }, type: { name: "Foul Committed" }, foul_committed: { card: { name: "Yellow Card" } } }
    ];
    const sum = summarizeMatchEvents(events);
    assert.equal(sum.homeTeam, "A");
    assert.equal(sum.awayTeam, "B");
    assert.equal(sum.home.shots, 2);
    assert.ok(Math.abs(sum.home.xg - 0.45) < 0.001);
    assert.equal(sum.home.sot, 2);  // Goal + Saved
    assert.equal(sum.home.keyPasses, 1);
    assert.equal(sum.away.yellows, 1);
  });
});

describe("model-scorecard-cli", () => {
  it("computeScorecard returns valid scorecard structure", () => {
    const sc = computeScorecard();
    assert.ok(sc);
    assert.ok(Number.isFinite(sc.total));
    assert.ok(sc.total >= 0 && sc.total <= 100);
    assert.ok(["A", "B+", "B", "C", "D"].includes(sc.grade));
    assert.ok(Array.isArray(sc.breakdown));
    assert.equal(sc.breakdown.length, 7);
  });

  it("breakdown each dimension has valid score range", () => {
    const sc = computeScorecard();
    for (const d of sc.breakdown) {
      assert.ok(d.score >= 0);
      assert.ok(d.score <= d.max);
      assert.ok(Array.isArray(d.items));
    }
  });
});

describe("integrated-deep-pipeline I 档接入", () => {
  it("accepts multi-source odds and line snapshots", () => {
    const p = createDeepPipeline({ bankrollSize: 1000 });
    const fixture = { id: "f1", homeTeam: "A", awayTeam: "B", competition: "EPL" };
    const snap = { fixtureId: "f1", europeanOdds: { current: { home: 2.0, draw: 3.4, away: 3.8 } } };
    const result = p.analyze(fixture, snap, {}, {
      multiSourceOdds: [
        { source: "pinnacle", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
        { source: "bet365", odds: { home: 1.95, draw: 3.6, away: 4.2 } }
      ],
      oddsSnapshots: [
        { source: "A", timestamp: "2026-05-29T10:00Z", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
        { source: "A", timestamp: "2026-05-29T20:00Z", odds: { home: 1.80, draw: 3.6, away: 4.5 } }
      ]
    });
    assert.ok(result.steps.sharpener);
    assert.equal(result.steps.sharpener.sources, 2);
    assert.ok(result.steps.lineMovement);
  });

  it("accepts recent matches for form features", () => {
    const p = createDeepPipeline({ bankrollSize: 1000 });
    const fixture = { id: "f1", homeTeam: "A", awayTeam: "B", competition: "EPL" };
    const snap = { fixtureId: "f1", europeanOdds: { current: { home: 2.0, draw: 3.4, away: 3.8 } } };
    const recent = [];
    for (let i = 0; i < 5; i++) {
      recent.push({
        opponent: "X", isHome: i % 2 === 0, gf: 2, ga: 1,
        opponentRating: 1500, xgFor: 1.5, xgAgainst: 1.0,
        date: `2026-04-${String(i + 1).padStart(2, "0")}`
      });
    }
    const result = p.analyze(fixture, snap, {}, {
      homeRecentMatches: recent,
      awayRecentMatches: recent
    });
    assert.ok(result.steps.formFeatures);
    assert.ok(result.steps.formFeatures.home);
    assert.ok(result.steps.matchupFeatures);
  });
});
