import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createKalmanFormTracker } from "../src/kalman-form-tracker.js";
import { createOnlineDcLearner } from "../src/online-incremental-dc.js";
import { bayesianUpdate, registerEvidence, EVIDENCE_LR } from "../src/bayesian-belief-update.js";
import { adjustParlayForCorrelation } from "../src/parlay-correlation-adjuster.js";

describe("kalman-form-tracker", () => {
  it("observes and updates state", () => {
    const t = createKalmanFormTracker();
    t.observe("A", 2);
    t.observe("A", 1);
    t.observe("A", 3);
    const s = t.getState("A");
    assert.ok(s.form > 0);
    assert.ok(s.variance < 1.0);  // 不确定性应减少
    assert.equal(s.observations, 3);
  });

  it("variance decreases with more observations", () => {
    const t = createKalmanFormTracker();
    t.observe("A", 1);
    const v1 = t.getState("A").variance;
    for (let i = 0; i < 10; i++) t.observe("A", 1);
    const v2 = t.getState("A").variance;
    assert.ok(v2 < v1);
  });

  it("compare returns formGap + significance", () => {
    const t = createKalmanFormTracker();
    for (let i = 0; i < 10; i++) {
      t.observe("Strong", 3);
      t.observe("Weak", -3);
    }
    const c = t.compare("Strong", "Weak");
    assert.ok(c.formGap > 0);
    assert.equal(c.gapStatisticallySignificant, true);
  });

  it("feedMatches batch processes sorted matches", () => {
    const t = createKalmanFormTracker();
    const matches = [
      { home: "A", away: "B", homeGoals: 2, awayGoals: 0, date: "2026-04-01" },
      { home: "A", away: "C", homeGoals: 3, awayGoals: 1, date: "2026-04-15" }
    ];
    const result = t.feedMatches(matches);
    assert.ok(result.A);
    assert.equal(result.A.observations, 2);
  });
});

describe("online-incremental-dc", () => {
  it("updates team attack/defense after match", () => {
    const dc = createOnlineDcLearner();
    const r = dc.update({ home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 });
    assert.ok(r);
    // Strong 的 attack 应增加(进球多于预期)
    assert.ok(dc.state.teams["Strong"].attack > 1.0);
    assert.ok(dc.state.teams["Weak"].defense > 1.0);  // defense 值越大失球越多
  });

  it("predict returns sensible expected goals", () => {
    const dc = createOnlineDcLearner();
    for (let i = 0; i < 10; i++) {
      dc.update({ home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 });
    }
    const pred = dc.predict("Strong", "Weak");
    assert.ok(pred.lambdaHome > pred.lambdaAway);
  });

  it("feedMatches processes sequence", () => {
    const dc = createOnlineDcLearner();
    const updates = dc.feedMatches([
      { home: "A", away: "B", homeGoals: 2, awayGoals: 1, date: "2026-04-01" },
      { home: "C", away: "D", homeGoals: 1, awayGoals: 1, date: "2026-04-15" }
    ]);
    assert.equal(updates.length, 2);
    assert.equal(dc.state.matchesProcessed, 2);
  });

  it("dump returns serializable state", () => {
    const dc = createOnlineDcLearner();
    dc.update({ home: "A", away: "B", homeGoals: 1, awayGoals: 0 });
    const d = dc.dump();
    assert.equal(d.matchesProcessed, 1);
    assert.ok(d.teams.A);
  });
});

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
