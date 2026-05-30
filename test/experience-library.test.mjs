import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExperienceLibrary, queryExperience, frameOf } from "../src/experience-library.js";

function synthMatch(league, h, a, prob, opts = {}) {
  return {
    league,
    homeGoals: h,
    awayGoals: a,
    halfHome: opts.halfHome ?? null,
    halfAway: opts.halfAway ?? null,
    odds: prob,
    oddsClose: prob,
    asian: opts.asian ?? null,
  };
}

test("frameOf 取强侧为热门方,平局不当热门", () => {
  assert.equal(frameOf({ home: 0.6, draw: 0.25, away: 0.15 }).side, "home");
  assert.equal(frameOf({ home: 0.15, draw: 0.25, away: 0.6 }).side, "away");
  // 平局最大时退到较强的胜负侧
  assert.equal(frameOf({ home: 0.4, draw: 0.45, away: 0.15 }).side, "home");
});

test("buildExperienceLibrary 聚合 avgGoals/wld/drawRate/scoreDist", () => {
  const matches = [];
  // 高进球联赛:主队强(0.6),平均 3-1
  for (let i = 0; i < 50; i++) matches.push(synthMatch("高进球联赛", 3, 1, { home: 0.6, draw: 0.25, away: 0.15 }, { halfHome: 1, halfAway: 0 }));
  // 低进球联赛:主队强(0.6),平均 1-0
  for (let i = 0; i < 50; i++) matches.push(synthMatch("低进球联赛", 1, 0, { home: 0.6, draw: 0.25, away: 0.15 }, { halfHome: 0, halfAway: 0 }));
  const lib = buildExperienceLibrary(matches);
  assert.equal(lib.meta.leagues, 2);
  const hi = lib.leagues["高进球联赛"];
  const lo = lib.leagues["低进球联赛"];
  // 关键:同样 wld 概率,不同联赛 avgGoals 不同(修"比分跨联赛雷同"的根据)
  assert.ok(hi.avgGoals.home + hi.avgGoals.away > lo.avgGoals.home + lo.avgGoals.away);
  assert.equal(hi.avgGoals.home, 3);
  assert.equal(lo.avgGoals.home, 1);
  assert.equal(hi.wld.home, 1); // 全是主胜
  assert.ok(hi.halfFull.n > 0); // 有半场数据
});

test("queryExperience 命中联赛+热门档,返回该联赛真实进球水平", () => {
  const matches = [];
  for (let i = 0; i < 60; i++) matches.push(synthMatch("瑞典超级联赛", 2, 1, { home: 0.55, draw: 0.25, away: 0.2 }));
  const lib = buildExperienceLibrary(matches);
  const q = queryExperience(lib, { league: "瑞典超级联赛", opening: { home: 0.55, draw: 0.25, away: 0.2 } });
  assert.ok(q);
  assert.match(q.source, /热门档|联赛级/);
  assert.equal(q.avgGoals.home, 2);
  assert.equal(q.avgGoals.away, 1);
});

test("queryExperience 未知联赛退回全局经验", () => {
  const matches = [];
  for (let i = 0; i < 60; i++) matches.push(synthMatch("某联赛", 1, 1, { home: 0.4, draw: 0.3, away: 0.3 }));
  const lib = buildExperienceLibrary(matches);
  const q = queryExperience(lib, { league: "不存在的联赛", opening: { home: 0.4, draw: 0.3, away: 0.3 } });
  assert.ok(q);
  assert.equal(q.matchedKey, "global");
});

test("drawRate 正确反映高平局情境", () => {
  const matches = [];
  for (let i = 0; i < 100; i++) matches.push(synthMatch("闷平联赛", i % 3 === 0 ? 1 : 0, i % 3 === 0 ? 1 : (i % 2), { home: 0.38, draw: 0.34, away: 0.28 }));
  const lib = buildExperienceLibrary(matches);
  assert.ok(lib.leagues["闷平联赛"].drawRate > 0.2);
});

test("overUnder 经验:高进球联赛偏大球、低进球联赛偏小球", () => {
  const matches = [];
  // 高进球:3-2(总5,over1.5/2.5/3.5 全中)
  for (let i = 0; i < 50; i++) matches.push(synthMatch("大球联赛", 3, 2, { home: 0.5, draw: 0.27, away: 0.23 }));
  // 低进球:1-0(总1,三条全不中)
  for (let i = 0; i < 50; i++) matches.push(synthMatch("小球联赛", 1, 0, { home: 0.5, draw: 0.27, away: 0.23 }));
  const lib = buildExperienceLibrary(matches);
  const hi = lib.leagues["大球联赛"].overUnder;
  const lo = lib.leagues["小球联赛"].overUnder;
  assert.equal(hi.avgTotal, 5);
  assert.equal(hi.over25, 1); // 全大球
  assert.equal(hi.over35, 1);
  assert.equal(lo.avgTotal, 1);
  assert.equal(lo.over15, 0); // 全小球(总1<2)
  assert.equal(lo.over25, 0);
  assert.ok(hi.over25 > lo.over25);
});

test("overUnder 阈值与全局累积:over15>over25>over35 单调,global 正确汇总", () => {
  const matches = [];
  // 一组总进球递增的真实场:1-0,1-1,2-1,2-2,3-1(总1,2,3,4,4)
  const scores = [[1, 0], [1, 1], [2, 1], [2, 2], [3, 1]];
  for (let k = 0; k < 30; k++) for (const [h, a] of scores) matches.push(synthMatch("混合联赛", h, a, { home: 0.45, draw: 0.3, away: 0.25 }));
  const lib = buildExperienceLibrary(matches);
  const ou = lib.leagues["混合联赛"].overUnder;
  // 单调:over1.5 ≥ over2.5 ≥ over3.5(更高门槛命中率更低)
  assert.ok(ou.over15 >= ou.over25 && ou.over25 >= ou.over35);
  // global 汇总应等于唯一联赛的 overUnder(同一批数据)
  assert.ok(Math.abs(lib.global.overUnder.over25 - ou.over25) < 1e-9);
  assert.ok(Math.abs(lib.global.overUnder.avgTotal - ou.avgTotal) < 1e-9);
});

test("queryExperience 返回结果带 overUnder 字段", () => {
  const matches = [];
  for (let i = 0; i < 60; i++) matches.push(synthMatch("挪威超级联赛", 2, 2, { home: 0.5, draw: 0.27, away: 0.23 }));
  const lib = buildExperienceLibrary(matches);
  const q = queryExperience(lib, { league: "挪威超级联赛", opening: { home: 0.5, draw: 0.27, away: 0.23 } });
  assert.ok(q.overUnder);
  assert.equal(q.overUnder.avgTotal, 4);
  assert.equal(q.overUnder.over25, 1);
});
