import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";

describe("isotonic regression calibration", () => {
  it("returns null for empty observations", () => {
    assert.equal(buildIsotonicMap([]), null);
    assert.equal(buildIsotonicMap(null), null);
    assert.equal(buildIsotonicMap([{ predicted: 0.5, actual: 1 }]), null);
  });

  it("learns identity-ish map when actual frequencies match predictions", () => {
    // 完美校准:predicted = actual_freq
    const obs = [];
    for (let i = 0; i < 100; i++) obs.push({ predicted: 0.3, actual: i < 30 ? 1 : 0 });
    for (let i = 0; i < 100; i++) obs.push({ predicted: 0.7, actual: i < 70 ? 1 : 0 });
    const map = buildIsotonicMap(obs);
    assert.ok(map);
    assert.ok(map.knots.length >= 2);
    // 0.3 应该映射到约 0.3,0.7 应该映射到约 0.7
    assert.ok(Math.abs(applyIsotonicMap(map, 0.3) - 0.3) < 0.1);
    assert.ok(Math.abs(applyIsotonicMap(map, 0.7) - 0.7) < 0.1);
  });

  it("learns a non-trivial correction when model is over-confident", () => {
    // 模型给 0.8 但实际命中率只有 0.6
    const obs = [];
    for (let i = 0; i < 50; i++) obs.push({ predicted: 0.5, actual: i < 25 ? 1 : 0 });
    for (let i = 0; i < 50; i++) obs.push({ predicted: 0.8, actual: i < 30 ? 1 : 0 });
    const map = buildIsotonicMap(obs);
    const correctedAt08 = applyIsotonicMap(map, 0.8);
    // 0.8 应该被下调到 0.6 附近
    assert.ok(correctedAt08 < 0.75, `expected correction down, got ${correctedAt08}`);
    assert.ok(correctedAt08 > 0.4, `should not collapse to 0.5 baseline, got ${correctedAt08}`);
  });

  it("produces monotone non-decreasing output (PAV property)", () => {
    const obs = [];
    // Intentionally noisy data, but globally monotone direction
    for (let p = 0.1; p <= 0.9; p += 0.1) {
      for (let i = 0; i < 20; i++) {
        obs.push({ predicted: p, actual: Math.random() < p ? 1 : 0 });
      }
    }
    const map = buildIsotonicMap(obs);
    for (let i = 1; i < map.knots.length; i++) {
      assert.ok(map.knots[i].calibrated >= map.knots[i - 1].calibrated, `knot ${i} broke monotonicity`);
    }
  });

  it("handles edge inputs outside knot range", () => {
    const obs = [];
    for (let i = 0; i < 30; i++) obs.push({ predicted: 0.4, actual: i < 15 ? 1 : 0 });
    for (let i = 0; i < 30; i++) obs.push({ predicted: 0.6, actual: i < 20 ? 1 : 0 });
    const map = buildIsotonicMap(obs);
    // < min → clamp to first knot
    assert.equal(applyIsotonicMap(map, 0.1), map.knots[0].calibrated);
    // > max → clamp to last knot
    assert.equal(applyIsotonicMap(map, 0.95), map.knots[map.knots.length - 1].calibrated);
  });
});

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
