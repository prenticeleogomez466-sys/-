import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { optimizeTicket } from "../src/ticket-optimizer.js";

const leg = (h, d, a) => ({ probs: [h, d, a], codes: ["3", "1", "0"] });

describe("彩票构造优化器", () => {
  it("预算1(只能全单选):每腿覆盖1、成本1", () => {
    const r = optimizeTicket([leg(0.6, 0.25, 0.15), leg(0.5, 0.3, 0.2)], { budget: 1 });
    assert.equal(r.cost, 1);
    assert.ok(r.legs.every((l) => l.cover === 1));
    assert.ok(Math.abs(r.jointHitProb - 0.6 * 0.5) < 1e-6);
  });

  it("预算充足:把覆盖加在边际收益最高的腿,联合命中升、成本≤预算", () => {
    const legs = [leg(0.8, 0.13, 0.07), leg(0.45, 0.30, 0.25), leg(0.4, 0.32, 0.28)];
    const r = optimizeTicket(legs, { budget: 8 });
    assert.ok(r.cost <= 8);
    assert.ok(r.jointHitProb > r.baselineHitProb, "优化后联合命中应高于全单选");
    // 强腿(0.80)该保持单选,弱腿优先加保险
    const strong = r.legs[0];
    assert.equal(strong.cover, 1, "0.80 强腿应留单选(边际收益低)");
  });

  it("覆盖优先级:弱均势腿比强腿先获得双选", () => {
    const legs = [leg(0.85, 0.1, 0.05), leg(0.38, 0.34, 0.28)];
    const r = optimizeTicket(legs, { budget: 2 });
    // 只能升级一腿 → 应升级弱腿(index1)
    assert.equal(r.legs[1].cover, 2);
    assert.equal(r.legs[0].cover, 1);
  });

  it("成本恒为各腿覆盖数乘积、不超预算", () => {
    const legs = Array.from({ length: 9 }, () => leg(0.4, 0.33, 0.27));
    const r = optimizeTicket(legs, { budget: 64 });
    const cost = r.legs.reduce((m, l) => m * l.cover, 1);
    assert.equal(r.cost, cost);
    assert.ok(cost <= 64);
  });

  it("空输入/异常安全降级", () => {
    assert.equal(optimizeTicket([], { budget: 10 }).cost, 0);
    assert.equal(optimizeTicket(null).jointHitProb, 0);
  });
});
