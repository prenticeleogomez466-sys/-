import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchPublicJingcaiFixtures, parseFiveHundredJingcaiHtml, parseNeteaseJingcaiHtml } from "../src/public-jingcai-fixtures.js";

describe("500.com jingcai parser", () => {
  it("parses a single bet_item row with all three SPs", () => {
    const html = `
      <table>
        <tr class="bet_item">
          <td class="event">欧协联</td>
          <td class="time">2026-05-28 22:00</td>
          <td class="team">拉齐奥 VS 比尔森胜利</td>
          <td class="odds_3">2.10</td>
          <td class="odds_1">3.40</td>
          <td class="odds_0">3.20</td>
        </tr>
      </table>`;
    const out = parseFiveHundredJingcaiHtml(html, "2026-05-28");
    assert.equal(out.length, 1);
    assert.equal(out[0].competition, "欧协联");
    assert.equal(out[0].homeTeam, "拉齐奥");
    assert.equal(out[0].awayTeam, "比尔森胜利");
    assert.equal(out[0].odds.home, 2.1);
    assert.equal(out[0].odds.draw, 3.4);
    assert.equal(out[0].odds.away, 3.2);
    assert.equal(out[0].marketType, "jingcai");
    assert.equal(out[0].source, "500.com /jczq/");
  });

  it("filters out fixtures from other dates", () => {
    const html = `
      <table>
        <tr class="bet_item">
          <td class="event">欧协联</td><td class="time">2026-05-28 22:00</td>
          <td class="team">A VS B</td><td class="odds_3">2.1</td><td class="odds_1">3.4</td><td class="odds_0">3.2</td>
        </tr>
        <tr class="bet_item">
          <td class="event">欧冠</td><td class="time">2026-05-29 03:00</td>
          <td class="team">C VS D</td><td class="odds_3">1.8</td><td class="odds_1">3.6</td><td class="odds_0">4.5</td>
        </tr>
      </table>`;
    const out = parseFiveHundredJingcaiHtml(html, "2026-05-28");
    assert.equal(out.length, 1);
    assert.equal(out[0].homeTeam, "A");
  });

  it("skips rows without team cell or odds cell", () => {
    const html = `
      <table>
        <tr class="bet_item">
          <td class="time">2026-05-28 22:00</td>
          <td class="odds_3">2.1</td>
        </tr>
      </table>`;
    const out = parseFiveHundredJingcaiHtml(html, "2026-05-28");
    assert.equal(out.length, 0);
  });

  it("supports alternate row class name like 'match_row' and 'data'", () => {
    const html = `
      <tr class="match_row">
        <td class="league">英超</td>
        <td class="kickoff">2026-05-28 23:00</td>
        <td class="vs">阿森纳 vs 切尔西</td>
        <td class="spf-3">2.5</td>
        <td class="spf-1">3.2</td>
        <td class="spf-0">2.8</td>
      </tr>`;
    const out = parseFiveHundredJingcaiHtml(html, "2026-05-28");
    assert.equal(out.length, 1);
    assert.equal(out[0].homeTeam, "阿森纳");
  });
});

describe("Netease caipiao parser", () => {
  it("extracts fixtures from window.MATCH_DATA payload", () => {
    const html = `<html><body><script>window.MATCH_DATA = {"matches":[
      {"time":"2026-05-28 22:00","competition":"欧协联","home":"拉齐奥","away":"比尔森胜利","spf":{"home":2.10,"draw":3.40,"away":3.20}},
      {"time":"2026-05-29 03:00","competition":"欧冠","home":"X","away":"Y","spf":{"home":1.8,"draw":3.6,"away":4.5}}
    ]};</script></body></html>`;
    const out = parseNeteaseJingcaiHtml(html, "2026-05-28");
    assert.equal(out.length, 1);
    assert.equal(out[0].homeTeam, "拉齐奥");
    assert.equal(out[0].odds.home, 2.1);
    assert.equal(out[0].source, "163.com/caipiao");
  });

  it("returns empty when MATCH_DATA missing or malformed", () => {
    assert.equal(parseNeteaseJingcaiHtml("<html>nothing here</html>", "2026-05-28").length, 0);
    assert.equal(parseNeteaseJingcaiHtml(`<script>window.MATCH_DATA = "broken";</script>`, "2026-05-28").length, 0);
  });
});

describe("fetchPublicJingcaiFixtures top-level", () => {
  it("returns ok=false when fallback disabled", async () => {
    const result = await fetchPublicJingcaiFixtures("2026-05-28", () => {}, { JINGCAI_PUBLIC_FALLBACK_ENABLED: "0" });
    assert.equal(result.ok, false);
    assert.equal(result.warning, "JINGCAI_PUBLIC_FALLBACK_ENABLED=0");
  });

  it("returns ok=false when fetch impl missing", async () => {
    const result = await fetchPublicJingcaiFixtures("2026-05-28", null, {});
    assert.equal(result.ok, false);
    assert.equal(result.warning, "fetch 不可用");
  });

  it("aggregates from 500 and falls back to netease when 500 returns 0", async () => {
    let netCalls = 0;
    let fhCalls = 0;
    const fetchImpl = async (url) => {
      if (url.includes("trade.500.com")) {
        fhCalls++;
        return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0]).buffer, text: async () => "" };
      }
      if (url.includes("sports.163.com")) {
        netCalls++;
        const html = `<script>window.MATCH_DATA = {"matches":[{"time":"2026-05-28 22:00","competition":"欧协联","home":"A","away":"B","spf":{"home":2.1,"draw":3.4,"away":3.2}}]};</script>`;
        return { ok: true, status: 200, text: async () => html };
      }
      return { ok: false, status: 500 };
    };
    const result = await fetchPublicJingcaiFixtures("2026-05-28", fetchImpl, {});
    assert.equal(fhCalls, 1);
    assert.equal(netCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.fixtures.length, 1);
    assert.equal(result.fixtures[0].homeTeam, "A");
  });

  it("returns ok=false when both sources fail", async () => {
    const fetchImpl = async () => { throw new Error("ENETUNREACH"); };
    const result = await fetchPublicJingcaiFixtures("2026-05-28", fetchImpl, {});
    assert.equal(result.ok, false);
    assert.equal(result.fixtures.length, 0);
    assert.equal(result.sourceStatus.length, 2);
    assert.equal(result.sourceStatus.every((s) => s.ok === false), true);
  });
});
