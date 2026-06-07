import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEuropeanOdds, wcFixturesFromSnapshots } from "../scripts/ingest-worldcup-match-odds.mjs";

test("pickEuropeanOdds 取 final>current>initial,无效/缺失→null(不臆造)", () => {
  assert.deepEqual(pickEuropeanOdds({ initial: { home: 2, draw: 3, away: 4 }, current: { home: 1.9, draw: 3.1, away: 4.2 } }),
    { home: 1.9, draw: 3.1, away: 4.2 });
  assert.deepEqual(pickEuropeanOdds({ current: { home: 1.5, draw: 4, away: 7 }, final: { home: 1.4, draw: 4.5, away: 8 } }),
    { home: 1.4, draw: 4.5, away: 8 });
  assert.equal(pickEuropeanOdds(null), null);
  assert.equal(pickEuropeanOdds({ current: null }), null);
  assert.equal(pickEuropeanOdds({ current: { home: 1, draw: 3, away: 4 } }), null); // home<=1 无效
});

test("wcFixturesFromSnapshots 只收世界杯真实欧赔,14场胜负彩(europeanOdds=null)跳过", () => {
  const zhToEn = { "墨西哥": "Mexico", "南非": "South Africa", "韩国": "Korea Republic", "捷克": "Czechia" };
  const snaps = [
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", marketType: "jingcai",
      europeanOdds: { current: { home: 1.5, draw: 4, away: 7 } }, collectedAt: "2026-06-10T00:00:00Z", source: "jc" },
    { competition: "世界杯", homeTeam: "韩国", awayTeam: "捷克", marketType: "shengfucai",
      europeanOdds: null, asianHandicap: { current: { line: -0.25 } }, collectedAt: "2026-06-09" }, // 14场无欧赔→跳过
    { competition: "国际赛", homeTeam: "克罗地亚", awayTeam: "斯洛文尼亚",
      europeanOdds: { current: { home: 1.24, draw: 4.6, away: 9.45 } }, collectedAt: "2026-06-07" }, // 非世界杯→跳过
  ];
  const m = wcFixturesFromSnapshots(snaps, zhToEn, "fallback");
  assert.equal(m.size, 1, "只墨西哥vs南非一条");
  const fx = [...m.values()][0];
  assert.equal(fx.home, "Mexico"); // 中文→groups 英文规范名
  assert.equal(fx.away, "South Africa");
  assert.deepEqual(fx.odds, { home: 1.5, draw: 4, away: 7 });
});

test("wcFixturesFromSnapshots 同对阵保留 collectedAt 最新", () => {
  const zhToEn = { "墨西哥": "Mexico", "南非": "South Africa" };
  const snaps = [
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", europeanOdds: { current: { home: 1.6, draw: 3.9, away: 6 } }, collectedAt: "2026-06-08" },
    { competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非", europeanOdds: { current: { home: 1.5, draw: 4.0, away: 7 } }, collectedAt: "2026-06-10" },
  ];
  const fx = [...wcFixturesFromSnapshots(snaps, zhToEn).values()][0];
  assert.equal(fx.collectedAt, "2026-06-10");
  assert.equal(fx.odds.away, 7);
});
