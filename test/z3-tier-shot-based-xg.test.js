import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateShotConversion,
  shotXgProxy,
  regressedGoalSignal,
  annotateRegressedGoals
} from "../src/shot-based-xg.js";
import { fitFromMatches } from "../src/dixon-coles-engine.js";

// 构造合成数据:进球 = 0.3·SOT(射偏不贡献),校准应能复原 sotRate≈0.3, offTargetRate≈0
function syntheticMatches(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const hSot = 2 + (i % 6); // 2..7
    const aSot = 1 + (i % 5); // 1..5
    out.push({
      home: `H${i}`, away: `A${i}`, date: `2024-01-${String((i % 27) + 1).padStart(2, "0")}`,
      shots: { home: hSot + 6, away: aSot + 5 }, // 射偏一堆但不该贡献
      sot: { home: hSot, away: aSot },
      homeGoals: Math.round(0.3 * hSot),
      awayGoals: Math.round(0.3 * aSot)
    });
  }
  return out;
}

test("calibrateShotConversion 从合成数据复原射正转化率,射偏≈0", () => {
  const conv = calibrateShotConversion(syntheticMatches(60));
  assert.ok(conv, "样本足够应返回校准结果");
  assert.ok(conv.sotRate > 0.2 && conv.sotRate < 0.45, `sotRate 应接近 0.3,实得 ${conv.sotRate}`);
  assert.ok(conv.offTargetRate < 0.05, `射偏边际应接近 0,实得 ${conv.offTargetRate}`);
  assert.ok(conv.samples >= 100, "60 场 × 2 边 = 120 样本");
});

test("calibrateShotConversion 样本不足返回 null", () => {
  assert.equal(calibrateShotConversion(syntheticMatches(3)), null);
  assert.equal(calibrateShotConversion([]), null);
});

test("shotXgProxy 用转化率算期望进球,缺数据返回 null", () => {
  const conv = { sotRate: 0.3, offTargetRate: 0.02 };
  assert.equal(shotXgProxy({ shots: 10, sot: 5 }, conv), 0.3 * 5 + 0.02 * 5);
  assert.equal(shotXgProxy({ shots: 10, sot: 5 }, null), null, "无 conversion 返回 null");
  assert.equal(shotXgProxy({ shots: NaN, sot: 5 }, conv), null, "缺数据返回 null");
});

test("regressedGoalSignal 按权重在实际进球与期望间插值", () => {
  assert.equal(regressedGoalSignal(3, 1, 0), 3, "weight=0 → 纯实际");
  assert.equal(regressedGoalSignal(3, 1, 1), 1, "weight=1 → 纯期望");
  assert.equal(regressedGoalSignal(3, 1, 0.5), 2, "weight=0.5 → 中点");
  assert.equal(regressedGoalSignal(3, NaN, 0.5), 3, "无期望退回实际");
});

test("annotateRegressedGoals 替换进球为去噪信号且保留原值", () => {
  const matches = syntheticMatches(60);
  const res = annotateRegressedGoals(matches, { weight: 0.5 });
  assert.ok(res.conversion, "应自校准出 conversion");
  assert.equal(res.applied, 60, "所有场次都有 shots/sot");
  const sample = res.matches[0];
  assert.equal(sample._rawHomeGoals, matches[0].homeGoals, "保留原始实际进球");
  assert.ok(sample._xg && Number.isFinite(sample._xg.home), "带 xG 审计字段");
  assert.notEqual(res.matches, matches, "不修改原数组引用");
  // 去噪后信号应落在实际进球与期望之间
  const lo = Math.min(sample._rawHomeGoals, sample._xg.home);
  const hi = Math.max(sample._rawHomeGoals, sample._xg.home);
  assert.ok(sample.homeGoals >= lo - 1e-9 && sample.homeGoals <= hi + 1e-9);
});

test("annotateRegressedGoals 无 shots 数据时安全降级", () => {
  const matches = [{ home: "A", away: "B", homeGoals: 2, awayGoals: 1, date: "2024-01-01" }];
  const res = annotateRegressedGoals(matches);
  assert.equal(res.conversion, null, "无 shots 无法校准");
  assert.equal(res.applied, 0);
  assert.equal(res.matches[0].homeGoals, 2, "进球不变");
});

test("fitFromMatches goalSignal=shot-regressed 标注元数据并产可用拟合", () => {
  // 80 场带 shots/sot 的合成对局,够过 minMatches 门槛
  const teams = ["甲", "乙", "丙", "丁", "戊", "己"];
  const matches = [];
  for (let i = 0; i < 80; i++) {
    const h = teams[i % teams.length];
    const a = teams[(i + 1) % teams.length];
    const hSot = 3 + (i % 4), aSot = 2 + (i % 3);
    matches.push({
      home: h, away: a, date: `2024-${String((i % 12) + 1).padStart(2, "0")}-15`,
      homeGoals: Math.round(0.3 * hSot), awayGoals: Math.round(0.3 * aSot),
      shots: { home: hSot + 5, away: aSot + 4 }, sot: { home: hSot, away: aSot }
    });
  }
  const actual = fitFromMatches(matches, { referenceDate: "2024-12-31" });
  const shot = fitFromMatches(matches, { referenceDate: "2024-12-31", goalSignal: "shot-regressed" });
  assert.equal(actual.goalSignal, "actual", "默认走实际进球");
  assert.equal(shot.goalSignal, "shot-regressed", "应标注 shot-regressed");
  assert.ok(shot.shotConversion && shot.shotConversion.sotRate > 0, "带自校准转化率");
  assert.equal(shot.shotApplied, 80, "全部场次应用去噪");
  assert.equal(shot.usable, true);
});
