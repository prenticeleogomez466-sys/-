import assert from "node:assert/strict";
import test from "node:test";
import { loadFootballDataMatches, EXTENDED_LEAGUES, ALL_LEAGUES, LEAGUE_LABELS } from "../src/footballdata-loader.js";

function makeCsv(rows) {
  const header = "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,AvgH,AvgD,AvgA,AvgCH,AvgCD,AvgCA";
  const body = rows.map((r) => `XX,${r.date},20:00,${r.home},${r.away},${r.hg},${r.ag},X,0,0,D,Ref,2.0,3.4,3.6,1.9,3.5,4.0`);
  return [header, ...body].join("\n");
}
// 按 league code 路由的 mock fetch:每个联赛回 2 场
function routedFetch(url) {
  const m = String(url).match(/\/(\w+)\.csv$/);
  const code = m ? m[1] : "X";
  const csv = makeCsv([
    { date: "10/08/2024", home: `${code}A`, away: `${code}B`, hg: 2, ag: 1 },
    { date: "17/08/2024", home: `${code}C`, away: `${code}D`, hg: 0, ag: 0 }
  ]);
  return { ok: true, text: async () => csv };
}

test("EXTENDED_LEAGUES / ALL_LEAGUES / LEAGUE_LABELS 结构正确", () => {
  assert.equal(EXTENDED_LEAGUES.length, 13);
  assert.equal(ALL_LEAGUES.length, 18, "big5 + 13 扩展");
  assert.ok(!EXTENDED_LEAGUES.includes("E0"), "扩展集不含 big-5,避免与 OpenFootball 重复");
  assert.equal(LEAGUE_LABELS.N1, "荷甲");
  assert.equal(LEAGUE_LABELS.P1, "葡超");
  assert.equal(LEAGUE_LABELS.E1, "英冠");
});

test("loadFootballDataMatches 能加载扩展联赛并带开盘+收盘赔率", async () => {
  const res = await loadFootballDataMatches({
    leagues: ["N1", "P1", "T1"], seasons: ["2425"], fetch: async (url) => routedFetch(url)
  });
  assert.equal(res.ok, true);
  assert.equal(res.matches.length, 6, "3 联赛 × 2 场");
  assert.equal(res.withClosing, 6, "全部带收盘赔率");
  const nl = res.matches.find((m) => m.league === "N1");
  assert.ok(nl.odds && nl.oddsClose, "应同时有开盘与收盘隐含概率");
  assert.ok(nl.odds.home > 0 && Math.abs(nl.odds.home + nl.odds.draw + nl.odds.away - 1) < 1e-9);
});
