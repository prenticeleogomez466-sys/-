import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNowscoreOddsHtml, parseSinaShengfucaiMacauHtml, parseSinaShengfucaiOddsHtml } from "../src/odds-crawler.js";

describe("sina shengfucai odds parser", () => {
  it("maps 14-match odds by sequence and rolls forward latest bookmaker updates", () => {
    const html = `
      <table>
        <tr><td>1</td><td>切尔西 vs 曼城</td><td>4.00</td><td>3.60</td><td>1.80</td><td>4.60</td><td>3.70</td><td>1.75</td></tr>
        <tr><td></td><td>15日17:00</td><td>4.50</td><td>3.90</td><td>1.70</td><td></td><td></td><td></td></tr>
      </table>`;
    const rows = parseSinaShengfucaiOddsHtml(html, [{
      id: "sf-26076-01-切尔西-曼彻斯特城",
      sequence: "1",
      date: "2026-05-15",
      competition: "英足总杯",
      homeTeam: "切尔西",
      awayTeam: "曼彻斯特城",
      marketType: "shengfucai"
    }], "2026-05-15", "https://example.test/sfc.shtml");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].fixtureId, "sf-26076-01-切尔西-曼彻斯特城");
    assert.deepEqual(rows[0].europeanOdds.initial, { home: 4.3, draw: 3.65, away: 1.775 });
    assert.deepEqual(rows[0].europeanOdds.current, { home: 4.55, draw: 3.8, away: 1.725 });
    assert.equal(rows[0].collectedAt, "2026-05-15T09:00:00.000Z");
  });

  it("parses sina macau asian handicap rows by sequence", () => {
    const html = `
      <meta property="article:published_time" content="2026-05-15 17:00:05" />
      <table>
        <tr><td>16日22:00(周六)</td><td>01 切尔西 vs 曼城</td><td>1.80</td><td>受半球/一球</td><td>1.98</td><td>4.00</td><td>3.36</td><td>1.73</td></tr>
        <tr><td></td><td>周五17:00</td><td>1.88</td><td>受半球/一球</td><td>1.90</td><td>4.17</td><td>3.36</td><td>1.70</td></tr>
      </table>`;
    const rows = parseSinaShengfucaiMacauHtml(html, [{
      id: "sf-26076-01-切尔西-曼彻斯特城",
      sequence: "1",
      competition: "英足总杯",
      homeTeam: "切尔西",
      awayTeam: "曼彻斯特城",
      marketType: "shengfucai"
    }], "2026-05-15", "https://example.test/macau.shtml");

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].asianHandicap.initial, { line: 0.75, homeWater: 1.8, awayWater: 1.98 });
    assert.deepEqual(rows[0].asianHandicap.current, { line: 0.75, homeWater: 1.88, awayWater: 1.9 });
  });

  it("parses nowscore asian handicap hidden payload", () => {
    const html = "<input type='hidden' value='1;澳*;1.76,3.43,3.75,0.775,半球,1.075,1.85,0.76,半球,1.02,1.78,0.74,2.5,0.98,;1.50,4.10,4.60,1.00,一球,0.85,1.85,0.96,一球,0.82,1.78,0.60,2.5/3,1.12,' />";
    const row = parseNowscoreOddsHtml(html, {
      id: "jc-1",
      sequence: "周五001",
      competition: "测试",
      homeTeam: "主队",
      awayTeam: "客队",
      marketType: "jingcai"
    }, "2026-05-15", "https://example.test/nowscore.htm");

    assert.deepEqual(row.asianHandicap.current, { line: -0.5, homeWater: 0.775, awayWater: 1.075 });
    assert.deepEqual(row.asianHandicap.initial, { line: -1, homeWater: 1, awayWater: 0.85 });
  });

  it("treats nowscore starred handicap as away giving the line", () => {
    const html = "<input type='hidden' value='1;澳*;3.11,3.73,1.91,0.925,*半球,0.925,1.85,0.93,*半球,0.91,1.84,0.79,3,1.01,;2.70,3.40,2.24,0.90,*平/半,0.95,1.85,0.80,*平/半,1.04,1.84,0.94,2.5/3,0.86,' />";
    const row = parseNowscoreOddsHtml(html, {
      id: "jc-2",
      sequence: "周五002",
      competition: "测试",
      homeTeam: "主队",
      awayTeam: "客队",
      marketType: "jingcai"
    }, "2026-05-15", "https://example.test/nowscore-star.htm");

    assert.deepEqual(row.asianHandicap.current, { line: 0.5, homeWater: 0.925, awayWater: 0.925 });
    assert.deepEqual(row.asianHandicap.initial, { line: 0.25, homeWater: 0.9, awayWater: 0.95 });
  });
});
