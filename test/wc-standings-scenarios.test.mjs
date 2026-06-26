import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWcScenarios, buildWcQualByMatch } from "../src/wc-standings-scenarios.js";

// 用注入的最小真实形态数据(不读磁盘),验证:积分计算、末轮穷举出线、per-match映射。
const G = {
  groups: { A: ["Alpha", "Beta", "Gamma", "Delta"] },
  team_name_zh: { Alpha: "甲", Beta: "乙", Gamma: "丙", Delta: "丁" }
};
// 第1-2轮:甲全胜(6分),乙1胜1负(3),丙1平1负(1),丁1平1负(1)。末轮:甲vs丙、乙vs丁。
const R = [
  { date: "2026-06-11", home: "Alpha", away: "Delta", homeGoals: 2, awayGoals: 0, completed: true },
  { date: "2026-06-11", home: "Beta", away: "Gamma", homeGoals: 1, awayGoals: 0, completed: true },
  { date: "2026-06-18", home: "Alpha", away: "Beta", homeGoals: 1, awayGoals: 0, completed: true },
  { date: "2026-06-18", home: "Gamma", away: "Delta", homeGoals: 1, awayGoals: 1, completed: true },
  { date: "2026-06-24", home: "Gamma", away: "Alpha", homeGoals: 0, awayGoals: 0, completed: false },
  { date: "2026-06-24", home: "Delta", away: "Beta", homeGoals: 0, awayGoals: 0, completed: false }
];

test("computeWcScenarios 真实赛果积分榜正确(no-fallback,不算未踢场)", () => {
  const s = computeWcScenarios({ raw: { G, R } });
  const g = s.groups[0];
  assert.equal(s.completedCount, 4);
  const byName = Object.fromEntries(g.rows.map((r) => [r.name, r]));
  assert.equal(byName["甲"].Pts, 6); assert.equal(byName["甲"].rank, 1);
  assert.equal(byName["乙"].Pts, 3);
  assert.equal(byName["丙"].Pts, 1); assert.equal(byName["丁"].Pts, 1);
  assert.equal(g.results.length, 4);     // 4场已踢=对战数据
  assert.equal(g.upcoming.length, 2);    // 末轮2场
});

test("末轮穷举:甲已6分,任何结果都锁定出线(✅锁定)", () => {
  const s = computeWcScenarios({ raw: { G, R } });
  const sc = s.groups[0].scenarios.find((x) => x.team === "甲");
  assert.ok(sc, "甲应有末轮情景");
  assert.match(sc.win, /锁定/); assert.match(sc.draw, /锁定/); assert.match(sc.lose, /锁定/);
});

test("buildWcQualByMatch 主客两序都建键且含出线句", () => {
  const s = computeWcScenarios({ raw: { G, R } });
  const map = buildWcQualByMatch(s);
  assert.ok(map["丙 vs 甲"]); assert.ok(map["甲 vs 丙"]);
  assert.match(map["甲 vs 丙"], /末轮出线/);
});
