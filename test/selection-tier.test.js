import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectionTier, marketFavProbOf, tierOfPrediction, SELECTION_TIERS } from "../src/selection-tier.js";

describe("选择分层(市场隐含概率定档 + 回测命中率)", () => {
  it("档位随市场热门概率单调:越高档命中越高", () => {
    const hi = selectionTier(0.85), mid = selectionTier(0.68), lo = selectionTier(0.40);
    assert.ok(hi.backtestHit > mid.backtestHit, "强档命中应高于中档");
    assert.ok(mid.backtestHit > lo.backtestHit, "中档命中应高于硬币档");
    assert.ok(hi.backtestHit >= 0.8, "≥0.80 档命中应≥80%");
  });

  it("bankerEligible 仅在市场热门 ≥0.65 为真(够格做胆/单选)", () => {
    assert.equal(selectionTier(0.80).bankerEligible, true);
    assert.equal(selectionTier(0.66).bankerEligible, true);
    assert.equal(selectionTier(0.60).bankerEligible, false);
    assert.equal(selectionTier(0.40).bankerEligible, false);
  });

  it("marketFavProbOf 优先市场隐含,缺则退最终融合概率", () => {
    const withMarket = { marketImpliedProbabilities: { home: 0.7, draw: 0.2, away: 0.1 }, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } };
    assert.equal(marketFavProbOf(withMarket), 0.7, "应取市场隐含的 max");
    const noMarket = { marketImpliedProbabilities: null, probabilities: { home: 0.55, draw: 0.25, away: 0.2 } };
    assert.equal(marketFavProbOf(noMarket), 0.55, "无市场时退融合概率 max");
  });

  it("tierOfPrediction 端到端给出档位 + 回测命中", () => {
    const t = tierOfPrediction({ marketImpliedProbabilities: { home: 0.76, draw: 0.16, away: 0.08 } });
    assert.ok(t.bankerEligible);
    assert.ok(t.backtestHit > 0.7);
    assert.equal(t.marketFavProb, 0.76);
  });

  it("异常/缺概率安全降级到最低档", () => {
    const t = selectionTier(NaN);
    assert.equal(t.key, SELECTION_TIERS[SELECTION_TIERS.length - 1].key);
    assert.equal(marketFavProbOf({}), null);
  });
});
