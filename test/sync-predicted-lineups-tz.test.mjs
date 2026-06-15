// 守护:预测首发的 ESPN scoreboard 查询日必须按【美东 ET】日历,不能直接用北京时间日期。
// 复发根因(2026-06-14):kickoff 是北京时间,凌晨开赛的场(如 6/15 01:00=ET 6/14)被直接当 6/15 查 ESPN
//   → matchFixtureToEvent 全失败 → 今日场情报恒空("情报全是0")。此测试钉死时区换算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreboardYmd } from "../scripts/sync-predicted-lineups.mjs";

test("北京时间凌晨开赛场 → ESPN 查询日落到美东(前一天)", () => {
  // 北京 6/15 01:00 = UTC 6/14 17:00 = ET(EDT,UTC-4) 6/14 13:00 → 美东日期 20260614
  assert.equal(scoreboardYmd({ kickoff: "2026-06-15 01:00" }, "2026-06-14"), "20260614");
  // 北京 6/15 10:00 = UTC 6/15 02:00 = ET 6/14 22:00 → 仍 20260614
  assert.equal(scoreboardYmd({ kickoff: "2026-06-15 10:00" }, "2026-06-14"), "20260614");
});

test("北京时间午后开赛场 → ESPN 查询日同日(不偏移)", () => {
  // 北京 6/17 12:00 = UTC 6/17 04:00 = ET 6/17 00:00 → 20260617
  assert.equal(scoreboardYmd({ kickoff: "2026-06-17 12:00" }, "2026-06-17"), "20260617");
});

test("无时刻 kickoff → 回退取日期(兜底不抛)", () => {
  assert.equal(scoreboardYmd({ kickoff: "2026-06-15" }, "2026-06-14"), "20260615");
  assert.equal(scoreboardYmd({ date: "2026-06-20" }, "2026-06-14"), "20260620");
  assert.equal(scoreboardYmd({}, "2026-06-14"), "20260614");
});
