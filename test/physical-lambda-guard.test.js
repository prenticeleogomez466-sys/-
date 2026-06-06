import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPhysicalLambda } from "../src/prediction-engine.js";

// 🔴 永久铁律·最高指令(2026-06-06):绝不用不可信数据。DC 对薄样本/高方差队(国际赛友谊)
// 会拟合出不物理的 λ(斯洛伐克 λ主5.75、匈牙利合计5.7球),这种垃圾值不准进混合污染推荐。
// 物理界:单队 λ≤3.5 且 合计≤5.0(正常足球 1.5~3.5 球)。

describe("物理 λ 闸(isPhysicalLambda)—— 不可信垃圾 λ 必须判 false", () => {
  it("正常足球 λ → 可信(true)", () => {
    assert.equal(isPhysicalLambda({ home: 1.33, away: 0.91 }), true); // 鹿岛v神户 真实
    assert.equal(isPhysicalLambda({ home: 1.30, away: 1.56 }), true); // 川崎v广岛 真实
    assert.equal(isPhysicalLambda({ home: 2.2, away: 1.1 }), true);
  });

  it("国际赛垃圾 λ(单队>3.5)→ 不可信(false)", () => {
    assert.equal(isPhysicalLambda({ home: 5.75, away: 1.28 }), false); // 斯洛伐克v黑山 真实垃圾
  });

  it("合计>5.0 → 不可信(false)", () => {
    assert.equal(isPhysicalLambda({ home: 2.65, away: 3.07 }), false); // 匈牙利v芬兰 真实垃圾(总5.72)
  });

  it("边界:恰 3.5/队、合计 5.0 → 仍可信", () => {
    assert.equal(isPhysicalLambda({ home: 3.5, away: 1.5 }), true);
    assert.equal(isPhysicalLambda({ home: 2.5, away: 2.5 }), true);
  });

  it("缺值/NaN → 不可信(false,不臆断)", () => {
    assert.equal(isPhysicalLambda({ home: 5, away: null }), false);
    assert.equal(isPhysicalLambda(null), false);
    assert.equal(isPhysicalLambda({}), false);
  });
});
