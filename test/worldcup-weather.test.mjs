import { test } from "node:test";
import assert from "node:assert/strict";
import { venueLambdaMultiplier } from "../src/world-cup-priors.js";

// 露天偏热场(静态气候均温 31℃)
const openHot = { city: "Test", altitude_m: 100, june_july_avg_high_c: 31, indoor_climate_controlled: false };
// 恒温顶棚场
const indoor = { city: "Dome", altitude_m: 100, june_july_avg_high_c: 36, indoor_climate_controlled: true };
// 高原场
const altitude = { city: "Alt", altitude_m: 2240, june_july_avg_high_c: 24, indoor_climate_controlled: false };

test("无 opts:回退静态气候均温施加高温折损(锁 null→0 回归)", () => {
  // 31℃ ≥30 → ×0.97;若 Number(null)===0 的 bug 复活会错误返回 1
  assert.equal(venueLambdaMultiplier(openHot).mult, 0.97);
});

test("realHighTempC=null:回退静态均温,不被当成 0℃", () => {
  assert.equal(venueLambdaMultiplier(openHot, { realHighTempC: null }).mult, 0.97);
});

test("真实预报最高温覆盖静态均温:35℃→×0.95", () => {
  const r = venueLambdaMultiplier(openHot, { realHighTempC: 35 });
  assert.equal(r.mult, 0.95);
  assert.ok(r.factors.some((f) => f.includes("真实预报")));
});

test("真实预报凉爽(25℃)抵消静态偏热假设→中性", () => {
  // 静态 31℃ 会判 ×0.97,但真实只有 25℃ → 无折损,mult=1
  assert.equal(venueLambdaMultiplier(openHot, { realHighTempC: 25 }).mult, 1);
});

test("恒温顶棚:气温中性,真实高温也不折损", () => {
  assert.equal(venueLambdaMultiplier(indoor, { realHighTempC: 38 }).mult, 1);
});

test("高原 >2000m:×1.06(与气温独立)", () => {
  assert.equal(venueLambdaMultiplier(altitude).mult, 1.06);
});

test("无 venue → 中性 1", () => {
  assert.equal(venueLambdaMultiplier(null).mult, 1);
});
