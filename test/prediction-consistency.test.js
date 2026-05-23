import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditRecommendations } from "../src/recommendation-audit.js";
import { halfFullFinalOutcomeCode, predictFixture, scoreOutcomeCode } from "../src/prediction-engine.js";

const baseFixture = {
  id: "fixture-1",
  date: "2026-05-15",
  kickoff: "2026-05-15 20:00",
  competition: "测试联赛",
  homeTeam: "主队",
  awayTeam: "客队",
  marketType: "jingcai",
  sequence: "001",
  tags: []
};

describe("prediction derived market consistency", () => {
  it("builds score and half-full picks from the selected WDL outcome", () => {
    const cases = [
      { expected: "3", odds: { home: 1.5, draw: 4.2, away: 6.5 } },
      { expected: "1", odds: { home: 3.4, draw: 2.1, away: 3.8 } },
      { expected: "0", odds: { home: 5.8, draw: 3.7, away: 1.7 } }
    ];

    for (const item of cases) {
      const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: item.odds } }]);
      assert.equal(prediction.pick.code, item.expected);
      assert.equal(scoreOutcomeCode(prediction.scorePicks.primary), prediction.pick.code);
      assert.equal(scoreOutcomeCode(prediction.scorePicks.secondary), prediction.secondaryPick.code);
      assert.equal(halfFullFinalOutcomeCode(prediction.halfFullPicks.primary), prediction.pick.code);
      assert.equal(halfFullFinalOutcomeCode(prediction.halfFullPicks.secondary), prediction.secondaryPick.code);
    }
  });

  it("fails audit when score or half-full conflicts with WDL outcome", () => {
    const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 1.5, draw: 4.2, away: 6.5 } } }]);
    prediction.scorePicks.primary = "0-1";
    const audit = auditRecommendations({ predictions: [prediction], fourteen: { count: 0 } });

    assert.equal(audit.ok, false);
    assert.equal(audit.summary.errors, 1);
    assert.match(audit.errors[0].message, /比分首选/);
  });

  it("bounds confidence and rejects high-risk bankers", () => {
    const prediction = predictFixture(baseFixture, [{
      fixtureId: baseFixture.id,
      date: baseFixture.date,
      europeanOdds: { current: { home: 1.05, draw: 12, away: 21 } },
      asianHandicap: { current: { line: -2, homeWater: 0.9, awayWater: 0.9 } }
    }]);
    assert.ok(prediction.confidence <= 100);

    const audit = auditRecommendations({
      predictions: [prediction],
      fourteen: { count: 1, selections: [{ index: 1, match: "主队 对 客队", type: "胆", risk: "高" }] }
    });
    assert.equal(audit.ok, false);
    assert.match(audit.errors.at(-1).message, /高风险场次禁止定胆/);
  });

  it("uses fixture-level Elo and form as bounded probability adjustments", () => {
    const advancedData = {
      fixtures: [{
        fixtureId: baseFixture.id,
        data: {
          elo: {
            home: { Elo: "2050" },
            away: { Elo: "1700" }
          },
          form: {
            home: { matches: 8, pointsPerMatch: 2.25, goalDiff: 8 },
            away: { matches: 8, pointsPerMatch: 0.5, goalDiff: -8 }
          }
        }
      }]
    };
    const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 2.05, draw: 3.2, away: 3.4 } } }], 0, { advancedData });

    assert.equal(prediction.probabilityAdjustment.applied, true);
    assert.ok(prediction.probabilityAdjustment.signals.some((signal) => signal.key === "elo"));
    assert.ok(prediction.probabilities.home > prediction.baseProbabilities.home);
    assert.ok(prediction.probabilityAdjustment.maxShift <= 0.08);
    assert.equal(prediction.simulation.iterations, 20000);
    assert.ok(prediction.simulation.topScores.length > 0);
  });
});
