import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { espnDateStamps, matchEspnEvents, moneyLineToDecimal, parseEspnCoreOdds, parseEspnScoreboardTotals } from "../src/espn-odds-source.js";

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

  it("parseEspnScoreboardTotals 解析大小球 line + 大/小水位(美式→小数,open/close)", () => {
    const competition = { odds: [{
      overUnder: 2.5,
      total: {
        over: { open: { odds: "-130" }, close: { odds: "-115" } },
        under: { open: { odds: "-105" }, close: { odds: "-115" } }
      }
    }] };
    const totals = parseEspnScoreboardTotals(competition);
    assert.equal(totals.current.line, 2.5);
    assert.equal(totals.initial.over, 1.769); // -130 → 1.769
    assert.equal(totals.current.over, 1.87);  // -115 → 1.870
    assert.equal(totals.initial.under, 1.952); // -105 → 1.952
  });

  it("无 overUnder 时 totals 返回 null", () => {
    assert.equal(parseEspnScoreboardTotals({ odds: [{}] }), null);
    assert.equal(parseEspnScoreboardTotals({}), null);
  });

  it("espnDateStamps 含 crawl 当天±1 + 每场自己开赛日(覆盖未来场次)", () => {
    const stamps = espnDateStamps("2026-06-02", [
      { kickoff: "2026-06-06" },
      { kickoff: "2026-06-07" },
      { kickoff: "2026-06-02" }
    ]);
    // crawl 当天±1
    assert.ok(stamps.includes("20260601") && stamps.includes("20260602") && stamps.includes("20260603"));
    // 未来开赛日(及前一天兜时区)
    assert.ok(stamps.includes("20260606") && stamps.includes("20260605"));
    assert.ok(stamps.includes("20260607") && stamps.includes("20260606"));
    // 去重
    assert.equal(stamps.length, new Set(stamps).size);
  });
});
