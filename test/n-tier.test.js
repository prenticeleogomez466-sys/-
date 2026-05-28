import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextGoalProbability, halfTimeFullTimeExpected, inPlayNextNGoalProbability, fitExponentialFromGoalTimes } from "../src/survival-goal-timing.js";
import { fitRefereeProfiles, computeRefereeLR, applyRefereeBias } from "../src/referee-bias-model.js";
import { computeFatigueMultiplier, compareFatigue, applyFatigueBias } from "../src/schedule-fatigue-model.js";
import { computeSetPieceProfile, leagueSetPieceBaseline, applySetPieceToOverUnder } from "../src/set-piece-model.js";

describe("survival-goal-timing", () => {
  it("nextGoalProbability rises with lambda", () => {
    const r1 = nextGoalProbability(1.0);
    const r2 = nextGoalProbability(3.0);
    assert.ok(r2.probability > r1.probability);
  });

  it("halfTimeFullTimeExpected sums correctly", () => {
    const r = halfTimeFullTimeExpected(2.4);
    assert.ok(Math.abs(r.firstHalfLambda + r.secondHalfLambda - 2.4) < 0.01);
  });

  it("inPlayNextNGoalProbability:与剩余 lambda 成正比", () => {
    const earlyHighLambda = inPlayNextNGoalProbability(10, 2.0, 10);
    const earlyLowLambda = inPlayNextNGoalProbability(10, 0.2, 10);
    assert.ok(earlyHighLambda.probability > earlyLowLambda.probability);
  });

  it("fitExponentialFromGoalTimes estimates lambda", () => {
    const goals = [
      { fixtureId: "f1", goalMinute: 23 },
      { fixtureId: "f1", goalMinute: 67 },
      { fixtureId: "f2", goalMinute: 45 }
    ];
    const r = fitExponentialFromGoalTimes(goals);
    assert.ok(r);
    assert.equal(r.fixtures, 2);
    assert.equal(r.samples, 3);
    assert.ok(r.estimatedLambda >= 1.0 && r.estimatedLambda <= 2.0);
  });
});

describe("referee-bias-model", () => {
  it("fitRefereeProfiles aggregates per referee", () => {
    const history = [];
    for (let i = 0; i < 10; i++) {
      history.push({
        refereeId: "ref-1",
        refereeName: "Mike",
        isHome: false,
        won: i < 6 ? "home" : "away",
        yellows: 5, reds: 0, penalties: 0
      });
    }
    const p = fitRefereeProfiles(history);
    assert.ok(p["ref-1"]);
    assert.equal(p["ref-1"].matches, 10);
    assert.equal(p["ref-1"].homeWinRate, 0.6);
  });

  it("computeRefereeLR returns shift factors", () => {
    const profile = { homeWinRate: 0.55, drawRate: 0.25, awayWinRate: 0.20, matches: 30 };
    const baseline = { homeWinRate: 0.45, drawRate: 0.25, awayWinRate: 0.30 };
    const lr = computeRefereeLR(profile, baseline);
    assert.ok(lr.home > 1.0);  // 高于 baseline
    assert.ok(lr.away < 1.0);
  });

  it("applyRefereeBias adjusts probabilities", () => {
    const probs = { home: 0.45, draw: 0.30, away: 0.25 };
    const profile = { homeWinRate: 0.55, drawRate: 0.25, awayWinRate: 0.20 };
    const baseline = { homeWinRate: 0.45, drawRate: 0.25, awayWinRate: 0.30 };
    const adjusted = applyRefereeBias(probs, profile, baseline);
    assert.ok(adjusted.home > probs.home);
    const sum = adjusted.home + adjusted.draw + adjusted.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });
});

describe("schedule-fatigue-model", () => {
  it("computeFatigueMultiplier penalizes short rest", () => {
    const m3 = computeFatigueMultiplier("2026-05-26", "2026-05-29");
    const m7 = computeFatigueMultiplier("2026-05-22", "2026-05-29");
    assert.ok(m3 < m7);
    assert.equal(m7, 1.0);
  });

  it("away match adds small penalty", () => {
    const home = computeFatigueMultiplier("2026-05-26", "2026-05-29", { isAway: false });
    const away = computeFatigueMultiplier("2026-05-26", "2026-05-29", { isAway: true });
    assert.ok(away < home);
  });

  it("compareFatigue detects significant imbalance", () => {
    const r = compareFatigue("2026-05-26", "2026-05-22", "2026-05-29");
    // home 3 天休息(疲劳),away 7 天休息(满血)
    assert.ok(r.homeAdvantageFromFatigue < 1.0);
  });

  it("applyFatigueBias shifts probabilities", () => {
    const probs = { home: 0.5, draw: 0.3, away: 0.2 };
    const fatigue = { homeMultiplier: 0.92, awayMultiplier: 1.0, homeAdvantageFromFatigue: 0.92, significant: true };
    const r = applyFatigueBias(probs, fatigue);
    assert.ok(r.home < probs.home);
    assert.ok(r.away > probs.away);
  });
});

describe("set-piece-model", () => {
  it("computeSetPieceProfile aggregates by team", () => {
    const goals = [];
    for (let i = 0; i < 10; i++) goals.push({ teamId: "Burnley", type: i < 4 ? "corner" : "open-play" });
    for (let i = 0; i < 10; i++) goals.push({ teamId: "City", type: "open-play" });
    const p = computeSetPieceProfile(goals);
    assert.ok(p["Burnley"]);
    assert.equal(p["Burnley"].setPieceShare, 0.4);
    assert.equal(p["City"].setPieceShare, 0);
  });

  it("classifyTeam identifies set-piece specialist", () => {
    const goals = [];
    for (let i = 0; i < 20; i++) goals.push({ teamId: "X", type: i < 8 ? "corner" : "open-play" });
    const p = computeSetPieceProfile(goals);
    assert.equal(p["X"].classification, "set-piece-specialist");
  });

  it("applySetPieceToOverUnder raises over for high-set-piece teams", () => {
    const homeProfile = { setPieceShare: 0.40 };
    const awayProfile = { setPieceShare: 0.35 };
    const adjusted = applySetPieceToOverUnder(0.50, homeProfile, awayProfile);
    assert.ok(adjusted > 0.50);
  });

  it("leagueSetPieceBaseline averages", () => {
    const profiles = {
      A: { setPieceShare: 0.3, openPlayShare: 0.7 },
      B: { setPieceShare: 0.2, openPlayShare: 0.8 }
    };
    const r = leagueSetPieceBaseline(profiles);
    assert.equal(r.avgSetPieceShare, 0.25);
    assert.equal(r.sampleTeams, 2);
  });
});
