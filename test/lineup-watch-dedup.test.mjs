import assert from "node:assert/strict";
import test from "node:test";
import { computeLineupWatch } from "../src/lineup-source.js";

// 用户硬规则 [[feedback_lineup_autoreport]]:出阵容自动推一份,同一场不重复发。
// 钉住 lineup-watch 去重决策,防改坏导致漏推(永不触发)或刷屏(重复触发)。
const D = "2026-06-01";

test("首次出现首发 → 触发,fresh=全部,状态记录", () => {
  const { fresh, nextState, shouldTrigger } = computeLineupWatch({}, D, ["a", "b"]);
  assert.equal(shouldTrigger, true);
  assert.deepEqual(fresh, ["a", "b"]);
  assert.deepEqual(nextState[D], ["a", "b"]);
});

test("已全部上报 → 不触发,fresh 空", () => {
  const prev = { [D]: ["a", "b"] };
  const { fresh, shouldTrigger } = computeLineupWatch(prev, D, ["a", "b"]);
  assert.equal(shouldTrigger, false);
  assert.equal(fresh.length, 0);
});

test("部分新增 → 只对新场触发,旧场不重复", () => {
  const prev = { [D]: ["a"] };
  const { fresh, nextState, shouldTrigger } = computeLineupWatch(prev, D, ["a", "b", "c"]);
  assert.equal(shouldTrigger, true);
  assert.deepEqual(fresh, ["b", "c"]);
  assert.deepEqual(nextState[D], ["a", "b", "c"]);
});

test("本轮内重复 id 去重,不双记", () => {
  const { fresh, nextState } = computeLineupWatch({}, D, ["a", "a", "b"]);
  assert.deepEqual(fresh, ["a", "b"]);
  assert.deepEqual(nextState[D], ["a", "b"]);
});

test("跨日期互不污染", () => {
  const prev = { "2026-05-31": ["x"] };
  const { fresh, nextState } = computeLineupWatch(prev, D, ["x"]);
  assert.deepEqual(fresh, ["x"], "同 id 不同日应视作新");
  assert.deepEqual(nextState["2026-05-31"], ["x"], "旧日期状态保留");
  assert.deepEqual(nextState[D], ["x"]);
});

test("空/异常输入安全降级,不崩不触发", () => {
  assert.equal(computeLineupWatch(null, D, null).shouldTrigger, false);
  assert.equal(computeLineupWatch(undefined, D, []).shouldTrigger, false);
  assert.deepEqual(computeLineupWatch({}, D, [null, undefined]).fresh, []);
});
