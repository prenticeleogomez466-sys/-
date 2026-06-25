// 空窗硬闸守护(2026-06-25):当日有比赛却 0 条推荐 → 上游"出表"漏跑,复盘必须亮红,
//   绝不静默放行 0/0/0。但真·空场日(无赛)不得误报。根因实证:FootballModel-DailyEvolution
//   计划任务 06-10 起被禁用 → 06-24 漏跑 → 复盘空窗无人察觉。
import { test } from "node:test";
import assert from "node:assert";
import { detectEmptyWindow } from "../src/daily-recap.js";

test("有比赛却 0 推荐 → 亮红空窗告警", () => {
  const res = detectEmptyWindow([], [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(res.isEmptyWindow, true);
  assert.equal(res.scheduledMatches, 3);
  assert.equal(res.recommended, 0);
  assert.match(res.message, /0 条推荐/);
});

test("有比赛且有推荐 → 不报警", () => {
  const res = detectEmptyWindow([{ match: "A 对 B" }], [{ id: 1 }, { id: 2 }]);
  assert.equal(res.isEmptyWindow, false);
  assert.equal(res.message, null);
});

test("真·空场日(无赛 + 0 推荐)→ 不误报", () => {
  const res = detectEmptyWindow([], []);
  assert.equal(res.isEmptyWindow, false);
  assert.equal(res.scheduledMatches, 0);
  assert.equal(res.message, null);
});

test("fixtures 缺失/非数组 → 退化为 0 场,不误报", () => {
  assert.equal(detectEmptyWindow([], undefined).isEmptyWindow, false);
  assert.equal(detectEmptyWindow([], null).isEmptyWindow, false);
});
