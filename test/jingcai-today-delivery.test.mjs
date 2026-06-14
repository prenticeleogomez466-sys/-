// 交付层"今日竞彩"判定守护(2026-06-14 用户揪出"漏土耳其"):跨日场——竞彩编号周缀属销售业务日,
// 但周末批次卖前一业务日票面、比赛次日白天开赛(6008 澳大利亚vs土耳其=周六批6开头/06-14 12:00 开赛),
// 只按周缀过滤会漏掉今天实际开赛且售到开赛的场。修=kickoff 日期==今日也并入。
import { test } from "node:test";
import assert from "node:assert";
import { isTodayDeliveryFixture } from "../src/jingcai-business-day.js";

const SUN = "2026-06-14"; // 周日

test("数字周缀==今日(7009/周日)→ 并入", () => {
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "7009", kickoff: "2026-06-15 01:00" }, SUN), true);
});

test("复发探针: 跨日场 6008(周六批·06-14 12:00 开赛)必须并入今日", () => {
  // 周缀=6(周六)≠周日,但 kickoff 在今日 → 旧逻辑漏掉,修后必须 true
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "6008", kickoff: "2026-06-14 12:00" }, SUN), true);
});

test("前一业务日编号且开赛在未来(1013/06-15)→ 不并入", () => {
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "1013", kickoff: "2026-06-15 22:00" }, SUN), false);
});

test("中文周缀==今日(周日001)→ 并入", () => {
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "周日001", kickoff: "2026-06-15 03:00" }, SUN), true);
});

test("中文周缀≠今日且开赛非今日(周六001/06-16)→ 不并入", () => {
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "周六001", kickoff: "2026-06-16 03:00" }, SUN), false);
});

test("无法判业务日(date 非法)→ 不擅自丢(交上游)", () => {
  assert.strictEqual(isTodayDeliveryFixture({ sequence: "6008", kickoff: "2026-06-14 12:00" }, "garbage"), true);
});
