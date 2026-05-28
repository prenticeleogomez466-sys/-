import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trainLinearStacker, predictWithStacker, buildStackerSamplesFromLedger } from "../src/linear-stacker.js";
import { buildIsotonicMap, applyIsotonicMap } from "../src/model-calibration.js";

describe("linear stacker training and prediction", () => {
  // 合成数据:特征是赔率隐含 + DC 模拟概率,标签按软最大模型采样
  function buildSyntheticSamples(n) {
    const samples = [];
    const rng = mulberry32(42);
    for (let i = 0; i < n; i++) {
      const baseH = 0.25 + rng() * 0.5;
      const baseA = 0.15 + rng() * 0.5;
      const baseD = Math.max(0.1, 1 - baseH - baseA);
      const total = baseH + baseD + baseA;
      const features = {
        oddsHome: baseH / total,
        oddsDraw: baseD / total,
        oddsAway: baseA / total,
        modelHome: (baseH / total) * 0.9 + rng() * 0.1,
        modelDraw: baseD / total,
        modelAway: 0.5 - (baseH / total) * 0.4
      };
      // True label: max class
      const probs = [features.oddsHome, features.oddsDraw, features.oddsAway];
      const r = rng();
      let label = "home";
      let acc = 0;
      for (let k = 0; k < 3; k++) {
        acc += probs[k];
        if (r < acc) { label = ["home", "draw", "away"][k]; break; }
      }
      samples.push({ features, label });
    }
    return samples;
  }

  it("rejects training with fewer than minSamples samples", () => {
    const model = trainLinearStacker([{ features: { x: 1 }, label: "home" }], { minSamples: 50 });
    assert.equal(model.ok, false);
    assert.match(model.reason, /insufficient/);
  });

  it("trains on 200 synthetic samples and predicts within (0,1)", () => {
    const samples = buildSyntheticSamples(200);
    const model = trainLinearStacker(samples, { epochs: 100, minSamples: 50 });
    assert.equal(model.ok, true);
    assert.equal(model.classes.length, 3);
    assert.ok(model.history.length > 0);
    // 损失应该下降
    assert.ok(model.history[model.history.length - 1].loss < model.history[0].loss);

    const probs = predictWithStacker(model, {
      oddsHome: 0.5, oddsDraw: 0.25, oddsAway: 0.25,
      modelHome: 0.55, modelDraw: 0.22, modelAway: 0.23
    });
    assert.ok(probs);
    assert.ok(Math.abs(probs.home + probs.draw + probs.away - 1) < 0.01);
    for (const k of ["home", "draw", "away"]) {
      assert.ok(probs[k] > 0 && probs[k] < 1, `${k}=${probs[k]}`);
    }
  });

  it("predictWithStacker returns null for null model", () => {
    assert.equal(predictWithStacker(null, {}), null);
    assert.equal(predictWithStacker({ ok: false }, {}), null);
  });

  it("buildStackerSamplesFromLedger filters by valid actual labels", () => {
    const rows = [
      { actual: "主胜", probabilityHome: 0.5, probabilityDraw: 0.3, probabilityAway: 0.2,
        baseProbabilityHome: 0.45, baseProbabilityDraw: 0.3, baseProbabilityAway: 0.25,
        monteCarloHome: 0.52, monteCarloDraw: 0.28, monteCarloAway: 0.2, confidence: 65 },
      { actual: "", probabilityHome: 0.5, probabilityDraw: 0.3, probabilityAway: 0.2 },
      { actual: "客胜", probabilityHome: 0.3, probabilityDraw: 0.3, probabilityAway: 0.4,
        baseProbabilityHome: 0.3, baseProbabilityDraw: 0.3, baseProbabilityAway: 0.4,
        monteCarloHome: 0.3, monteCarloDraw: 0.3, monteCarloAway: 0.4, confidence: 50 }
    ];
    const samples = buildStackerSamplesFromLedger(rows);
    assert.equal(samples.length, 2);
    assert.equal(samples[0].label, "home");
    assert.equal(samples[1].label, "away");
  });
});

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
