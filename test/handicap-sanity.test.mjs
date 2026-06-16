import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handicapSanity, handicapSanityText } from "../src/handicap-sanity.js";

describe("盘口合理性检查器(handicap-sanity·历史标准区间+临界值)", () => {
  it("缺线/缺隐含→null,不编造", () => {
    assert.equal(handicapSanity({ ahLine: -1.5 }), null);
    assert.equal(handicapSanity({ p1x2Fav: 0.65 }), null);
    assert.equal(handicapSanity({ ahLine: -1.5, p1x2Fav: 1.2 }), null);
  });
  it("法国型:让-1.5+热门65% < 让1.5下限68.7% → 过深·低3.7pp", () => {
    const s = handicapSanity({ ahLine: -1.5, p1x2Fav: 0.65 });
    assert.equal(s.verdict, "过深");
    assert.ok(Math.abs(s.gapPp - 3.7) < 0.2, `应低约3.7pp, 实际${s.gapPp}`);
    assert.equal(s.exceeded, true);
    assert.match(handicapSanityText(s), /过深|让太多/);
  });
  it("挪威型:让1.5+热门80% > 让1.5上限74.8% → 过浅·高5.2pp", () => {
    const s = handicapSanity({ ahLine: 1.5, p1x2Fav: 0.80 });
    assert.equal(s.verdict, "过浅");
    assert.ok(Math.abs(s.gapPp - 5.2) < 0.3, `应高约5.2pp, 实际${s.gapPp}`);
  });
  it("区间内→合理(让-1.5+热门71%=中位附近)", () => {
    const s = handicapSanity({ ahLine: -1.5, p1x2Fav: 0.71 });
    assert.equal(s.verdict, "合理");
    assert.equal(s.exceeded, false);
  });
  it("阿根廷型:让-1.5+68%=临界擦下限(68.7) → 过深·仅0.7pp", () => {
    const s = handicapSanity({ ahLine: -1.5, p1x2Fav: 0.68 });
    assert.equal(s.verdict, "过深");
    assert.ok(s.gapPp <= 1, `临界微深≤1pp, 实际${s.gapPp}`);
  });
  it("无对应历史档(让3.5)→标无样本不硬套", () => {
    const s = handicapSanity({ ahLine: -3.5, p1x2Fav: 0.92 });
    assert.equal(s.band, null);
    assert.match(s.verdict, /无该线/);
  });
});
