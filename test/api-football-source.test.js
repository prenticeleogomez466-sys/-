import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRecentForm, buildFixtureTeamTraits, apiFootballGet, apiFootballConfigured } from "../src/api-football-source.js";
import { synthesizeScenario } from "../src/scenario-synthesizer.js";

// 构造 /fixtures?team=&last= 的响应:目标队 id=100,近 5 场(最近在前用 date 控制)
function fx(homeId, awayId, hg, ag, date) {
  return { fixture: { date, status: { short: "FT" } }, teams: { home: { id: homeId }, away: { id: awayId } }, goals: { home: hg, away: ag } };
}

test("normalizeRecentForm 算状态/进失球/主客拆分", () => {
  const list = [
    fx(100, 9, 2, 0, "2026-05-30"), // 主胜 W
    fx(8, 100, 1, 1, "2026-05-25"), // 客平 D
    fx(100, 7, 0, 1, "2026-05-20"), // 主负 L
    fx(6, 100, 0, 3, "2026-05-15"), // 客胜 W
    fx(100, 5, 1, 1, "2026-05-10"), // 主平 D
  ];
  const t = normalizeRecentForm(100, list, { n: 10 });
  assert.equal(t.matches, 5);
  assert.equal(t.form, "WDLWD"); // 最近在前
  assert.deepEqual(t.record, { w: 2, d: 2, l: 1 });
  assert.equal(t.goalsForAvg, (2 + 1 + 0 + 3 + 1) / 5);
  assert.equal(t.goalsAgainstAvg, (0 + 1 + 1 + 0 + 1) / 5);
  // 主场 3 场(2-0,0-1,1-1):攻 1.0 失 0.67
  assert.equal(t.homeGoalsForAvg, Math.round((3 / 3) * 100) / 100);
  assert.ok(t.formScore > 0 && t.formScore < 1);
  assert.equal(t.cleanSheetRate, Math.round((2 / 5) * 100) / 100); // 失0: 2-0 与 0-3 两场
});

test("未完赛被过滤;全未完赛返回 null", () => {
  const list = [{ fixture: { status: { short: "NS" } }, teams: { home: { id: 100 }, away: { id: 1 } }, goals: { home: null, away: null } }];
  assert.equal(normalizeRecentForm(100, list), null);
  assert.equal(normalizeRecentForm(100, []), null);
});

test("buildFixtureTeamTraits 给状态差(+主队更好)", () => {
  const home = { teamId: 1, formScore: 0.8, form: "WWWWL", matches: 5 };
  const away = { teamId: 2, formScore: 0.3, form: "LLDWL", matches: 5 };
  const traits = buildFixtureTeamTraits(home, away);
  assert.equal(traits.formDiff, 0.5);
  assert.equal(traits.source, "api-football");
  assert.equal(buildFixtureTeamTraits(null, null), null);
});

test("无 key → apiFootballGet 返回 no-key,不抛错", async () => {
  const r = await apiFootballGet("/status", {}, { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-key");
  assert.equal(apiFootballConfigured({}), false);
});

test("apiFootballGet 用注入 fetch + key header", async () => {
  let seenUrl = null, seenKey = null;
  const fakeFetch = async (url, opts) => {
    seenUrl = url; seenKey = opts.headers["x-apisports-key"];
    return { ok: true, headers: { get: () => "75" }, json: async () => ({ response: [{ team: { id: 33, name: "Test" } }], results: 1 }) };
  };
  const r = await apiFootballGet("/teams", { search: "Test" }, { env: { API_FOOTBALL_KEY: "abc" }, fetch: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(seenKey, "abc");
  assert.match(seenUrl, /\/teams\?search=Test/);
  assert.equal(r.remaining, 75);
  assert.equal(r.response[0].team.id, 33);
});

test("配额/参数错(200 带 errors)判失败", async () => {
  const fakeFetch = async () => ({ ok: true, headers: { get: () => "0" }, json: async () => ({ errors: { requests: "limit reached" }, response: [] }) });
  const r = await apiFootballGet("/teams", {}, { env: { API_FOOTBALL_KEY: "x" }, fetch: fakeFetch });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "api-errors");
});

test("情景层接入近期状态维度(teamTraits→teamForm)", () => {
  const prediction = {
    fixture: { competition: "国际赛" },
    probabilities: { home: 0.45, draw: 0.27, away: 0.28 },
    differentialAnalysis: { archetype: { strength: { label: "小幅占优", key: "slight-edge" } } },
    teamTraits: {
      home: { form: "WWWDW", matches: 5, formScore: 0.9, goalsForAvg: 2.2, goalsAgainstAvg: 0.6 },
      away: { form: "LLDLL", matches: 5, formScore: 0.2, goalsForAvg: 0.6, goalsAgainstAvg: 1.8 },
      formDiff: 0.7,
    },
  };
  const sc = synthesizeScenario(prediction);
  assert.ok(sc.dims.teamForm);
  assert.equal(sc.dims.teamForm.lean, "主队状态明显更好");
  assert.match(sc.headline, /主队状态明显更好/);
  assert.ok(sc.marketGuidance.some((g) => /近况/.test(g.lean)));
});

test("无 teamTraits → teamForm 维度为 null,不报错", () => {
  const sc = synthesizeScenario({
    fixture: { competition: "英超" },
    probabilities: { home: 0.5, draw: 0.27, away: 0.23 },
  });
  assert.equal(sc.dims.teamForm, null);
});
