import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMarketSnapshot } from "../src/market-data-store.js";

// 回归锁:2026-06-07 发现 normalizeMarketSnapshot 漏赋 totalGoalsOdds → 500.com pl_jqs 总进球真盘
// 在持久化层被静默丢弃(scoreOdds/halfFullOdds 留着、唯独总进球归零)。此测试钉住该字段必须保留,
// 防止"全赔种全覆盖"再被悄悄破坏。见 feedback_fetch_all_then_audit。

test("normalizeMarketSnapshot 保留 totalGoalsOdds 真盘分布(over25/under25/dist)", () => {
  const raw = {
    date: "2026-06-07",
    fixtureId: "jc500-2026-06-07-7201-x",
    homeTeam: "克罗地亚",
    awayTeam: "斯洛文尼亚",
    marketType: "jingcai",
    europeanOdds: { initial: { home: 1.26, draw: 4.45, away: 9.0 }, current: { home: 1.26, draw: 4.45, away: 9.0 } },
    totalGoalsOdds: {
      over25: 0.536,
      under25: 0.464,
      dist: { 0: 0.064, 1: 0.166, 2: 0.235, 3: 0.231, 4: 0.152, 5: 0.084, 6: 0.042, 7: 0.027 },
      source: "500.com-jczq-jqs"
    }
  };
  const out = normalizeMarketSnapshot(raw, "2026-06-07");
  assert.ok(out.totalGoalsOdds, "totalGoalsOdds 不应被丢弃");
  assert.equal(out.totalGoalsOdds.over25, 0.536);
  assert.equal(out.totalGoalsOdds.under25, 0.464);
  assert.equal(out.totalGoalsOdds.source, "500.com-jczq-jqs");
  assert.equal(Object.keys(out.totalGoalsOdds.dist).length, 8, "0~7 球分布应完整保留");
  assert.equal(out.totalGoalsOdds.dist["2"], 0.235);
});

test("normalizeMarketSnapshot 总进球缺失时为 null(标缺不冒充)", () => {
  const out = normalizeMarketSnapshot(
    { date: "2026-06-07", fixtureId: "x-1", homeTeam: "A", awayTeam: "B", marketType: "jingcai" },
    "2026-06-07"
  );
  assert.equal(out.totalGoalsOdds, null);
});

test("normalizeMarketSnapshot 过滤越界概率值", () => {
  const out = normalizeMarketSnapshot(
    {
      date: "2026-06-07", fixtureId: "x-2", homeTeam: "A", awayTeam: "B", marketType: "jingcai",
      totalGoalsOdds: { over25: 1.7, under25: -0.2, dist: { 0: 0.5, 1: "bad", 2: 0.5 }, source: "t" }
    },
    "2026-06-07"
  );
  // over25=1.7 / under25=-0.2 越界 → null;dist 仅保留合法 0..1 项
  assert.equal(out.totalGoalsOdds.over25, null);
  assert.equal(out.totalGoalsOdds.under25, null);
  assert.deepEqual(out.totalGoalsOdds.dist, { 0: 0.5, 2: 0.5 });
});
