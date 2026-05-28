import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { haversineDistance, travelMultiplier, computeTravelImpact, applyTravelBias } from "../src/travel-distance-model.js";
import { weatherXgMultiplier, applyWeatherToXG, applyWeatherToOverUnder } from "../src/weather-adjusted-xg.js";
import { canonicalFormation, fitFormationMatchups, getFormationLift, applyFormationLift } from "../src/tactical-matchup.js";
import { fitManagerProfiles, honeymoonBoost, computeManagerInfluence, applyManagerInfluence } from "../src/manager-effect-model.js";

describe("travel-distance-model", () => {
  it("haversineDistance London ↔ Paris ≈ 344km", () => {
    const d = haversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
    assert.ok(d > 330 && d < 360);
  });

  it("travelMultiplier: short distance no penalty", () => {
    assert.equal(travelMultiplier(50), 1.0);
    assert.equal(travelMultiplier(300), 0.99);
  });

  it("travelMultiplier: long-haul + timezone", () => {
    const m = travelMultiplier(8000, { timezoneDiff: 6 });
    assert.ok(m < 0.94);
  });

  it("computeTravelImpact returns multiplier + note", () => {
    const r = computeTravelImpact({ lat: 51.5, lon: 0, timezone: 0 }, { lat: -34.6, lon: -58.4, timezone: -3 });
    assert.ok(r.distanceKm > 10000);
    assert.equal(r.note, "跨洋长途");
  });

  it("applyTravelBias shifts home probability up", () => {
    const probs = { home: 0.4, draw: 0.3, away: 0.3 };
    const impact = { significant: true, awayTeamMultiplier: 0.92 };
    const adjusted = applyTravelBias(probs, impact);
    assert.ok(adjusted.home > probs.home);
  });
});

describe("weather-adjusted-xg", () => {
  it("perfect weather has multiplier 1.0", () => {
    const r = weatherXgMultiplier({ temperature2m: { avg: 18 }, precipitation: { avg: 0 }, windSpeed10m: { avg: 10 } });
    assert.equal(r.multiplier, 1.0);
  });

  it("heavy rain reduces multiplier", () => {
    const r = weatherXgMultiplier({ temperature2m: { avg: 15 }, precipitation: { avg: 6 }, windSpeed10m: { avg: 5 } });
    assert.ok(r.multiplier < 0.85);
    assert.ok(r.factors.some((f) => f.name === "暴雨"));
  });

  it("strong wind + heavy rain compounds", () => {
    const r = weatherXgMultiplier({ temperature2m: { avg: 15 }, precipitation: { avg: 6 }, windSpeed10m: { avg: 35 } });
    assert.ok(r.multiplier < 0.75);
    assert.ok(r.factors.length >= 2);
  });

  it("extreme cold penalty", () => {
    const r = weatherXgMultiplier({ temperature2m: { avg: -8 }, precipitation: { avg: 0 }, windSpeed10m: { avg: 5 } });
    assert.ok(r.factors.some((f) => f.type === "cold"));
  });

  it("applyWeatherToXG scales down both teams", () => {
    const xg = { home: 1.5, away: 0.9 };
    const weather = { temperature2m: { avg: 15 }, precipitation: { avg: 6 }, windSpeed10m: { avg: 5 } };
    const adjusted = applyWeatherToXG(xg, weather);
    assert.ok(adjusted.home < xg.home);
  });

  it("applyWeatherToOverUnder reduces over probability", () => {
    const weather = { temperature2m: { avg: 15 }, precipitation: { avg: 6 }, windSpeed10m: { avg: 5 } };
    const adjusted = applyWeatherToOverUnder(0.55, weather);
    assert.ok(adjusted < 0.55);
  });
});

describe("tactical-matchup", () => {
  it("canonicalFormation parses common formations", () => {
    assert.equal(canonicalFormation("4-3-3"), "4-3-3");
    assert.equal(canonicalFormation("4 3 3"), "4-3-3");
    assert.equal(canonicalFormation("invalid"), null);
  });

  it("fitFormationMatchups aggregates pairs", () => {
    const history = [];
    for (let i = 0; i < 15; i++) {
      history.push({ homeFormation: "4-3-3", awayFormation: "4-4-2", won: i < 8 ? "home" : "away" });
    }
    const r = fitFormationMatchups(history);
    assert.ok(r["4-3-3::4-4-2"]);
    assert.ok(r["4-3-3::4-4-2"].homeWinRate > 0.5);
  });

  it("getFormationLift detects matchup advantage", () => {
    const matchups = { "4-3-3::5-3-2": { total: 20, homeWinRate: 0.60, drawRate: 0.20, awayWinRate: 0.20 } };
    const lift = getFormationLift("4-3-3", "5-3-2", matchups);
    assert.equal(lift.found, true);
    assert.ok(lift.homeLift > 1);
  });

  it("applyFormationLift adjusts probabilities", () => {
    const probs = { home: 0.45, draw: 0.30, away: 0.25 };
    const lift = { found: true, homeLift: 1.15 };
    const r = applyFormationLift(probs, lift);
    assert.ok(r.home > probs.home);
  });
});

describe("manager-effect-model", () => {
  it("fitManagerProfiles tiers by win rate", () => {
    const history = [];
    for (let i = 0; i < 50; i++) {
      history.push({ managerId: "elite-mgr", managerName: "Pep", isHome: true, won: i < 35 ? "home" : "draw" });
    }
    const profiles = fitManagerProfiles(history);
    assert.equal(profiles["elite-mgr"].tier, "elite");
  });

  it("honeymoonBoost decays with matches", () => {
    assert.ok(honeymoonBoost(1) > honeymoonBoost(8));
    assert.equal(honeymoonBoost(100), 0);
  });

  it("computeManagerInfluence combines profile + honeymoon", () => {
    const profile = { tier: "elite", winRate: 0.60 };
    const inf = computeManagerInfluence(profile, 5);
    assert.ok(inf.lift > 0.05);
  });

  it("applyManagerInfluence: elite home vs average away → home boost", () => {
    const probs = { home: 0.45, draw: 0.30, away: 0.25 };
    const homeMgr = { lift: 0.05 };
    const awayMgr = { lift: 0 };
    const r = applyManagerInfluence(probs, homeMgr, awayMgr);
    assert.ok(r.home > probs.home);
  });
});
