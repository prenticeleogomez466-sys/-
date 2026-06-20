import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeExpectedValueLabels } from "../src/prediction-engine.js";

// 2026-06-20:原 ev-and-combo.test.js 拆出。combo-builder.js(旧二串一·+EV前提与"公开盘打不过市场·串关EV恒负"回测铁证冲突)
//   已删,生产串关走 parlay-builder.js;本文件只保留生产函数 computeExpectedValueLabels 的守护。
describe("computeExpectedValueLabels", () => {
  it("computes positive EV when probability beats implied probability", () => {
    // p=0.55, odds=2.1 -> EV = 0.55 * 2.1 - 1 = 0.155
    const ranked = [
      { code: "3", label: "主胜", probability: 0.55 },
      { code: "1", label: "平局", probability: 0.25 }
    ];
    const snapshot = { europeanOdds: { current: { home: 2.1, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    assert.ok(result);
    assert.equal(result.primary.code, "3");
    assert.ok(Math.abs(result.primary.ev - 0.155) < 0.001, `got EV ${result.primary.ev}`);
    assert.equal(result.primary.valueBet, true);
    // 0.155 > 0.15 阈值,所以 verdict 是 strong-value
    assert.equal(result.primary.verdict, "strong-value");
  });

  it("marks strong-value when EV > 0.15", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.6 }];
    const snapshot = { europeanOdds: { current: { home: 2.5, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    // 0.6 * 2.5 - 1 = 0.5
    assert.equal(result.primary.verdict, "strong-value");
    assert.equal(result.primary.valueBet, true);
  });

  it("marks negative-ev when odds too low", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.50 }];
    const snapshot = { europeanOdds: { current: { home: 1.5, draw: 3.4, away: 6.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    // 0.50 * 1.5 - 1 = -0.25
    assert.equal(result.primary.valueBet, false);
    assert.equal(result.primary.verdict, "negative-ev");
  });

  it("returns null when snapshot has no european odds", () => {
    assert.equal(computeExpectedValueLabels([{ code: "3", label: "主胜", probability: 0.55 }], null), null);
    assert.equal(computeExpectedValueLabels([{ code: "3", label: "主胜", probability: 0.55 }], { europeanOdds: null }), null);
  });

  it("returns ev=null for legs with invalid odds (NaN, 1.0)", () => {
    const ranked = [{ code: "3", label: "主胜", probability: 0.55 }];
    const snapshot = { europeanOdds: { current: { home: 1.0, draw: 3.4, away: 3.5 } } };
    const result = computeExpectedValueLabels(ranked, snapshot);
    assert.equal(result.primary.ev, null);
    assert.equal(result.primary.valueBet, false);
  });
});
