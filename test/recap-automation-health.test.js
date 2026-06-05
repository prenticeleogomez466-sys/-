import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMorningRecapTrigger } from "../src/recap-automation-health.js";

describe("recap 健康检查·上午11点窗口触发匹配(isMorningRecapTrigger)", () => {
  it("11:00 整点 → true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:00:00+08:00"]), true);
  });

  it("11:10(实际加固后任务时间)→ true(旧逻辑死磕 T11:00 会误判 false → 整条 recap 假失败)", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:10:00+08:00"]), true);
  });

  it("11:15(失败重试/分钟级重排)→ true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T11:15:00+08:00"]), true);
  });

  it("非数组单值也兼容", () => {
    assert.equal(isMorningRecapTrigger("2026-06-05T11:10:00+08:00"), true);
  });

  it("不在 11 点窗口(10:59 / 12:00)→ false", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T10:59:00+08:00"]), false);
    assert.equal(isMorningRecapTrigger(["2026-06-05T12:00:00+08:00"]), false);
  });

  it("多触发只要有一个在窗口内 → true", () => {
    assert.equal(isMorningRecapTrigger(["2026-06-05T03:00:00+08:00", "2026-06-05T11:10:00+08:00"]), true);
  });

  it("空/无效输入 → false(不臆断)", () => {
    assert.equal(isMorningRecapTrigger([]), false);
    assert.equal(isMorningRecapTrigger(null), false);
  });
});
