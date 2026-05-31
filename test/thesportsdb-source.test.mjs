import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTsdbEvents, fetchTsdbRoundResults } from "../src/thesportsdb-results-source.js";

test("normalizeTsdbEvents 只取带比分场 + 半场/赔率优雅缺省", () => {
  const events = [
    { idEvent: "1", dateEvent: "2024-03-01", strHomeTeam: "Ulsan", strAwayTeam: "Pohang", intHomeScore: "1", intAwayScore: "0" },
    { idEvent: "2", dateEvent: "2024-03-01", strHomeTeam: "A", strAwayTeam: "B", intHomeScore: "2", intAwayScore: "2", intHomeScoreHT: "1", intAwayScoreHT: "0" },
    { idEvent: "3", dateEvent: "2024-03-02", strHomeTeam: "C", strAwayTeam: "D", intHomeScore: null, intAwayScore: null }, // 未完赛
  ];
  const out = normalizeTsdbEvents(events, "韩K");
  assert.equal(out.length, 2, "跳过无比分场");
  assert.equal(out[0].league, "韩K");
  assert.equal(out[0].homeGoals, 1);
  assert.equal(out[0].halfHome, null, "无半场→null");
  assert.equal(out[1].halfHome, 1, "有半场则保留");
  assert.equal(out[0].odds, null);
  assert.equal(normalizeTsdbEvents(null, "X").length, 0);
});

test("fetchTsdbRoundResults 去重 + 连续空轮提前停 + 安全失败", async () => {
  // 假 fetch:第1轮两场、第2轮重复第1场+新场、其后全空
  const fakeFetch = async (url) => {
    const r = Number(new URL(url).searchParams.get("r"));
    const body = r === 1
      ? { events: [{ idEvent: "1", intHomeScore: "1", intAwayScore: "0", strHomeTeam: "A", strAwayTeam: "B", dateEvent: "d1" }] }
      : r === 2
        ? { events: [{ idEvent: "1", intHomeScore: "1", intAwayScore: "0", strHomeTeam: "A", strAwayTeam: "B", dateEvent: "d1" }, { idEvent: "2", intHomeScore: "3", intAwayScore: "1", strHomeTeam: "C", strAwayTeam: "D", dateEvent: "d2" }] }
        : { events: null };
    return { ok: true, json: async () => body };
  };
  const res = await fetchTsdbRoundResults({ leagueId: "4689", label: "韩K", seasons: ["2024"], maxRound: 10, throttleMs: 0, fetch: fakeFetch });
  assert.equal(res.count, 2, "idEvent 去重后 2 场");
  assert.ok(res.ok);

  // 全失败 → ok:false,不抛
  const failFetch = async () => { throw new Error("network"); };
  const bad = await fetchTsdbRoundResults({ leagueId: "x", label: "Y", seasons: ["2024"], maxRound: 10, throttleMs: 0, fetch: failFetch });
  assert.equal(bad.ok, false);
  assert.equal(bad.count, 0);
});
