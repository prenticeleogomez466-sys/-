import assert from "node:assert/strict";
import test from "node:test";
import { fetchEspnResults, loadEspnResults, monthRanges, ESPN_LEAGUES } from "../src/espn-results-source.js";

function scoreboard(events) { return { ok: true, json: async () => ({ events }) }; }
function event(home, away, hg, ag, date, completed = true) {
  return {
    date, status: { type: { completed } },
    competitions: [{ competitors: [
      { homeAway: "home", team: { displayName: home }, score: String(hg) },
      { homeAway: "away", team: { displayName: away }, score: String(ag) }
    ] }]
  };
}

test("monthRanges 按自然月切分,含起止月", () => {
  const r = monthRanges("2024-11-15", "2025-02-03");
  assert.deepEqual(r, ["20241101-20241130", "20241201-20241231", "20250101-20250131", "20250201-20250228"]);
});

test("fetchEspnResults 只取完赛、解析比分/队名/日期", async () => {
  const fetchImpl = async () => scoreboard([
    event("Yokohama FC", "Avispa Fukuoka", 1, 0, "2025-05-10T05:00Z"),
    event("Team C", "Team D", 2, 2, "2025-05-11T05:00Z", false) // 未完赛,排除
  ]);
  const res = await fetchEspnResults("jpn.1", { from: "2025-05-01", to: "2025-05-31", fetch: fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.label, "日职");
  assert.equal(res.matches.length, 1, "未完赛被排除");
  assert.deepEqual(res.matches[0], { home: "Yokohama FC", away: "Avispa Fukuoka", homeGoals: 1, awayGoals: 0, date: "2025-05-10", league: "日职" });
});

test("loadEspnResults 聚合多联赛 + byLeague 计数", async () => {
  const fetchImpl = async (url) => scoreboard([event("H", "A", 3, 1, "2025-05-10T00:00Z")]);
  const res = await loadEspnResults({ leagues: ["jpn.1", "bra.1"], from: "2025-05-01", to: "2025-05-31", fetch: fetchImpl });
  assert.equal(res.ok, true);
  assert.ok(res.byLeague["日职"] >= 1 && res.byLeague["巴甲"] >= 1);
  assert.equal(ESPN_LEAGUES["chn.1"], "中超");
});

test("缺 from/to 安全返回 ok:false", async () => {
  const res = await fetchEspnResults("jpn.1", { fetch: async () => scoreboard([]) });
  assert.equal(res.ok, false);
});
