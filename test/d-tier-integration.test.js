import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootstrapRatings, collectHistoricalMatches, __resetBootstrapMemoForTests } from "../src/ratings-bootstrap.js";
import { buildEnsembleViewFromBootstrap } from "../src/prediction-engine.js";
// 2026-06-11 融合大扫除:consistency-derivation / dutching-optimizer / explanation-generator 三个生产不可达死模块已永久删除,对应测试块一并移除。

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
    assert.equal(r1, r2);  // 鍚屼竴寮曠敤
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
