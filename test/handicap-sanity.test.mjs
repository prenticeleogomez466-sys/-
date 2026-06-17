import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handicapSanity, handicapSanityText, europeanBand, ouBand, waterSanity, sanityVerdictLabel } from "../src/handicap-sanity.js";

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

describe("欧赔/大小球正常区间(europeanBand/ouBand·盘口合理性逐玩法对比)", () => {
  it("europeanBand 按亚盘线锚强度档→热门胜/平/客十进制区间", () => {
    const b = europeanBand(-1.25);
    assert.equal(b.refLine, 1.25);
    assert.deepEqual(b.win, [1.37, 1.43, 1.5]);
    assert.ok(b.draw[0] < b.draw[2] && b.dog[0] < b.dog[2]);
  });
  it("europeanBand 缺线/无对应档→null,不硬套", () => {
    assert.equal(europeanBand(null), null);
    assert.equal(europeanBand(-3.5), null);
  });
  it("ouBand 按大球隐含%落档→over区间+under中位", () => {
    const b = ouBand(0.6);
    assert.equal(b.lo, 0.55);
    assert.deepEqual(b.over, [1.48, 1.61, 1.72]);
    assert.equal(b.underMid, 2.32);
  });
  it("ouBand 非法隐含→null", () => {
    assert.equal(ouBand(0), null);
    assert.equal(ouBand(1.2), null);
  });
});

describe("亚盘水位合理性(waterSanity·HK↔decimal自适应+失衡判读)", () => {
  it("HK盘口(<1.5)自动+1换算成decimal对历史带", () => {
    const w = waterSanity(0.98, 0.86);
    assert.equal(w.homeDec, 1.98);
    assert.equal(w.awayDec, 1.86);
    assert.equal(w.homeVerdict, "正常");
  });
  it("decimal盘口(≥1.5)原样判", () => {
    const w = waterSanity(1.95, 1.90);
    assert.equal(w.homeDec, 1.95);
    assert.equal(w.lean, "均衡");
  });
  it("一侧水位明显更低→判钱压该侧过盘", () => {
    const w = waterSanity(0.86, 0.98);  // 主水更低
    assert.match(w.lean, /钱压主队过盘/);
    assert.ok(w.gap <= -0.08);
  });
  it("两水皆缺→null,不编造", () => {
    assert.equal(waterSanity(null, null), null);
    assert.equal(waterSanity(0, 0), null);
  });
});

describe("深浅裁决分级(sanityVerdictLabel·擦边<1.5pp=🟡临界不夸大·≥1.5pp才🔴)", () => {
  it("区间内→🟢合理", () => {
    const s = handicapSanity({ ahLine: -1.5, p1x2Fav: 0.71 });
    assert.equal(sanityVerdictLabel(s).tag, "🟢合理");
  });
  it("仅差<1.5pp→🟡临界(接近常态·不标🔴吓人)", () => {
    const s = handicapSanity({ ahLine: -1.5, p1x2Fav: 0.68 }); // 过深约0.7pp
    const v = sanityVerdictLabel(s);
    assert.equal(v.marginal, true);
    assert.match(v.tag, /🟡临界/);
    assert.doesNotMatch(v.tag, /🔴/);
  });
  it("差≥1.5pp→🔴(明显异常)", () => {
    const s = handicapSanity({ ahLine: 1.5, p1x2Fav: 0.80 }); // 过浅约5.2pp
    const v = sanityVerdictLabel(s);
    assert.equal(v.severe, true);
    assert.match(v.tag, /🔴过浅/);
  });
  it("缺band→—", () => {
    assert.equal(sanityVerdictLabel(null).tag, "—");
  });
});
