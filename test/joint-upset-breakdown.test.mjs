import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jointUpsetBreakdown } from "../src/upset-trap-detector.js";

// 平局+爆冷联合概率守护(2026-06-18 工作流B)。锁口径:纯市场devig拆解·drawShare定失败模式·不编加成。
describe("平局+爆冷联合拆解 jointUpsetBreakdown", () => {
  it("缺市场/非法 → null(诚实)", () => {
    assert.equal(jointUpsetBreakdown(null), null);
    assert.equal(jointUpsetBreakdown({ home: 0.5 }), null);
  });

  it("平局为最大(无单边热门)→ null", () => {
    assert.equal(jointUpsetBreakdown({ home: 0.30, draw: 0.40, away: 0.30 }), null);
  });

  it("热门不胜 = 平局 + 冷胜(市场devig·和恒等)", () => {
    const r = jointUpsetBreakdown({ home: 0.55, draw: 0.27, away: 0.18 });
    assert.equal(r.favSide, "home");
    assert.equal(r.favWin, 0.55);
    assert.equal(r.draw, 0.27);
    assert.equal(r.dogWin, 0.18);
    assert.equal(r.notWin, 0.45);
    assert.ok(Math.abs(r.drawShare - 0.27 / 0.45) < 1e-6); // 0.6
  });

  it("平局占比高(≥58%)→ 偏被逼平 + 双选含平指引", () => {
    const r = jointUpsetBreakdown({ home: 0.52, draw: 0.33, away: 0.15 }); // drawShare=0.33/0.48=0.69
    assert.equal(r.failureMode, "偏被逼平(磨平)");
    assert.match(r.guidance, /双选含平|1X/);
  });

  it("被翻盘占比高(drawShare≤42%)→ 偏被翻盘 + 平局护不住指引", () => {
    const r = jointUpsetBreakdown({ home: 0.50, draw: 0.18, away: 0.32 }); // drawShare=0.18/0.50=0.36
    assert.equal(r.failureMode, "偏被翻盘(真冷)");
    assert.match(r.guidance, /翻盘|护不住|观望/);
  });

  it("客队为热门时方向正确", () => {
    const r = jointUpsetBreakdown({ home: 0.18, draw: 0.27, away: 0.55 });
    assert.equal(r.favSide, "away");
    assert.equal(r.dogWin, 0.18); // 主胜=冷门
  });
});
