import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bayesianUpdate, registerEvidence, EVIDENCE_LR } from "../src/bayesian-belief-update.js";
import { adjustParlayForCorrelation } from "../src/parlay-correlation-adjuster.js";

describe("bayesian-belief-update", () => {
  it("posterior equals prior when no evidence", () => {
    const prior = { home: 0.5, draw: 0.3, away: 0.2 };
    const r = bayesianUpdate(prior, []);
    assert.ok(Math.abs(r.posterior.home - prior.home) < 0.001);
  });

  it("key-injury-home shifts probability away from home", () => {
    const prior = { home: 0.5, draw: 0.3, away: 0.2 };
    const r = bayesianUpdate(prior, [{ name: "key-injury-home" }]);
    assert.ok(r.posterior.home < prior.home);
    assert.ok(r.posterior.away > prior.away);
  });

  it("steam-money-home shifts probability toward home", () => {
    const prior = { home: 0.4, draw: 0.3, away: 0.3 };
    const r = bayesianUpdate(prior, [{ name: "steam-money-home" }]);
    assert.ok(r.posterior.home > prior.home);
  });

  it("custom ratio overrides default", () => {
    const prior = { home: 0.5, draw: 0.3, away: 0.2 };
    const r = bayesianUpdate(prior, [{ name: "custom", ratio: { home: 2.0, draw: 0.5, away: 0.5 } }]);
    assert.ok(r.posterior.home > 0.6);
  });

  it("registerEvidence allows new patterns", () => {
    registerEvidence("test-evidence", { home: 1.5, draw: 0.9, away: 0.8 });
    assert.ok(EVIDENCE_LR["test-evidence"]);
  });

  it("largestShift identifies dominant effect", () => {
    const prior = { home: 0.4, draw: 0.3, away: 0.3 };
    const r = bayesianUpdate(prior, [{ name: "key-injury-home" }]);
    assert.ok(["home", "away", "draw"].includes(r.largestShift.outcome));
  });
});

describe("parlay-correlation-adjuster", () => {
  it("rejects fewer than 2 legs", () => {
    const r = adjustParlayForCorrelation([{ probability: 0.5 }]);
    assert.equal(r.ok, false);
  });

  it("independent legs:adjustment near 0", () => {
    const r = adjustParlayForCorrelation([
      { fixtureId: "f1", probability: 0.5, league: "EPL", outcome: "home" },
      { fixtureId: "f2", probability: 0.5, league: "SerieA", outcome: "away" }
    ]);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.adjustmentPct) < 0.1);
  });

  it("same league + same outcome → positive correlation", () => {
    const r = adjustParlayForCorrelation([
      { fixtureId: "f1", probability: 0.5, league: "EPL", outcome: "home", kickoffDate: "2026-05-29" },
      { fixtureId: "f2", probability: 0.5, league: "EPL", outcome: "home", kickoffDate: "2026-05-29" }
    ]);
    assert.ok(r.correlations.length > 0);
    assert.ok(r.totalCorrelationSum > 0);
    assert.ok(r.jointProbabilityCorrelated >= r.jointProbabilityIndependent);
  });

  it("same team across legs → positive correlation", () => {
    const r = adjustParlayForCorrelation([
      { fixtureId: "f1", probability: 0.5, homeTeam: "A", awayTeam: "B" },
      { fixtureId: "f2", probability: 0.5, homeTeam: "A", awayTeam: "C" }
    ]);
    assert.ok(r.totalCorrelationSum > 0.05);
  });

  it("narrative describes correlation level", () => {
    const r = adjustParlayForCorrelation([
      { fixtureId: "f1", probability: 0.5, league: "EPL", outcome: "home", kickoffDate: "2026-05-29" },
      { fixtureId: "f2", probability: 0.5, league: "EPL", outcome: "home", kickoffDate: "2026-05-29" }
    ]);
    assert.ok(r.narrative.length > 0);
  });
});
