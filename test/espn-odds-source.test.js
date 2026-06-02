import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchEspnEvents, moneyLineToDecimal, parseEspnCoreOdds } from "../src/espn-odds-source.js";

describe("espn odds source", () => {
  it("美式 moneyLine 正确转小数赔率", () => {
    assert.equal(Math.round(moneyLineToDecimal(165) * 100) / 100, 2.65);
    assert.equal(Math.round(moneyLineToDecimal(-175) * 1000) / 1000, 1.571);
    assert.ok(Number.isNaN(moneyLineToDecimal(0)));
    assert.ok(Number.isNaN(moneyLineToDecimal("x")));
  });

  it("parseEspnCoreOdds 用 current.decimal 取主/平/客", () => {
    const item = {
      provider: { name: "DraftKings" },
      homeTeamOdds: { moneyLine: 175, current: { decimal: 2.75 } },
      awayTeamOdds: { moneyLine: 165, current: { decimal: 2.65 } },
      drawOdds: { moneyLine: 220, current: { decimal: 3.2 } },
      overUnder: 2.5
    };
    const parsed = parseEspnCoreOdds(item, { swap: false });
    assert.deepEqual(parsed.european, { home: 2.75, draw: 3.2, away: 2.65 });
    assert.equal(parsed.overUnder, 2.5);
    assert.equal(parsed.provider, "DraftKings");
  });

  it("swap=true 时主客赔率翻转(ESPN 主客与我方相反)", () => {
    const item = {
      homeTeamOdds: { current: { decimal: 2.75 } },
      awayTeamOdds: { current: { decimal: 2.65 } },
      drawOdds: { current: { decimal: 3.2 } }
    };
    const parsed = parseEspnCoreOdds(item, { swap: true });
    assert.deepEqual(parsed.european, { home: 2.65, draw: 3.2, away: 2.75 });
  });

  it("缺任一向赔率返回 null", () => {
    assert.equal(parseEspnCoreOdds({ homeTeamOdds: { current: { decimal: 2.1 } }, awayTeamOdds: { current: { decimal: 3.0 } } }), null);
    assert.equal(parseEspnCoreOdds(null), null);
  });

  it("matchEspnEvents 按英↔中归一匹配,并标记主客是否相反", () => {
    const json = {
      events: [{
        id: "e1", date: "2026-06-02T16:00Z",
        competitions: [{ competitors: [
          { homeAway: "home", team: { displayName: "Croatia" } },
          { homeAway: "away", team: { displayName: "Belgium" } }
        ] }]
      }]
    };
    const fixtures = [{ id: "jc-1", homeTeam: "克罗地亚", awayTeam: "比利时" }];
    const matched = matchEspnEvents(json, fixtures, "fifa.friendly");
    assert.equal(matched.length, 1);
    assert.equal(matched[0].eventId, "e1");
    assert.equal(matched[0].swap, false);
    // 主客相反的 fixture 应标 swap=true
    const swapped = matchEspnEvents(json, [{ id: "jc-2", homeTeam: "比利时", awayTeam: "克罗地亚" }], "fifa.friendly");
    assert.equal(swapped[0].swap, true);
  });
});
