import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeInjuryImpact, compareInjuryImpact, injuryToLR } from "../src/injury-impact-model.js";
import { splitStats, projectHomeAwayMatch } from "../src/home-away-split-stats.js";
import { detectCleanSheetStreak, streakToProbabilityShift, cleanSheetStreakToLR } from "../src/clean-sheet-streak.js";

describe("injury-impact-model", () => {
  it("no absences → zero impact", () => {
    const r = computeInjuryImpact([]);
    assert.equal(r.eloDelta, 0);
    assert.equal(r.severity, "none");
  });

  it("star GK out is catastrophic", () => {
    const r = computeInjuryImpact([{ position: "GK", role: "star", importance: 0.95 }]);
    assert.ok(r.eloDelta <= -20);
    assert.ok(["catastrophic", "major", "significant"].includes(r.severity));
  });

  it("multiple key absences accumulate", () => {
    const r = computeInjuryImpact([
      { position: "CB", role: "key", importance: 0.80 },
      { position: "ST", role: "star", importance: 0.92 }
    ]);
    assert.ok(r.eloDelta < -20);
    assert.ok(r.xgForMultiplier < 1);
    assert.ok(r.xgAgainstMultiplier > 1);
  });

  it("compareInjuryImpact returns net edge", () => {
    const r = compareInjuryImpact(
      [{ position: "ST", role: "star", importance: 0.92 }],
      [{ position: "CB", role: "star", importance: 0.92 }, { position: "GK", role: "star", importance: 0.95 }]
    );
    assert.ok(r.netEloShift > 0);  // away 损失更大
    assert.ok(r.interpretation.includes("利主队"));
  });

  it("injuryToLR scales home advantage", () => {
    const lr = injuryToLR(30);
    assert.ok(lr.home > 1);
    assert.ok(lr.away < 1);
  });
});

describe("home-away-split-stats", () => {
  it("classifies extreme home fortress", () => {
    const matches = [];
    for (let i = 0; i < 5; i++) matches.push({ venue: "home", result: "W", goalsFor: 3, goalsAgainst: 0 });
    for (let i = 0; i < 5; i++) matches.push({ venue: "away", result: "L", goalsFor: 0, goalsAgainst: 2 });
    const r = splitStats(matches);
    assert.equal(r.splitDiff.classification, "extreme-home-fortress");
  });

  it("projectHomeAwayMatch uses home of home + away of away", () => {
    const homeSplit = splitStats([
      { venue: "home", result: "W", goalsFor: 2, goalsAgainst: 0, xgFor: 2.0, xgAgainst: 0.5 }
    ]);
    const awaySplit = splitStats([
      { venue: "away", result: "L", goalsFor: 0, goalsAgainst: 2, xgFor: 0.5, xgAgainst: 2.0 }
    ]);
    const r = projectHomeAwayMatch(homeSplit, awaySplit);
    assert.ok(r);
    assert.ok(r.projectedHomeGoals > r.projectedAwayGoals);
  });

  it("returns null when no away matches", () => {
    const homeOnly = splitStats([{ venue: "home", result: "W", goalsFor: 2, goalsAgainst: 0 }]);
    const r = projectHomeAwayMatch(homeOnly, null);
    assert.equal(r, null);
  });

  it("computes clean sheet rate", () => {
    const matches = [
      { venue: "home", result: "W", goalsFor: 1, goalsAgainst: 0 },
      { venue: "home", result: "W", goalsFor: 2, goalsAgainst: 0 },
      { venue: "home", result: "L", goalsFor: 0, goalsAgainst: 1 }
    ];
    const r = splitStats(matches);
    assert.ok(r.home.cleanSheetRate > 0.5);
  });
});

describe("clean-sheet-streak", () => {
  it("detects 3-match clean sheet streak", () => {
    const matches = [
      { goalsFor: 1, goalsAgainst: 0 },
      { goalsFor: 2, goalsAgainst: 0 },
      { goalsFor: 1, goalsAgainst: 0 },
      { goalsFor: 0, goalsAgainst: 1 }  // 这场打破 streak
    ];
    const r = detectCleanSheetStreak(matches);
    assert.equal(r.cleanSheetStreak, 3);
    assert.equal(r.cleanSheetLevel, "strong-cs-streak");
  });

  it("detects scoreless streak", () => {
    const matches = [
      { goalsFor: 0, goalsAgainst: 1 },
      { goalsFor: 0, goalsAgainst: 0 },
      { goalsFor: 0, goalsAgainst: 2 },
      { goalsFor: 0, goalsAgainst: 1 },
      { goalsFor: 1, goalsAgainst: 1 }
    ];
    const r = detectCleanSheetStreak(matches);
    assert.equal(r.scorelessStreak, 4);
    assert.equal(r.scorelessLevel, "extreme-scoreless-streak");
  });

  it("streakToProbabilityShift boosts BTTS for extreme cs streak", () => {
    const r = streakToProbabilityShift({ cleanSheetLevel: "extreme-cs-streak", scorelessLevel: "no-scoreless-streak" });
    assert.ok(r.bttsShift > 0);
  });

  it("cleanSheetStreakToLR home cs strong → LR home > 1", () => {
    const lr = cleanSheetStreakToLR(
      { cleanSheetLevel: "extreme-cs-streak", scorelessLevel: "no-scoreless-streak" },
      null
    );
    assert.ok(lr.home > 1);
  });

  it("cleanSheetStreakToLR away scoreless extreme → LR home > 1", () => {
    const lr = cleanSheetStreakToLR(
      null,
      { cleanSheetLevel: "no-cs-streak", scorelessLevel: "extreme-scoreless-streak" }
    );
    assert.ok(lr.home > 1);
    assert.ok(lr.away < 1);
  });
});
