import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { skellamPMF, skellamDistribution, asianHandicapFromSkellam, overUnderFromSkellam, besselI } from "../src/skellam-distribution.js";
// 2026-06-11 融合大扫除:betting-performance/sensitivity-analysis/adversarial-validation/integrated-deep-pipeline 死模块已删,仅保留生产模块 skellam 测试。

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
    assert.ok(expected > 0);  // 涓婚槦浼樺娍
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

