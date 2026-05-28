import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractFotmobInjuries,
  extractFotmobLineups,
  extractFotmobXg,
  matchFixturesToFotmob,
  syncFotmobAllLayers,
  __resetFotmobCacheForTests
} from "../src/public-football-data.js";

describe("public-football-data fotmob extractors", () => {
  it("extracts injuries from content.injuries.injuries", () => {
    const detail = {
      content: {
        injuries: {
          injuries: [
            { player: "M. Salah", team: "Liverpool", reason: "Hamstring", expectedReturn: "2 weeks" },
            { player: "K. Mbappe", team: "Real Madrid" }
          ]
        }
      }
    };
    const rows = extractFotmobInjuries(detail);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].player, "M. Salah");
    assert.equal(rows[0].reason, "Hamstring");
    assert.equal(rows[1].team, "Real Madrid");
  });

  it("extracts injuries from alternative path content.lineup2.injuries", () => {
    const detail = {
      content: {
        lineup2: {
          injuries: [{ name: "N. Williams", team: "Athletic Bilbao", injuryReason: "Knee" }]
        }
      }
    };
    const rows = extractFotmobInjuries(detail);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].player, "N. Williams");
    assert.equal(rows[0].reason, "Knee");
  });

  it("returns empty array when no injury path matches", () => {
    assert.deepEqual(extractFotmobInjuries({ content: {} }), []);
    assert.deepEqual(extractFotmobInjuries(null), []);
  });

  it("extracts lineups with formation and startXI", () => {
    const detail = {
      content: {
        lineup2: {
          confirmed: true,
          lineup: [
            {
              teamName: "PSG",
              formation: "4-3-3",
              startXI: [{ name: "Donnarumma", shirtNumber: 1, role: "GK" }, { name: "Mbappe", shirtNumber: 7, role: "FW" }],
              bench: [{ name: "Ramos", shirt: 4 }]
            },
            {
              teamName: "Arsenal",
              formation: "4-2-3-1",
              players: [[{ name: "Raya" }], [{ name: "Saka" }]],
              substitutes: []
            }
          ]
        }
      }
    };
    const lineups = extractFotmobLineups(detail);
    assert.ok(lineups);
    assert.equal(lineups.confirmed, true);
    assert.equal(lineups.home.team, "PSG");
    assert.equal(lineups.home.formation, "4-3-3");
    assert.equal(lineups.home.startXI.length, 2);
    assert.equal(lineups.home.startXI[0].name, "Donnarumma");
    assert.equal(lineups.home.bench.length, 1);
    assert.equal(lineups.away.team, "Arsenal");
    assert.equal(lineups.away.startXI.length, 2);
  });

  it("returns null when lineup is missing", () => {
    assert.equal(extractFotmobLineups({ content: {} }), null);
    assert.equal(extractFotmobLineups(null), null);
  });

  it("extracts xG from Periods.All.stats Expected goals row", () => {
    const fixture = { homeTeam: "PSG", awayTeam: "Arsenal" };
    const detail = {
      content: {
        stats: {
          Periods: {
            All: {
              stats: [
                { key: "Ball possession", stats: ["60", "40"] },
                { key: "Expected goals (xG)", stats: ["1.85", "0.92"] }
              ]
            }
          }
        }
      }
    };
    const xg = extractFotmobXg(detail, fixture);
    assert.ok(xg);
    assert.equal(xg.home.team, "PSG");
    assert.equal(xg.home.xg, 1.85);
    assert.equal(xg.away.xg, 0.92);
    assert.equal(xg.preMatch, undefined);
  });

  it("falls back to preMatchData averageXg when stats absent", () => {
    const fixture = { homeTeam: "PSG", awayTeam: "Arsenal" };
    const detail = {
      content: {
        preMatchData: {
          home: { averageXg: 2.4 },
          away: { averageXg: 1.1 }
        }
      }
    };
    const xg = extractFotmobXg(detail, fixture);
    assert.ok(xg);
    assert.equal(xg.preMatch, true);
    assert.equal(xg.home.xg, 2.4);
    assert.equal(xg.away.xg, 1.1);
  });

  it("returns null when no xG path matches", () => {
    assert.equal(extractFotmobXg({ content: {} }, { homeTeam: "x", awayTeam: "y" }), null);
  });
});

describe("public-football-data fotmob fixture matching", () => {
  it("matches fixtures via canonical team alias", () => {
    const dayIndex = {
      leagues: [
        {
          matches: [
            { id: 4111111, home: { name: "Paris Saint-Germain" }, away: { name: "Arsenal FC" } },
            { id: 4222222, home: { name: "Nice" }, away: { name: "Saint-Étienne" } }
          ]
        }
      ]
    };
    const fixtures = [
      { id: "sf-26082-01-巴黎圣日尔曼-阿森纳", homeTeam: "巴黎圣日尔曼", awayTeam: "阿森纳" },
      { id: "sf-26082-02-尼斯-圣埃蒂安", homeTeam: "尼斯", awayTeam: "圣埃蒂安" },
      { id: "sf-99999-99-未知队-未知队", homeTeam: "未知主队", awayTeam: "未知客队" }
    ];
    const matched = matchFixturesToFotmob(fixtures, dayIndex);
    assert.equal(matched.length, 2);
    assert.equal(matched[0].matchId, 4111111);
    assert.equal(matched[1].matchId, 4222222);
  });

  it("ignores leagues with no matches and returns empty when no match", () => {
    const matched = matchFixturesToFotmob(
      [{ id: "x", homeTeam: "a", awayTeam: "b" }],
      { leagues: [{ matches: [] }, {}] }
    );
    assert.equal(matched.length, 0);
  });
});

describe("public-football-data fotmob top-level", () => {
  it("returns all-empty layers when FOTMOB_PUBLIC_ENABLED=0", async () => {
    __resetFotmobCacheForTests();
    const result = await syncFotmobAllLayers(
      "2026-05-28",
      [{ id: "x", homeTeam: "a", awayTeam: "b" }],
      () => { throw new Error("must not be called"); },
      { FOTMOB_PUBLIC_ENABLED: "0" }
    );
    assert.equal(result.injuries.ok, false);
    assert.equal(result.lineups.ok, false);
    assert.equal(result.xg.ok, false);
    assert.equal(result.injuries.warning, "FOTMOB_PUBLIC_ENABLED=0");
  });

  it("returns empty layers when fetch is not a function", async () => {
    __resetFotmobCacheForTests();
    const result = await syncFotmobAllLayers(
      "2026-05-28",
      [{ id: "x", homeTeam: "a", awayTeam: "b" }],
      null,
      {}
    );
    assert.equal(result.injuries.ok, false);
    assert.equal(result.injuries.warning, "fetch 不可用");
  });

  it("degrades gracefully when day-index fetch throws", async () => {
    __resetFotmobCacheForTests();
    const failingFetch = async () => { throw new Error("ENETUNREACH"); };
    // TTL=0 强制跳过文件缓存(避免上一次 produces 测试或线上 cron 留下的真实缓存干扰)
    const result = await syncFotmobAllLayers(
      "2026-05-28",
      [{ id: "x", homeTeam: "a", awayTeam: "b" }],
      failingFetch,
      { PUBLIC_SOURCE_TTL_MINUTES: "0" }
    );
    assert.equal(result.injuries.ok, false);
    assert.ok(result.injuries.warning.includes("ENETUNREACH"));
  });

  it("produces ok=true layers when fetched JSON has all three", async () => {
    __resetFotmobCacheForTests();
    let calls = 0;
    const fakeFetch = async (url) => {
      calls += 1;
      if (url.includes("/matches?date=")) {
        return jsonResponse({
          leagues: [{
            matches: [{ id: 9001, home: { name: "Paris Saint-Germain" }, away: { name: "Arsenal" } }]
          }]
        });
      }
      if (url.includes("/matchDetails?matchId=9001")) {
        return jsonResponse({
          content: {
            injuries: { injuries: [{ player: "Mbappe", team: "PSG", reason: "Calf" }] },
            lineup2: {
              confirmed: false,
              lineup: [
                { teamName: "PSG", formation: "4-3-3", startXI: [{ name: "Donnarumma" }] },
                { teamName: "Arsenal", formation: "4-2-3-1", startXI: [{ name: "Raya" }] }
              ]
            },
            stats: { Periods: { All: { stats: [{ key: "Expected goals (xG)", stats: ["1.5", "0.9"] }] } } }
          }
        });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const result = await syncFotmobAllLayers(
      "2026-05-28",
      [{ id: "sf-26082-01-巴黎圣日尔曼-阿森纳", homeTeam: "巴黎圣日尔曼", awayTeam: "阿森纳" }],
      fakeFetch,
      // 给一个临时 TTL=0,防止文件缓存读到旧数据
      { PUBLIC_SOURCE_TTL_MINUTES: "0" }
    );
    assert.equal(result.injuries.ok, true);
    assert.equal(result.injuries.count, 1);
    assert.equal(result.lineups.ok, true);
    assert.equal(result.lineups.count, 1);
    assert.equal(result.xg.ok, true);
    assert.equal(result.xg.count, 1);
    assert.equal(result.xg.fixtureData["sf-26082-01-巴黎圣日尔曼-阿森纳"].home.xg, 1.5);
    // day-index + matchDetails = 2 个真实 HTTP 调用
    assert.equal(calls, 2);
  });
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload)
  };
}
