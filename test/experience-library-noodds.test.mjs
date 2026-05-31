import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExperienceLibrary, queryExperience } from "../src/experience-library.js";

// 无赔率联赛(ESPN 日韩/澳超/中超等)应进库的联赛级经验:wld/平局率/场均进球/比分/大小球。
test("无赔率比赛也进联赛级经验(赔率档优雅缺省)", () => {
  const mk = (lg, hg, ag, withOdds) => ({
    league: lg, homeGoals: hg, awayGoals: ag, halfHome: null, halfAway: null,
    odds: withOdds ? { home: 2.0, draw: 3.3, away: 3.6 } : null, oddsClose: null, asian: null
  });
  const matches = [];
  // 澳超 60 场纯赛果(无赔率):主胜 30 / 平 15 / 客 15
  for (let i = 0; i < 30; i++) matches.push(mk("澳超", 2, 0, false));
  for (let i = 0; i < 15; i++) matches.push(mk("澳超", 1, 1, false));
  for (let i = 0; i < 15; i++) matches.push(mk("澳超", 0, 1, false));

  const lib = buildExperienceLibrary(matches);
  assert.ok(lib.leagues["澳超"], "澳超应进库");
  const L = lib.leagues["澳超"];
  assert.equal(L.n, 60);
  assert.equal(L.hasOdds, false, "无赔率联赛 hasOdds=false");
  assert.ok(Math.abs(L.drawRate - 0.25) < 1e-9, "平局率 15/60=0.25");
  assert.ok(Math.abs(L.wld.home - 0.5) < 1e-9, "主胜 30/60");
  assert.ok(L.avgGoals.home > 0, "有场均进球");
  assert.ok(L.overUnder.avgTotal > 0, "有大小球均值");
  assert.ok(L.scoreDist.length > 0, "有比分分布");
  assert.equal(L.halfFull.n, 0, "无半场数据 halfFull.n=0");
});

test("queryExperience 对无赔率联赛退到联赛级(用模型概率定档但无 tier→联赛级)", () => {
  const matches = [];
  for (let i = 0; i < 50; i++) matches.push({ league: "中超", homeGoals: 1, awayGoals: 1, halfHome: null, halfAway: null, odds: null, oddsClose: null, asian: null });
  const lib = buildExperienceLibrary(matches);
  const r = queryExperience(lib, { league: "中超", opening: { home: 0.45, draw: 0.3, away: 0.25 } });
  assert.ok(r, "应有结果");
  assert.equal(r.matchedKey, "league", "无赔率档 → 退联赛级");
  assert.ok(r.drawRate > 0);
});

test("有赔率联赛仍建热门档(向后兼容)", () => {
  const matches = [];
  for (let i = 0; i < 60; i++) matches.push({ league: "英超", homeGoals: 2, awayGoals: 0, halfHome: 1, halfAway: 0, odds: { home: 1.5, draw: 4.0, away: 6.0 }, oddsClose: { home: 1.5, draw: 4.0, away: 6.0 }, asian: null });
  const lib = buildExperienceLibrary(matches);
  assert.equal(lib.leagues["英超"].hasOdds, true);
  assert.ok(lib.meta.usedWithOdds >= 60);
});
