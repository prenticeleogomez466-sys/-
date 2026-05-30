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
