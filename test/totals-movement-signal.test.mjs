import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTotalsMovement, overImpliedProb } from "../src/totals-movement-signal.js";

describe("大小球走势触发(totals-movement-signal)——挖掘出的唯一 z>4 真实 edge", () => {
  it("overImpliedProb de-vig 正确;缺赔率→null", () => {
    const p = overImpliedProb(1.9, 1.9);
    assert.ok(Math.abs(p - 0.5) < 1e-9);
    assert.equal(overImpliedProb(null, 1.9), null);
    assert.equal(overImpliedProb(1.9, 0), null);
  });
  it("缺收盘→null,不编造", () => {
    assert.equal(analyzeTotalsMovement({ openOverProb: 0.5 }), null);
  });
  it("只有收盘盘→不编造走势,标缺", () => {
    const r = analyzeTotalsMovement({ closeOverProb: 0.55 });
    assert.equal(r.move, null);
    assert.match(r.lean, /无初盘|无法判/);
  });
  it("大小球被加注(>4pp)→倾向大球·命中63%", () => {
    const r = analyzeTotalsMovement({ openOverProb: 0.50, closeOverProb: 0.58 });
    assert.equal(r.lean, "大球");
    assert.equal(r.empiricalOverRate, 0.63);
    assert.match(r.band, /🟢/);
  });
  it("大小球退烧(<-4pp)→倾向小球·大球仅44%", () => {
    const r = analyzeTotalsMovement({ openOverProb: 0.58, closeOverProb: 0.50 });
    assert.equal(r.lean, "小球");
    assert.equal(r.empiricalOverRate, 0.44);
  });
  it("深盘内'被加注'信号降级(历史不稳),不给 63% 假命中", () => {
    const r = analyzeTotalsMovement({ openOverProb: 0.55, closeOverProb: 0.62, ahDepth: 1.5 });
    assert.equal(r.lean, "大球");
    assert.equal(r.empiricalOverRate, null);
  });
  it("移动在阈值内→无走势信号", () => {
    const r = analyzeTotalsMovement({ openOverProb: 0.52, closeOverProb: 0.54 });
    assert.equal(r.lean, "无明显走势");
  });
});
