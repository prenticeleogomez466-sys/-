import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSofascoreMissing,
  injuryLayerFromLineups,
  matchEventToFixture,
  buildInjuriesFromSofascore
} from "../src/sofascore-injury-source.js";

// 真实形状取自 2026-05-30 会话实测(Arsenal missingPlayers)。
const ARSENAL_MISSING = [
  { player: { name: "Ben White", position: "D" }, type: "missing", reason: 1 },
  { player: { name: "Mikel Merino", position: "M" }, type: "missing", reason: 1 },
  { player: { name: "Christian Nørgaard", position: "M" }, type: "doubtful", reason: 1 }
];

describe("sofascore-injury-source(免授权多联赛伤停)", () => {
  it("normalizeSofascoreMissing:位置/状态归一,importance 标 estimated,doubtful 权重减半", () => {
    const out = normalizeSofascoreMissing(ARSENAL_MISSING);
    assert.equal(out.length, 3);
    const white = out.find((p) => p.name === "Ben White");
    assert.equal(white.position, "CB");          // D → CB
    assert.equal(white.status, "i");             // missing → i
    assert.equal(white.importanceEstimated, true);
    const norgaard = out.find((p) => p.name === "Christian Nørgaard");
    assert.equal(norgaard.status, "d");          // doubtful → d
    // doubtful 权重 0.5 < missing 权重 1 ⇒ 同位置存疑重要性更低。
    const merino = out.find((p) => p.name === "Mikel Merino");
    assert.ok(norgaard.importance < merino.importance);
  });

  it("normalizeSofascoreMissing:忽略非 missing/doubtful 与空输入", () => {
    assert.equal(normalizeSofascoreMissing([{ player: { name: "X", position: "F" }, type: "international" }]).length, 0);
    assert.equal(normalizeSofascoreMissing([]).length, 0);
    assert.equal(normalizeSofascoreMissing(null).length, 0);
  });

  it("injuryLayerFromLineups:两侧装配,全空返回 null", () => {
    const layer = injuryLayerFromLineups({ home: { missingPlayers: [] }, away: { missingPlayers: ARSENAL_MISSING } });
    assert.equal(layer.home.length, 0);
    assert.equal(layer.away.length, 3);
    assert.equal(layer.source, "sofascore-lineups");
    assert.equal(injuryLayerFromLineups({ home: { missingPlayers: [] }, away: { missingPlayers: [] } }), null);
    assert.equal(injuryLayerFromLineups(null), null);
  });

  it("matchEventToFixture:主客两队都对齐才匹配(canonical 队名)", () => {
    const events = [
      { id: 111, homeTeam: { name: "Paris Saint-Germain" }, awayTeam: { name: "Arsenal" } },
      { id: 222, homeTeam: { name: "Arsenal" }, awayTeam: { name: "Chelsea" } }
    ];
    assert.equal(matchEventToFixture(events, { homeTeam: "巴黎圣日耳曼", awayTeam: "阿森纳" }), 111);
    // 只对一队不算匹配(防误配)。
    assert.equal(matchEventToFixture(events, { homeTeam: "阿森纳", awayTeam: "热刺" }), null);
  });

  it("buildInjuriesFromSofascore:按 fixture.id 装出 injuries 层 + 计数", () => {
    const fixtures = [{ id: "fx1", homeTeam: "巴黎圣日耳曼", awayTeam: "阿森纳" }];
    const events = [{ id: 111, homeTeam: { name: "Paris Saint-Germain" }, awayTeam: { name: "Arsenal" } }];
    const lineupsByEventId = { 111: { home: { missingPlayers: [] }, away: { missingPlayers: ARSENAL_MISSING } } };
    const res = buildInjuriesFromSofascore(fixtures, events, lineupsByEventId);
    assert.equal(res.matched, 1);
    assert.equal(res.byFixtureId.fx1.away.length, 3);
    assert.equal(res.byFixtureId.fx1.source, "sofascore-lineups");
  });
});
