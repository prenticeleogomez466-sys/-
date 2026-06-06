import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { espnCodeFor, kickoffBeijing, parseEspnForm, parseEspnH2h, matchFixtureToEvent } from "../src/deep-context.js";

describe("deep-context 联赛码映射(espnCodeFor)", () => {
  it("精确+模糊匹配", () => {
    assert.equal(espnCodeFor("日本职业联赛"), "jpn.1");
    assert.equal(espnCodeFor("日职"), "jpn.1");
    assert.equal(espnCodeFor("英超"), "eng.1");
    assert.equal(espnCodeFor("国际赛"), "fifa.friendly");
  });
  it("未覆盖联赛→null(标缺不兜底)", () => {
    assert.equal(espnCodeFor("某不存在联赛"), null);
    assert.equal(espnCodeFor(""), null);
    assert.equal(espnCodeFor(null), null);
  });
});

describe("开赛时间(kickoffBeijing)—— ISO UTC→北京", () => {
  it("13:00 北京 = 05:00 UTC", () => {
    assert.equal(kickoffBeijing("2026-06-06T05:00Z"), "06-06 13:00");
  });
  it("缺/非法→null", () => {
    assert.equal(kickoffBeijing(null), null);
    assert.equal(kickoffBeijing("garbage"), null);
  });
});

describe("近5场状态(parseEspnForm)", () => {
  const sched = (results, teamId) => ({
    events: results.map(([ms, os]) => ({
      competitions: [{ status: { type: { completed: true } }, competitors: [
        { team: { id: teamId }, score: { value: ms } },
        { team: { id: "OPP" }, score: { value: os } },
      ] }]
    }))
  });
  it("胜平负正确(最近在右)", () => {
    assert.equal(parseEspnForm(sched([[2,0],[1,1],[0,2],[3,1],[1,1]], "T"), "T"), "胜平负胜平");
  });
  it("无完赛→null(不臆造)", () => {
    assert.equal(parseEspnForm({ events: [] }, "T"), null);
    assert.equal(parseEspnForm(null, "T"), null);
  });
  it("未完赛的场被跳过", () => {
    const j = { events: [{ competitions: [{ status: { type: { completed: false } }, competitors: [] }] }] };
    assert.equal(parseEspnForm(j, "T"), null);
  });
});

describe("H2H(parseEspnH2h)", () => {
  it("取最近3次比分", () => {
    const j = { headToHeadGames: [{ events: [
      { gameDate: "2026-05-30", homeTeamScore: 5, awayTeamScore: 0 },
      { gameDate: "2025-10-01", homeTeamScore: 0, awayTeamScore: 0 },
      { gameDate: "2025-03-01", homeTeamScore: 1, awayTeamScore: 0 },
    ] }] };
    assert.equal(parseEspnH2h(j), "2026-05 5-0 / 2025-10 0-0 / 2025-03 1-0");
  });
  it("无H2H→null", () => {
    assert.equal(parseEspnH2h({}), null);
    assert.equal(parseEspnH2h({ headToHeadGames: [] }), null);
  });
});

describe("fixture↔ESPN事件匹配(matchFixtureToEvent)—— 中英canonical双边", () => {
  const events = [{ id: "1", competitions: [{ competitors: [
    { homeAway: "home", team: { id: "7115", displayName: "Kashima Antlers" } },
    { homeAway: "away", team: { id: "3737", displayName: "Vissel Kobe" } },
  ] }] }];
  it("中文fixture匹配到英文ESPN事件", () => {
    const m = matchFixtureToEvent({ homeTeam: "鹿岛鹿角", awayTeam: "神户胜利船" }, events);
    assert.ok(m); assert.equal(m.homeId, "7115"); assert.equal(m.awayId, "3737");
  });
  it("无匹配→null(标缺)", () => {
    assert.equal(matchFixtureToEvent({ homeTeam: "巴塞罗那", awayTeam: "皇马" }, events), null);
  });
});
