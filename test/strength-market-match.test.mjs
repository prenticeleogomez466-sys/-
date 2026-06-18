import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessStrengthVsMarket, favLineForProb, ppgOf } from "../src/strength-market-match.js";

describe("实力↔盘口匹配度(独立Elo实力 vs 盘口定价)", () => {
  it("favLineForProb:胜率→历史让球线反查(高胜率=深线)", () => {
    assert.ok(favLineForProb(0.62) >= 1);       // ~62% 对应一球档
    assert.ok(favLineForProb(0.37) <= 0.25);     // ~37% 对应平手/微让
    assert.equal(favLineForProb(NaN), null);
  });
  it("ppgOf 近5场均分", () => {
    assert.equal(ppgOf({ w: 3, d: 1, l: 1, n: 5 }), 2);
    assert.equal(ppgOf(null), null);
  });
  it("盘口与实力匹配→合理", () => {
    const r = assessStrengthVsMarket({
      eloProb: { home: 0.60, draw: 0.24, away: 0.16 }, eloDiff: 120,
      marketFavProb: 0.61, favSideIsHome: true, marketLineAbs: 1,
      homeForm: { w: 4, d: 1, l: 0, n: 5, gf: 2, ga: 0.6 }, awayForm: { w: 1, d: 1, l: 3, n: 5, gf: 0.8, ga: 1.8 },
    });
    assert.equal(r.severity, "ok");
    assert.match(r.verdict, /匹配·合理/);
  });
  it("盘口比实力更看好热门→高估", () => {
    const r = assessStrengthVsMarket({
      eloProb: { home: 0.45, draw: 0.27, away: 0.28 }, eloDiff: 40,
      marketFavProb: 0.62, favSideIsHome: true, marketLineAbs: 1,
      homeForm: null, awayForm: null,
    });
    assert.match(r.verdict, /高估热门/);
    assert.ok(r.probGapPp >= 8);
  });
  it("盘口热门方与Elo强队相反→方向背离(强信市场)", () => {
    const r = assessStrengthVsMarket({
      eloProb: { home: 0.30, draw: 0.27, away: 0.43 }, eloDiff: -90,   // Elo:客队强
      marketFavProb: 0.55, favSideIsHome: true, marketLineAbs: 1,       // 盘口:主队热门
      homeForm: null, awayForm: null,
    });
    assert.match(r.verdict, /方向背离/);
    assert.equal(r.severity, "high");
  });
  it("Elo先验缺→返回null(不拿盘口循环冒充实力)", () => {
    assert.equal(assessStrengthVsMarket({ eloProb: null }), null);
  });
});
