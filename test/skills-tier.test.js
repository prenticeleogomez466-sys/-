import assert from "node:assert/strict";
import { describe, it } from "node:test";
// 2026-06-11 融合大扫除:conformal-prediction/feature-importance/bankroll-risk-management 死模块已删,保留生产模块 clv-tracker/asian-handicap-water 测试。
import { computeCLV, buildCLVTracker } from "../src/clv-tracker.js";
import { classifyWaterLevel, analyzeAsianHandicapWater, analyzeMultipleBookmakers } from "../src/asian-handicap-water.js";

describe("clv-tracker", () => {
  it("computeCLV positive when closing < bet odds", () => {
    // 下注 2.10,收盘 1.95 → 庄家压低 → 我们抓到价
    const r = computeCLV(2.10, 1.95);
    assert.ok(r.clv > 0, `clv=${r.clv}`);
    assert.ok(["positive", "strong-positive"].includes(r.verdict));
  });

  it("computeCLV negative when closing > bet odds", () => {
    // 下注 1.95,收盘 2.10 → 我们追的高 → 输价
    const r = computeCLV(1.95, 2.10);
    assert.ok(r.clv < 0);
    assert.ok(["negative", "neutral"].includes(r.verdict));
  });

  it("computeCLV invalid for bad input", () => {
    assert.equal(computeCLV(1.0, 2.0).clv, null);
    assert.equal(computeCLV("foo", "bar").clv, null);
  });

  it("tracker summary positive when most bets beat closing", () => {
    const t = buildCLVTracker();
    for (let i = 0; i < 10; i++) {
      t.recordBet({ fixtureId: `f${i}`, outcome: "home", betOdds: 2.10 });
      t.recordClose({ fixtureId: `f${i}`, outcome: "home", closingOdds: 1.95 });
    }
    const s = t.summary();
    assert.equal(s.ok, true);
    assert.equal(s.samples, 10);
    assert.equal(s.positiveRate, 1);
    assert.equal(s.longTermProfitable, true);
  });
});

describe("asian-handicap-water", () => {
  it("classifyWaterLevel buckets correctly", () => {
    assert.equal(classifyWaterLevel(0.70).level, "very-low");
    assert.equal(classifyWaterLevel(0.85).level, "low");
    assert.equal(classifyWaterLevel(0.95).level, "mid-low");   // 0.95 < 0.96 cut = mid-low
    assert.equal(classifyWaterLevel(1.00).level, "neutral");   // 0.96 <= x <= 1.05
    assert.equal(classifyWaterLevel(1.10).level, "mid-high");
    assert.equal(classifyWaterLevel(1.30).level, "very-high");
  });

  it("analyzeAsianHandicapWater detects 主队降水 (warning sign)", () => {
    const r = analyzeAsianHandicapWater({
      earlyHome: 0.95, earlyAway: 0.95, line: -1,
      lateHome: 0.82, lateAway: 1.10
    });
    assert.equal(r.movement, "主队降水");
    assert.equal(r.signal, "danger-home");
    assert.ok(r.implication.includes("dangerous"));
  });

  it("analyzeAsianHandicapWater detects 平稳", () => {
    const r = analyzeAsianHandicapWater({
      earlyHome: 0.95, earlyAway: 0.95, line: 0,
      lateHome: 0.96, lateAway: 0.94
    });
    assert.equal(r.movement, "水位平稳");
  });

  it("analyzeMultipleBookmakers consensus", () => {
    const r = analyzeMultipleBookmakers([
      { bookmaker: "皇冠", earlyHome: 0.95, earlyAway: 0.95, lateHome: 0.82, lateAway: 1.10, line: -1 },
      { bookmaker: "澳门", earlyHome: 0.94, earlyAway: 0.96, lateHome: 0.83, lateAway: 1.08, line: -1 },
      { bookmaker: "立博", earlyHome: 0.95, earlyAway: 0.95, lateHome: 0.85, lateAway: 1.05, line: -1 }
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.consensus.signal, "danger-home");
    assert.equal(r.consistency, 1);  // 3/3 一致
  });
});
