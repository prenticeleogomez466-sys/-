import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainXgPerMatch, teamChainXgAverage, compareChainXg, chainToLambdaAdjustment } from "../src/xg-chains.js";
import { timeWeight, computeWeights, weightedAverage, weightedPpg, weightedXg, effectiveSampleSize } from "../src/time-decay-weighting.js";
import { adjustMatchOutcome, adjustedFormSummary, compareAdjustedForm } from "../src/opponent-strength-adjustment.js";
import { adjustMatchPossession, teamPossessionAdjustedAverage, comparePossessionStyles } from "../src/possession-adjusted-xg.js";

describe("xg-chains", () => {
  it("returns 0 for empty events", () => {
    assert.equal(chainXgPerMatch([]), 0);
  });

  it("accumulates shot xG + build-up", () => {
    const v = chainXgPerMatch([
      { isShot: true, xg: 0.2, chainLength: 5, completedPasses: 4 },
      { isShot: true, xg: 0.1, chainLength: 3, completedPasses: 2 }
    ]);
    assert.ok(v > 0.3);  // 0.2 + 0.1 + build-up
  });

  it("teamChainXgAverage handles multiple matches", () => {
    const r = teamChainXgAverage([
      { events: [{ isShot: true, xg: 1.5, chainLength: 4, completedPasses: 3 }] },
      { events: [{ isShot: true, xg: 0.8, chainLength: 2, completedPasses: 2 }] }
    ]);
    assert.equal(r.matches, 2);
    assert.ok(r.avgChainXg > 1.0);
  });

  it("compareChainXg classifies edge", () => {
    const r = compareChainXg({ avgChainXg: 1.8 }, { avgChainXg: 1.0 });
    assert.equal(r.homeProductionEdge, "strong");
  });

  it("chainToLambdaAdjustment clamps to [0.7, 1.4]", () => {
    assert.equal(chainToLambdaAdjustment(1.0, 5.0), 1.4);
    assert.equal(chainToLambdaAdjustment(1.0, 0.1), 0.7);
    assert.equal(chainToLambdaAdjustment(1.0, 1.2), 1.2);
  });
});

describe("time-decay-weighting", () => {
  it("recent match has weight ~1", () => {
    const w = timeWeight(Date.now() - 1 * 24 * 3600 * 1000);
    assert.ok(w > 0.99 && w <= 1.0);
  });

  it("90-day-old match has weight 0.5 (half-life)", () => {
    const w = timeWeight(Date.now() - 90 * 24 * 3600 * 1000);
    assert.ok(Math.abs(w - 0.5) < 0.01);
  });

  it("180-day-old match has weight 0.25", () => {
    const w = timeWeight(Date.now() - 180 * 24 * 3600 * 1000);
    assert.ok(Math.abs(w - 0.25) < 0.01);
  });

  it("weightedPpg gives more weight to recent matches", () => {
    const now = Date.now();
    const matches = [
      { date: new Date(now - 1 * 86400000), result: "W" },  // 1 day ago: W (3pts, weight ~1)
      { date: new Date(now - 200 * 86400000), result: "L" } // 200 days ago: L (0pts, weight ~0.22)
    ];
    const ppg = weightedPpg(matches);
    assert.ok(ppg > 2.0);  // 接近 3
  });

  it("effectiveSampleSize <= number of matches", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ date: new Date(Date.now() - i * 30 * 86400000) });
    }
    const ess = effectiveSampleSize(matches);
    assert.ok(ess > 0 && ess < 10);
  });

  it("weightedXg returns xgFor + xgAgainst weighted", () => {
    const matches = [
      { date: new Date(), xgFor: 2.0, xgAgainst: 1.0 },
      { date: new Date(Date.now() - 365 * 86400000), xgFor: 0.5, xgAgainst: 3.0 }
    ];
    const r = weightedXg(matches);
    assert.ok(r.xgFor > 1.5);  // 近期 xgFor=2 主导
  });
});

describe("opponent-strength-adjustment", () => {
  it("losing to strong opponent → adjusted points > 0", () => {
    const r = adjustMatchOutcome({ result: "L", goalDiff: -1, opponentElo: 1900 });
    assert.ok(r.adjustedPoints > 0);
    assert.equal(r.interpretation, "输强队,样本含金量低(不应严罚)");
  });

  it("beating weak opponent → adjusted points < 3", () => {
    const r = adjustMatchOutcome({ result: "W", goalDiff: 3, opponentElo: 1100 });
    assert.ok(r.adjustedPoints < 3);
    assert.equal(r.interpretation, "赢弱队,样本含金量低");
  });

  it("adjustedFormSummary detects inflation", () => {
    const matches = [
      { result: "W", goalDiff: 2, opponentElo: 1100 },
      { result: "W", goalDiff: 1, opponentElo: 1200 },
      { result: "W", goalDiff: 3, opponentElo: 1000 }
    ];
    const r = adjustedFormSummary(matches);
    assert.ok(r.qualityInflation < 0);  // 全刷弱队 → 应负 inflation
    assert.ok(r.qualityVerdict.includes("高估"));
  });

  it("compareAdjustedForm picks higher quality side", () => {
    const home = { adjustedPpg: 2.3 };
    const away = { adjustedPpg: 1.2 };
    const r = compareAdjustedForm(home, away);
    assert.ok(r.gap > 1);
    assert.ok(r.interpretation.includes("主队"));
  });
});

describe("possession-adjusted-xg", () => {
  it("adjustMatchPossession boosts xG for low-possession team", () => {
    const r = adjustMatchPossession({ xgFor: 1.0, xgAgainst: 1.5, possession: 30 });
    assert.ok(r.padjXgFor > r.rawXgFor);  // 30% 控球 → boost
    assert.ok(r.padjXgAgainst < r.rawXgAgainst);
  });

  it("classifies counter-attack style", () => {
    const r = adjustMatchPossession({ xgFor: 2.0, xgAgainst: 1.0, possession: 35 });
    assert.equal(r.style, "counter-attack");
  });

  it("handles missing possession safely", () => {
    const r = adjustMatchPossession({ xgFor: 1.0, xgAgainst: 1.0 });
    assert.equal(r.padjXgFor, 1.0);
    assert.equal(r.note, "no-possession-data");
  });

  it("teamPossessionAdjustedAverage aggregates", () => {
    const matches = [
      { xgFor: 1.5, xgAgainst: 1.0, possession: 40 },
      { xgFor: 2.0, xgAgainst: 1.2, possession: 35 }
    ];
    const r = teamPossessionAdjustedAverage(matches);
    assert.equal(r.sampleSize, 2);
    assert.ok(r.avgPadjXgFor > r.avgRawXgFor);
  });

  it("comparePossessionStyles classifies matchup", () => {
    const home = { dominantStyle: "possession-dominant", avgPadjXgFor: 2.0, avgPadjXgAgainst: 0.8 };
    const away = { dominantStyle: "counter-attack", avgPadjXgFor: 1.5, avgPadjXgAgainst: 1.5 };
    const r = comparePossessionStyles(home, away);
    assert.ok(r.matchup.includes("反击"));
  });
});
