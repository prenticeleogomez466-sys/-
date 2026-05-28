import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectStreak, streakToLR } from "../src/streak-detector.js";
import { computeBigGameForm, chooseFormForOpponent, bigGameReadinessLR } from "../src/big-game-form.js";
import { detectDerby, applyDerbyAdjustment, registerDerby, derbyToLR } from "../src/derby-intensity.js";
import { computePressureProfile, pressureToFormMultiplier, applyStandingsPressureAdjustment } from "../src/standings-pressure.js";

describe("streak-detector", () => {
  it("3-game winning streak detected", () => {
    const matches = [{ won: "W" }, { won: "W" }, { won: "W" }];
    const r = detectStreak(matches);
    assert.equal(r.type, "winning");
    assert.equal(r.length, 3);
    assert.ok(r.lift > 0);
  });

  it("5-game losing streak has negative lift + breakPointRisk", () => {
    const matches = [];
    for (let i = 0; i < 5; i++) matches.push({ won: "L" });
    const r = detectStreak(matches);
    assert.equal(r.type, "losing");
    assert.equal(r.length, 5);
    assert.ok(r.lift < 0);
    assert.ok(r.breakPointRisk > 0);
  });

  it("Mixed results break streak", () => {
    const matches = [{ won: "W" }, { won: "L" }, { won: "W" }];
    const r = detectStreak(matches);
    assert.equal(r.length, 1);
  });

  it("streakToLR returns LR for winning streak", () => {
    const lr = streakToLR({ type: "winning", length: 5, lift: 0.04 });
    assert.ok(lr.home > 1);
    assert.ok(lr.away < 1);
  });

  it("streakToLR returns LR for losing streak", () => {
    const lr = streakToLR({ type: "losing", length: 4, lift: -0.03 });
    assert.ok(lr.home < 1);
    assert.ok(lr.away > 1);
  });
});

describe("big-game-form", () => {
  it("returns null for empty matches", () => {
    assert.equal(computeBigGameForm([]), null);
  });

  it("computes both overall and big-game form", () => {
    const matches = [];
    // 10 vs weak (低 ELO),5 vs strong
    for (let i = 0; i < 10; i++) matches.push({ opponentElo: 1300, gf: 3, ga: 0 });
    for (let i = 0; i < 5; i++) matches.push({ opponentElo: 1700, gf: 1, ga: 1 });
    const r = computeBigGameForm(matches);
    assert.equal(r.bigGameDataAvailable, true);
    assert.ok(r.allPpm > r.bigGamePpm);
    assert.ok(r.readinessFactor < 0);
  });

  it("classifies big-game choker", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) matches.push({ opponentElo: 1300, gf: 3, ga: 0 });
    for (let i = 0; i < 5; i++) matches.push({ opponentElo: 1800, gf: 0, ga: 3 });
    const r = computeBigGameForm(matches);
    assert.ok(["big-game-choker", "big-game-drop"].includes(r.classification));
  });

  it("chooseFormForOpponent switches form by opponent ELO", () => {
    const profile = { allPpm: 2.0, bigGamePpm: 1.0, bigGameSamples: 5, bigGameDataAvailable: true };
    const vsStrong = chooseFormForOpponent(1800, profile);
    const vsWeak = chooseFormForOpponent(1300, profile);
    assert.equal(vsStrong.source, "big-game-form");
    assert.equal(vsWeak.source, "overall-form");
  });

  it("bigGameReadinessLR shifts toward home when home is better in big games", () => {
    const homeProfile = { bigGameDataAvailable: true, readinessFactor: 0.3 };
    const awayProfile = { bigGameDataAvailable: true, readinessFactor: -0.3 };
    const lr = bigGameReadinessLR(homeProfile, awayProfile);
    assert.ok(lr.home > 1);
    assert.ok(lr.away < 1);
  });
});

describe("derby-intensity", () => {
  it("detects historical derby (Manchester)", () => {
    const r = detectDerby("Manchester United", "Manchester City");
    assert.equal(r.isDerby, true);
    assert.equal(r.intensity, "historical-rivalry");
  });

  it("detects same-city derby by distance", () => {
    const r = detectDerby("Unknown Team A", "Unknown Team B", { distanceKm: 15 });
    assert.equal(r.isDerby, true);
    assert.equal(r.intensity, "city-derby");
  });

  it("non-derby returns false", () => {
    const r = detectDerby("Team A", "Team B", { distanceKm: 500 });
    assert.equal(r.isDerby, false);
  });

  it("applyDerbyAdjustment raises draw probability", () => {
    const probs = { home: 0.45, draw: 0.30, away: 0.25 };
    const r = applyDerbyAdjustment(probs, { isDerby: true, intensity: "historical-rivalry" });
    assert.ok(r.draw > probs.draw);
  });

  it("registerDerby adds new pair", () => {
    registerDerby("Test A", "Test B");
    const r = detectDerby("Test A", "Test B");
    assert.equal(r.isDerby, true);
  });

  it("derbyToLR returns boost for draw", () => {
    const lr = derbyToLR({ isDerby: true, intensity: "historical-rivalry" });
    assert.ok(lr.draw > 1);
  });
});

describe("standings-pressure", () => {
  it("title race detected when leader gap small", () => {
    const r = computePressureProfile({
      position: 2, totalTeams: 20, points: 70, leaderPoints: 74,
      relegationLine: 30, europePoints: 60, remainingMatches: 6
    });
    assert.equal(r.tier, "title-race");
    assert.ok(r.intensity > 0.5);
  });

  it("relegation fight detected", () => {
    const r = computePressureProfile({
      position: 18, totalTeams: 20, points: 28, leaderPoints: 70,
      relegationLine: 26, europePoints: 60, remainingMatches: 5
    });
    assert.equal(r.tier, "relegation-fight");
    assert.ok(r.intensity > 0.5);
  });

  it("clinched title has negative intensity (摆烂)", () => {
    const r = computePressureProfile({
      position: 1, totalTeams: 20, points: 88, leaderPoints: 88,
      relegationLine: 30, europePoints: 60, remainingMatches: 3
    });
    // titleGap = 0, 不是已锁定;改一下
    const r2 = computePressureProfile({
      position: 1, totalTeams: 20, points: 88, leaderPoints: 70,
      relegationLine: 30, europePoints: 60, remainingMatches: 3
    });
    assert.equal(r2.tier, "title-clinched");
    assert.ok(r2.intensity < 0);
  });

  it("pressureToFormMultiplier:moderate pressure lifts", () => {
    const m = pressureToFormMultiplier({ intensity: 0.6 });
    assert.ok(m >= 1.0);
  });

  it("pressureToFormMultiplier:摆烂 drops", () => {
    const m = pressureToFormMultiplier({ intensity: -0.4 });
    assert.ok(m < 1.0);
  });

  it("applyStandingsPressureAdjustment shifts probabilities", () => {
    const probs = { home: 0.45, draw: 0.30, away: 0.25 };
    const homePressure = { intensity: 0.6 };
    const awayPressure = { intensity: -0.4 };
    const r = applyStandingsPressureAdjustment(probs, homePressure, awayPressure);
    assert.ok(r.home > probs.home);
  });
});
