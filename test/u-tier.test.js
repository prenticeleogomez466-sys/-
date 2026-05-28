import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { competitionProfile, adjustProbabilitiesByCompetition, adjustLambdaByCompetition, isLowQualitySample } from "../src/competition-type-model.js";
import { estimateRotationProbability, applyRotationDiscount, rotationToLR } from "../src/rotation-policy-model.js";
import { detectSeasonPhase, adjustForSeasonPhase, phaseConfidenceMultiplier } from "../src/season-phase-model.js";
import { analyzeH2H, h2hToLR, analyzeHomeH2H } from "../src/head-to-head-history.js";

describe("competition-type-model", () => {
  it("default league has intensity 1.00", () => {
    const p = competitionProfile("联赛");
    assert.equal(p.intensityMultiplier, 1.00);
  });

  it("友谊赛 has high randomness", () => {
    const p = competitionProfile("友谊赛");
    assert.ok(p.randomnessFactor > 1.5);
    assert.ok(isLowQualitySample("友谊赛"));
  });

  it("fuzzy match Champions League", () => {
    const p = competitionProfile("UEFA Champions League");
    assert.equal(p, competitionProfile("欧冠"));
  });

  it("adjustProbabilitiesByCompetition boosts draw for cup", () => {
    const r = adjustProbabilitiesByCompetition({ home: 0.5, draw: 0.3, away: 0.2 }, "杯赛-单场淘汰");
    const sum = r.adjusted.home + r.adjusted.draw + r.adjusted.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
    assert.ok(r.adjusted.draw > 0.3);
  });

  it("adjustLambdaByCompetition scales by intensity", () => {
    const friendlyLambda = adjustLambdaByCompetition(2.0, "友谊赛");
    assert.ok(friendlyLambda < 2.0);
  });
});

describe("rotation-policy-model", () => {
  it("baseline rotation low for normal league match", () => {
    const r = estimateRotationProbability({ competition: "联赛", selfElo: 1700, opponentElo: 1650 });
    assert.ok(r.rotationProbability < 0.2);
    assert.equal(r.level, "full-strength");
  });

  it("heavy rotation for cup vs much weaker opponent", () => {
    const r = estimateRotationProbability({
      competition: "杯赛-单场淘汰",
      selfElo: 1900, opponentElo: 1500,
      nextImportantMatchInDays: 3
    });
    assert.ok(r.rotationProbability > 0.4);
  });

  it("友谊赛 → heavy rotation", () => {
    const r = estimateRotationProbability({ competition: "友谊赛" });
    assert.ok(r.rotationProbability >= 0.6);
    assert.equal(r.level, "heavy-rotation");
  });

  it("rank secured → rotation up", () => {
    const r = estimateRotationProbability({ competition: "联赛", leagueRankSecured: true });
    assert.ok(r.rotationProbability > 0.3);
  });

  it("applyRotationDiscount reduces strong-side prob", () => {
    const r = applyRotationDiscount(0.5, { home: 0.6, draw: 0.25, away: 0.15 });
    assert.ok(r.home < 0.6);
    assert.ok(r.discountApplied > 0);
  });

  it("rotationToLR null for low rotation", () => {
    assert.equal(rotationToLR(0.1), null);
  });

  it("rotationToLR returns lower home for high rotation", () => {
    const lr = rotationToLR(0.7);
    assert.ok(lr.home < 1);
    assert.ok(lr.draw > 1);
  });
});

describe("season-phase-model", () => {
  it("detects early phase for September match", () => {
    const r = detectSeasonPhase("2026-09-15");
    assert.equal(r.phase, "early");
  });

  it("detects late phase for May match (seasonMonth 10)", () => {
    const r = detectSeasonPhase("2026-05-10");
    assert.equal(r.phase, "late");
  });

  it("detects mid for December", () => {
    const r = detectSeasonPhase("2026-12-15");
    assert.equal(r.phase, "mid");
  });

  it("adjustForSeasonPhase late + secured-home + survival-away → upset boost", () => {
    const r = adjustForSeasonPhase(
      { home: 0.55, draw: 0.25, away: 0.20 },
      "2026-05-10",
      { homeRankSecured: true, awayFightingForSurvival: true }
    );
    assert.ok(r.adjusted.away > 0.20);  // 客胜被推高
    assert.ok(r.adjusted.home < 0.55);
  });

  it("phaseConfidenceMultiplier lower for early season", () => {
    const earlyMult = phaseConfidenceMultiplier("2026-08-15");
    const midMult = phaseConfidenceMultiplier("2026-12-15");
    assert.ok(earlyMult < midMult);
  });
});

describe("head-to-head-history", () => {
  it("returns ok=false for < 3 matches", () => {
    const r = analyzeH2H([{ homeTeam: "A", awayTeam: "B", homeGoals: 1, awayGoals: 0 }], "A", "B");
    assert.equal(r.ok, false);
  });

  it("detects historical nemesis (team1 wins 0/10)", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({
        date: `2024-0${(i % 9) + 1}-01`,
        homeTeam: i % 2 === 0 ? "A" : "B",
        awayTeam: i % 2 === 0 ? "B" : "A",
        homeGoals: i % 2 === 0 ? 0 : 2,
        awayGoals: i % 2 === 0 ? 2 : 0
      });
    }
    const r = analyzeH2H(matches, "A", "B");
    assert.equal(r.pattern, "team2-historical-nemesis");
  });

  it("detects draw tendency", () => {
    const matches = [];
    for (let i = 0; i < 8; i++) {
      matches.push({
        date: `2024-0${(i % 9) + 1}-01`,
        homeTeam: "A", awayTeam: "B",
        homeGoals: 1, awayGoals: 1
      });
    }
    const r = analyzeH2H(matches, "A", "B");
    assert.equal(r.pattern, "draw-tendency");
  });

  it("h2hToLR returns null for balanced", () => {
    const lr = h2hToLR({ ok: true, pattern: "balanced" });
    assert.equal(lr, null);
  });

  it("h2hToLR returns lower home for team2-nemesis", () => {
    const lr = h2hToLR({ ok: true, pattern: "team2-historical-nemesis" });
    assert.ok(lr.away > 1);
    assert.ok(lr.home < 1);
  });

  it("analyzeHomeH2H separates home vs away", () => {
    const matches = [
      { homeTeam: "A", awayTeam: "B", homeGoals: 2, awayGoals: 0 },
      { homeTeam: "A", awayTeam: "B", homeGoals: 1, awayGoals: 1 },
      { homeTeam: "B", awayTeam: "A", homeGoals: 3, awayGoals: 0 }
    ];
    const r = analyzeHomeH2H(matches, "A");
    assert.equal(r.team1HomeMatches, 2);
    assert.equal(r.team1AwayMatches, 1);
    assert.equal(r.team1HomeWins, 1);
  });
});
