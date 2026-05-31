import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calibrateOver25, loadOverUnderCalibration, __resetOverUnderCalibrationForTests } from "../src/overunder-calibration.js";

describe("overunder-calibration 自主大小球校准层", () => {
  test("非法入参返回 null,绝不编造", () => {
    __resetOverUnderCalibrationForTests();
    assert.equal(calibrateOver25(NaN), null);
    assert.equal(calibrateOver25(undefined), null);
    assert.equal(calibrateOver25("0.5"), null);
  });

  test("有 profile 时校准值落 [0,1] 且单调(p 越大校准越大)", () => {
    __resetOverUnderCalibrationForTests();
    const prof = loadOverUnderCalibration();
    if (!prof) return; // profile 未训练则跳过(CI 无 exports)
    const lo = calibrateOver25(0.3);
    const hi = calibrateOver25(0.7);
    assert.ok(lo >= 0 && lo <= 1, "校准值在 [0,1]");
    assert.ok(hi >= 0 && hi <= 1, "校准值在 [0,1]");
    assert.ok(hi >= lo, "isotonic 单调不减");
  });

  test("profile 缺 isotonicMap/usable 时 loader 不返回坏对象", () => {
    __resetOverUnderCalibrationForTests();
    const prof = loadOverUnderCalibration();
    if (prof) assert.ok(prof.usable && prof.isotonicMap?.knots?.length, "只在 usable+有 knots 时返回");
  });
});
