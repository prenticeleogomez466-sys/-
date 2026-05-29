import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFiveHundredRows, cleanTeamName } from "../src/jingcai-fivehundred-stage.js";

const ROWS = [
  ["周五001", "瑞超", "05-30 01:00", "[16]厄格里特 VS 埃夫斯堡[4]", "0 +1", "3.86 3.50 1.71 1.87 3.50 3.25"],
  ["周五009", "法甲", "05-30 02:45", "尼斯 VS 圣埃蒂安", "单关 0 -1", "1.85 3.10 3.75 3.92 3.30 1.75"],
];

test("cleanTeamName 去掉排名标记", () => {
  assert.equal(cleanTeamName("[16]厄格里特"), "厄格里特");
  assert.equal(cleanTeamName("埃夫斯堡[4]"), "埃夫斯堡");
  assert.equal(cleanTeamName("尼斯"), "尼斯");
});

test("parseFiveHundredRows 解析对阵、让0欧赔、让球赔率", () => {
  const { fixtures, snapshots } = parseFiveHundredRows(ROWS, "2026-05-29", "2026-05-29T00:00:00.000Z");
  assert.equal(fixtures.length, 2);
  assert.equal(snapshots.length, 2);

  const f0 = fixtures[0];
  assert.equal(f0.homeTeam, "厄格里特");
  assert.equal(f0.awayTeam, "埃夫斯堡");
  assert.equal(f0.marketType, "jingcai");
  assert.equal(f0.competition, "瑞超");
  assert.equal(f0.kickoff, "2026-05-30 01:00");
  assert.ok(f0.id.startsWith("jc-2026-05-29-"));

  // 让0档欧赔 = 前三个;让N档让球 = 后三个
  const s0 = snapshots[0];
  assert.deepEqual(s0.europeanOdds.current, { home: 3.86, draw: 3.5, away: 1.71 });
  assert.deepEqual(s0.handicapOdds.current, { home: 1.87, draw: 3.5, away: 3.25 });
  assert.equal(s0.europeanOdds.initial.home, s0.europeanOdds.current.home); // 单次抓取 initial=current
  assert.equal(s0.collectedAt, "2026-05-29T00:00:00.000Z");
});

test("缺主客队的行被跳过,不抛错", () => {
  const { fixtures } = parseFiveHundredRows([["X", "联赛", "05-30 01:00", "只有一个队", "0", "2.0 3.0 4.0"]], "2026-05-29");
  assert.equal(fixtures.length, 0);
});

test("赔率 ≤1 视为无效(过滤庄家占位)", () => {
  const { snapshots } = parseFiveHundredRows([["X", "联赛", "05-30 01:00", "甲 VS 乙", "0", "1.00 0 0 2.0 3.0 4.0"]], "2026-05-29");
  assert.equal(snapshots[0].europeanOdds, null); // 让0 无效
  assert.deepEqual(snapshots[0].handicapOdds.current, { home: 2.0, draw: 3.0, away: 4.0 });
});
