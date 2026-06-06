import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isScoreTopTemplate, isHalfFullTopTemplate } from "../src/odds-authenticity.js";

// 禁假编防线(2026-06-07 接线):管线用 scoreOdds.top/halfFullOdds.top 数组,
// 主客镜像对称的占位/模板盘(早盘未走盘)必须被识别→丢弃→回退 DC 矩阵,不当真盘展示。

describe("比分盘占位检测(isScoreTopTemplate)", () => {
  it("主客完全对称(1-0≈0-1, 2-0≈0-2, 2-1≈1-2, 3-0≈0-3)→ 占位=true", () => {
    const top = [
      { score: "1-0", odds: 7.5 }, { score: "0-1", odds: 7.5 },
      { score: "2-0", odds: 11 }, { score: "0-2", odds: 11 },
      { score: "2-1", odds: 9 }, { score: "1-2", odds: 9 },
      { score: "3-0", odds: 26 }, { score: "0-3", odds: 26 },
      { score: "1-1", odds: 6 }
    ];
    assert.equal(isScoreTopTemplate(top), true);
  });

  it("真盘:热门方比分赔率更低、主客不对称 → 占位=false", () => {
    const top = [
      { score: "1-0", odds: 6.0 }, { score: "0-1", odds: 12 },
      { score: "2-0", odds: 7.5 }, { score: "0-2", odds: 21 },
      { score: "2-1", odds: 8.0 }, { score: "1-2", odds: 17 },
      { score: "3-0", odds: 12 }, { score: "0-3", odds: 51 },
      { score: "1-1", odds: 7 }
    ];
    assert.equal(isScoreTopTemplate(top), false);
  });

  it("镜像对不足(<4对)→ 不轻判占位(false,不臆断)", () => {
    assert.equal(isScoreTopTemplate([{ score: "1-0", odds: 7 }, { score: "0-1", odds: 7 }]), false);
  });

  it("空/无效输入 → false", () => {
    assert.equal(isScoreTopTemplate(null), false);
    assert.equal(isScoreTopTemplate([]), false);
    assert.equal(isScoreTopTemplate({ top: [] }), false);
  });
});

describe("半全场盘占位检测(isHalfFullTopTemplate)", () => {
  it("主客镜像对称(主胜-主胜≈客胜-客胜 等)→ 占位=true", () => {
    const top = [
      { halfFull: "主胜-主胜", odds: 4.0 }, { halfFull: "客胜-客胜", odds: 4.0 },
      { halfFull: "主胜-客胜", odds: 41 }, { halfFull: "客胜-主胜", odds: 41 },
      { halfFull: "平局-主胜", odds: 6.5 }, { halfFull: "平局-客胜", odds: 6.5 },
      { halfFull: "平局-平局", odds: 5.5 }
    ];
    assert.equal(isHalfFullTopTemplate(top), true);
  });

  it("真盘:主客不对称 → false", () => {
    const top = [
      { halfFull: "主胜-主胜", odds: 3.2 }, { halfFull: "客胜-客胜", odds: 9.0 },
      { halfFull: "主胜-客胜", odds: 34 }, { halfFull: "客胜-主胜", odds: 51 },
      { halfFull: "平局-主胜", odds: 5.5 }, { halfFull: "平局-客胜", odds: 11 }
    ];
    assert.equal(isHalfFullTopTemplate(top), false);
  });

  it("空输入 → false", () => {
    assert.equal(isHalfFullTopTemplate([]), false);
    assert.equal(isHalfFullTopTemplate(null), false);
  });
});
