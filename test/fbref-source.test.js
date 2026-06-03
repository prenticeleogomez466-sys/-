import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenFbrefDump, normalizeTeamStat, buildFixtureFbref, buildFbrefForFixtures } from "../src/fbref-source.js";
import { synthesizeScenario } from "../src/scenario-synthesizer.js";

test("normalizeTeamStat 赛季总量 → per-match 化 + 终结效率", () => {
  const s = normalizeTeamStat({ mp: 10, poss: 55, gf: 18, ga: 8, xg: 15, xga: 9, npxg: 13, sh: 140, sot: 50 }, { team: "Norway", competition: "NL" });
  assert.equal(s.matches, 10);
  assert.equal(s.perMatch, true);
  assert.equal(s.xgFor, 1.5);     // 15/10
  assert.equal(s.xgAgainst, 0.9); // 9/10
  assert.equal(s.goalsFor, 1.8);  // 18/10
  assert.equal(s.possession, 55);
  assert.equal(s.finishing, round2(1.8 - 1.5)); // 进球 per-match − xG per-match = +0.3(超 xG)
});
function round2(v){ return Math.round(v*100)/100; }

test("缺 mp → 原样保留并标 perMatch=false", () => {
  const s = normalizeTeamStat({ xg: 1.4, xga: 1.1, gf: 1.6 });
  assert.equal(s.perMatch, false);
  assert.equal(s.xgFor, 1.4);
});

test("无实质数据 → null", () => {
  assert.equal(normalizeTeamStat({ poss: 50 }), null);
  assert.equal(normalizeTeamStat(null), null);
});

test("flattenFbrefDump 同队多赛事取场次最多的", () => {
  const dump = { competitions: [
    { name: "Friendly", teams: { Norway: { mp: 2, xg: 1.2, gf: 2 } } },
    { name: "Nations League", teams: { Norway: { mp: 8, xg: 1.6, gf: 14 } } },
  ] };
  const m = flattenFbrefDump(dump);
  assert.equal(m.get("norway").matches, 8);
  assert.equal(m.get("norway").competition, "Nations League");
});

test("buildFixtureFbref 给净 xG 优势 xgEdge", () => {
  const home = { xgFor: 1.6, xgAgainst: 0.9 };
  const away = { xgFor: 1.0, xgAgainst: 1.3 };
  const fb = buildFixtureFbref(home, away);
  // (1.6-1.3) - (1.0-0.9) = 0.3 - 0.1 = 0.2
  assert.equal(fb.xgEdge, 0.2);
  assert.equal(buildFixtureFbref(null, null), null);
});

test("buildFbrefForFixtures 匹配 fixtures + 报未匹配", () => {
  const m = new Map([["norway", { team: "Norway", xgFor: 1.6 }]]);
  const res = buildFbrefForFixtures([{ id: "f1", homeTeam: "Norway", awayTeam: "Sweden" }], m);
  assert.equal(res.matched, 1);
  assert.ok(res.byFixtureId.f1.home);
  assert.equal(res.byFixtureId.f1.away, null);
  assert.deepEqual(res.unmatched, ["Sweden"]);
});

test("情景层接入 xG 维度(fbref→xgQuality)", () => {
  const prediction = {
    fixture: { competition: "国际赛" },
    probabilities: { home: 0.45, draw: 0.27, away: 0.28 },
    fbref: { home: { team: "A", xgFor: 1.8, xgAgainst: 0.8, finishing: 0.4 }, away: { team: "B", xgFor: 0.9, xgAgainst: 1.5 }, xgEdge: 1.6 },
  };
  const sc = synthesizeScenario(prediction);
  assert.ok(sc.dims.xgQuality);
  assert.equal(sc.dims.xgQuality.lean, "主队 xG 占优");
  assert.match(sc.headline, /主队 xG 占优/);
  assert.ok(sc.marketGuidance.some((g) => /xG 支持/.test(g.lean)));
});

test("无 fbref → xgQuality 为 null 不报错", () => {
  const sc = synthesizeScenario({ fixture: { competition: "英超" }, probabilities: { home: 0.5, draw: 0.27, away: 0.23 } });
  assert.equal(sc.dims.xgQuality, null);
});
