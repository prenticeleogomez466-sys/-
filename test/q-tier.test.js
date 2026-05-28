import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectAllEvidence, applyAllEvidenceToProbabilities } from "../src/evidence-collector.js";
import { getProfileRegistry, __resetProfileRegistryForTests } from "../src/profile-registry.js";
import { enrichRecommendation, enrichAllRecommendations } from "../src/recommendation-enrichment.js";
import { tuneThresholds } from "../src/adaptive-threshold-tuner.js";

describe("evidence-collector", () => {
  it("returns empty for empty context", () => {
    const ev = collectAllEvidence({});
    assert.equal(ev.length, 0);
  });

  it("collects streak evidence when home recent shows pattern", () => {
    const ctx = {
      fixture: { homeTeam: "A", awayTeam: "B" },
      homeRecent: [{ won: "W" }, { won: "W" }, { won: "W" }, { won: "W" }]
    };
    const ev = collectAllEvidence(ctx);
    assert.ok(ev.some((e) => e.source === "streak-home"));
  });

  it("collects derby evidence for known rivalry", () => {
    const ctx = { fixture: { homeTeam: "Manchester United", awayTeam: "Manchester City" } };
    const ev = collectAllEvidence(ctx);
    assert.ok(ev.some((e) => e.source === "derby"));
  });

  it("applies multiple evidence to probabilities", () => {
    const prior = { home: 0.5, draw: 0.3, away: 0.2 };
    const ctx = {
      fixture: { homeTeam: "Manchester United", awayTeam: "Manchester City" },
      homeRecent: [{ won: "L" }, { won: "L" }, { won: "L" }, { won: "L" }, { won: "L" }]
    };
    const r = applyAllEvidenceToProbabilities(prior, ctx);
    assert.equal(r.evidenceCount >= 1, true);
    const sum = r.posterior.home + r.posterior.draw + r.posterior.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });
});

describe("profile-registry", () => {
  it("set + get + has work", () => {
    __resetProfileRegistryForTests();
    const reg = getProfileRegistry();
    reg.set("referee", { ref1: { homeWinRate: 0.55 } });
    assert.ok(reg.has("referee"));
    assert.equal(reg.getRefereeProfiles().ref1.homeWinRate, 0.55);
  });

  it("list returns registered names", () => {
    __resetProfileRegistryForTests();
    const reg = getProfileRegistry();
    reg.set("manager", { mgr1: { tier: "elite" } });
    reg.set("teamGraph", { ok: true });
    const list = reg.list();
    assert.ok(list.find((x) => x.name === "manager"));
    assert.ok(list.find((x) => x.name === "teamGraph"));
  });

  it("singleton across calls", () => {
    __resetProfileRegistryForTests();
    const r1 = getProfileRegistry();
    r1.set("manager", { test: 1 });
    const r2 = getProfileRegistry();
    assert.equal(r2.getManagerProfiles().test, 1);
  });
});

describe("recommendation-enrichment", () => {
  it("returns null for missing prediction", () => {
    assert.equal(enrichRecommendation(null, []), null);
  });

  it("identifies supporting evidence for home pick", () => {
    const prediction = { pick: { code: "3", outcome: "home" } };
    const evidence = [
      { name: "home-streak", ratio: { home: 1.10, draw: 0.95, away: 0.90 }, source: "streak" },
      { name: "derby", ratio: { home: 0.95, draw: 1.10, away: 0.95 }, source: "derby" }
    ];
    const e = enrichRecommendation(prediction, evidence);
    assert.equal(e.pick, "home");
    assert.ok(e.supportingFactors.length >= 1);
  });

  it("flags risk factors when opposing evidence exists", () => {
    const prediction = { pick: { code: "3", outcome: "home" } };
    const evidence = [
      { name: "away-streak", ratio: { home: 0.85, draw: 1.0, away: 1.15 }, source: "streak" }
    ];
    const e = enrichRecommendation(prediction, evidence);
    assert.ok(e.riskFactors.length >= 1);
  });

  it("enrichAllRecommendations adds enrichment to each", () => {
    const preds = [
      { pick: { code: "3", outcome: "home" } },
      { pick: { code: "1", outcome: "draw" } }
    ];
    const enriched = enrichAllRecommendations(preds, () => ({ evidence: [] }));
    assert.equal(enriched.length, 2);
    assert.ok(enriched[0].enrichment);
  });
});

describe("adaptive-threshold-tuner", () => {
  it("rejects too-few settled rows", () => {
    const r = tuneThresholds([{ hit: true, ev: 0.05 }]);
    assert.equal(r.ok, false);
  });

  it("identifies best threshold from synthetic data", () => {
    const rows = [];
    // 高 EV 票:hit rate 60%,赔率 2.0 → 长期赢
    for (let i = 0; i < 30; i++) rows.push({ hit: i < 18, ev: 0.10, primaryOdds: 2.0 });
    // 低 EV 票:hit rate 35%,赔率 2.0 → 长期输
    for (let i = 0; i < 20; i++) rows.push({ hit: i < 7, ev: -0.05, primaryOdds: 2.0 });
    const r = tuneThresholds(rows);
    assert.equal(r.ok, true);
    assert.ok(r.bestEvThreshold >= 0);  // 应该选正阈值
    assert.ok(r.bestEvRoi > 0);
  });

  it("provides recommendation string", () => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push({ hit: i % 2 === 0, ev: 0.05, primaryOdds: 2.0 });
    const r = tuneThresholds(rows);
    assert.ok(typeof r.recommendation === "string");
  });
});
