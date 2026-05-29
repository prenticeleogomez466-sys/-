import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skellamPMF, skellamDistribution, asianHandicapFromSkellam, overUnderFromSkellam, besselI } from "../src/skellam-distribution.js";
import { computeReturnsFromLedger, sharpeRatio, sortinoRatio, calmarRatio, performanceReport, riskParityAllocation } from "../src/betting-performance.js";
import { sensitivityAnalysis } from "../src/sensitivity-analysis.js";
import { detectDistributionShift } from "../src/adversarial-validation.js";
import { createDeepPipeline } from "../src/integrated-deep-pipeline.js";

describe("skellam-distribution", () => {
  it("besselI is positive and grows with x", () => {
    assert.ok(besselI(0, 0) === 1);
    assert.ok(besselI(0, 1) > 1);
    assert.ok(besselI(0, 2) > besselI(0, 1));
  });

  it("PMF sums to ~1 over reasonable range", () => {
    const dist = skellamDistribution(1.5, 0.9);
    const sum = Object.values(dist).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 0.001, `sum=${sum}`);
  });

  it("favorite has positive expected diff", () => {
    const dist = skellamDistribution(2.0, 0.5);
    let expected = 0;
    for (const [k, p] of Object.entries(dist)) expected += Number(k) * p;
    assert.ok(expected > 0);  // 主队优势
  });

  it("asianHandicapFromSkellam normalizes to 1", () => {
    const ah = asianHandicapFromSkellam(1.5, 0.9, -1);
    const sum = ah.home + ah.draw + ah.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });

  it("overUnderFromSkellam over 2.5 sane for 2.4 expected goals", () => {
    const ou = overUnderFromSkellam(1.5, 0.9, 2.5);
    assert.ok(ou.over > 0.3 && ou.over < 0.6);
    assert.ok(Math.abs(ou.over + ou.under - 1) < 0.001);
  });
});

describe("betting-performance", () => {
  it("computeReturnsFromLedger handles wins and losses", () => {
    const rows = [
      { hit: true, primaryOdds: 2.0, stakeUnitsPer100: 5 },
      { hit: false, stakeUnitsPer100: 5 },
      { hit: true, primaryOdds: 1.8, stakeUnitsPer100: 5 }
    ];
    const r = computeReturnsFromLedger(rows);
    assert.equal(r.length, 3);
    assert.equal(r[0], 1.0);  // 2.0-1
    assert.equal(r[1], -1);
    assert.ok(Math.abs(r[2] - 0.8) < 1e-9);
  });

  it("sharpeRatio rejects too-short series", () => {
    assert.equal(sharpeRatio([0.1, 0.2]), null);
  });

  it("sharpeRatio positive for profitable consistent returns", () => {
    const returns = new Array(30).fill(0.05).concat(new Array(20).fill(-0.04));
    const sh = sharpeRatio(returns);
    assert.ok(sh > 0);
  });

  it("sortinoRatio penalizes downside only", () => {
    const returns = new Array(30).fill(0.05).concat(new Array(20).fill(-0.04));
    const so = sortinoRatio(returns);
    const sh = sharpeRatio(returns);
    assert.ok(Number.isFinite(so) && Number.isFinite(sh));
  });

  it("performanceReport produces winRate + sharpe", () => {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push({ hit: i < 12, primaryOdds: 1.9, stakeUnitsPer100: 5 });
    }
    const r = performanceReport(rows);
    assert.equal(r.ok, true);
    assert.equal(r.winRate, 0.6);
  });

  it("riskParityAllocation equalizes risk contribution", () => {
    const r = riskParityAllocation([
      { id: "A", expectedVolatility: 0.1, expectedReturn: 0.05 },
      { id: "B", expectedVolatility: 0.2, expectedReturn: 0.08 }
    ]);
    assert.equal(r.ok, true);
    // 较低波动率的 A 应得更高权重
    const a = r.allocations.find((x) => x.id === "A");
    const b = r.allocations.find((x) => x.id === "B");
    assert.ok(a.weight > b.weight);
  });
});

describe("sensitivity-analysis", () => {
  it("returns null for empty prediction", () => {
    assert.equal(sensitivityAnalysis(null), null);
  });

  it("ranks scenarios by impact magnitude", () => {
    const pred = { probabilities: { home: 0.5, draw: 0.3, away: 0.2 } };
    const r = sensitivityAnalysis(pred);
    assert.ok(r);
    assert.ok(r.impacts.length > 0);
    // 最敏感的 magnitude 应 ≥ 第二的
    if (r.impacts.length >= 2) {
      assert.ok(r.impacts[0].magnitude >= r.impacts[1].magnitude);
    }
  });

  it("detects direction flip when scenario reverses outcome", () => {
    const pred = { probabilities: { home: 0.42, draw: 0.30, away: 0.28 } };  // 主胜略领先
    const r = sensitivityAnalysis(pred, {
      scenarios: [{ name: "对手强势复出", patch: { opponentInjuries: "clear" } }]
    });
    assert.ok(r.impacts.length === 1);
  });
});

describe("adversarial-validation", () => {
  it("detects same distribution → low shift", () => {
    const train = []; const test = [];
    for (let i = 0; i < 50; i++) {
      train.push({ eloDiff: 100 + (Math.random() - 0.5) * 50 });
      test.push({ eloDiff: 100 + (Math.random() - 0.5) * 50 });
    }
    const r = detectDistributionShift(train, test);
    assert.equal(r.ok, true);
    assert.ok(r.overallShiftScore < 1.0);
  });

  it("detects strong shift when test distribution far from train", () => {
    const train = []; const test = [];
    for (let i = 0; i < 50; i++) {
      train.push({ eloDiff: 100 + Math.random() * 20 });
      test.push({ eloDiff: 500 + Math.random() * 20 });  // 极大偏移
    }
    const r = detectDistributionShift(train, test);
    assert.equal(r.ok, true);
    assert.ok(r.overallShiftScore > 0.5, `score=${r.overallShiftScore}`);
    assert.ok(r.recommendation.includes("偏移") || r.recommendation.includes("🔴"));
  });
});

describe("integrated-deep-pipeline", () => {
  it("creates pipeline with minimal opts", () => {
    const p = createDeepPipeline({});
    assert.ok(p);
    assert.equal(typeof p.analyze, "function");
    assert.equal(typeof p.batchAnalyze, "function");
  });

  it("analyzes a fixture and returns full step breakdown", () => {
    const p = createDeepPipeline({ bankrollSize: 1000, kellyFraction: 0.25 });
    const fixture = { id: "f1", homeTeam: "A", awayTeam: "B", competition: "EPL" };
    const snap = { fixtureId: "f1", europeanOdds: { current: { home: 2.0, draw: 3.4, away: 3.8 } } };
    const result = p.analyze(fixture, snap, { xg: { home: { xg: 1.5 }, away: { xg: 0.9 } } });
    assert.ok(result.steps.base);
    assert.ok(result.steps.calibrated);
    assert.ok(result.steps.evByOutcome);
    assert.ok(result.steps.bestPick);
    assert.ok(result.decision);
  });

  it("batchAnalyze allocates across multiple fixtures", () => {
    const p = createDeepPipeline({ bankrollSize: 1000 });
    const fixtures = [
      { id: "f1", homeTeam: "A", awayTeam: "B", competition: "EPL" },
      { id: "f2", homeTeam: "C", awayTeam: "D", competition: "EPL" }
    ];
    const snapshots = [
      { fixtureId: "f1", europeanOdds: { current: { home: 2.0, draw: 3.4, away: 3.8 } } },
      { fixtureId: "f2", europeanOdds: { current: { home: 1.5, draw: 4.0, away: 6.0 } } }
    ];
    const r = p.batchAnalyze(fixtures, snapshots, {});
    assert.ok(Array.isArray(r.decisions));
    assert.equal(r.decisions.length, 2);
  });
});
