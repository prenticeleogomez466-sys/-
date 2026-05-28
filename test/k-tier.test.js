import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnsembleWeightsProfile, saveEnsembleWeightsProfile, learnAndPersistWeights } from "../src/ensemble-weights-profile.js";

describe("ensemble-weights-profile", () => {
  it("save + load roundtrip", () => {
    const profile = { weights: { A: 0.4, B: 0.6 }, strategy: "test", generatedAt: "2026-05-29" };
    const path = saveEnsembleWeightsProfile(profile);
    assert.ok(path);
    const loaded = loadEnsembleWeightsProfile();
    assert.ok(loaded);
    assert.equal(loaded.weights.A, 0.4);
  });

  it("learnAndPersistWeights rejects too-few settled rows", () => {
    const r = learnAndPersistWeights([{ hit: true, probabilityHome: 0.5 }], { minSamples: 30 });
    assert.equal(r.ok, false);
  });

  it("learnAndPersistWeights with enough settled samples returns weights", () => {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const hit = i % 3 === 0;
      rows.push({
        hit, actual: hit ? "主胜" : "客胜",
        probabilityHome: 0.55, probabilityDraw: 0.25, probabilityAway: 0.20,
        ensembleHome: 0.50, ensembleDraw: 0.28, ensembleAway: 0.22
      });
    }
    const r = learnAndPersistWeights(rows);
    assert.equal(r.ok, true);
    assert.ok(r.weights);
    assert.ok(typeof r.weights.main === "number");
  });
});
