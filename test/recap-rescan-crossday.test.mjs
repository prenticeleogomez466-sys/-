// 复盘结算覆盖守护(2026-06-14 用户裁决"复盘覆盖要全面 + 进化模型"):
//   P1 跨日场:14场腿/预售场 row.date=销售业务日,比赛数日后开赛,只在 row.date±1 找 fixture 永远查不到
//      (30条孤儿永久"无状态")→ 全窗口按队名找带赛果场必须能结算。
//   P2 灭"无状态"真空:任何未结算行都必须带 pendingReason(诚实标因,绝不三不管)。
import { test } from "node:test";
import assert from "node:assert";
import { rescanPendingLedgerRows, findResultFixtureByTeams } from "../src/daily-recap.js";

const PAST = "2020-01-01 12:00"; // 明确已开赛
const FUTURE = "2099-01-01 12:00"; // 明确未开赛

test("P1 跨日场:row.date 早于真实开赛日,全窗口按队名找到带赛果场→结算", () => {
  const ledger = [{
    date: "2026-06-04", sequence: "9", competition: "世界杯",
    match: "西班牙 对 佛得角", primary: "主胜", handicapLine: 0,
  }];
  // 销售日 06-04/05 无该场;真实比赛在 06-07 store 带赛果(跨3天)
  const fixturesByDate = {
    "2026-06-07": [{ sequence: "1013", competition: "世界杯", homeTeam: "西班牙", awayTeam: "佛得角", kickoff: PAST, result: { home: 3, away: 0 } }],
  };
  const out = rescanPendingLedgerRows(ledger, "2026-06-08", {
    loadFixturesFn: (d) => fixturesByDate[d] ?? [],
    loadSnapshotsFn: () => [],
  });
  const row = out.rows[0];
  assert.strictEqual(row.actualStatus, "settled", "跨日场未被结算: " + JSON.stringify(row));
  assert.strictEqual(row.actualScore, "3-0");
  assert.strictEqual(row.hit, true, "主胜应命中 3-0");
  assert.ok(out.settled >= 1);
});

test("P2 灭无状态:全窗口都找不到 fixture 的未结算行,必须补 pendingReason", () => {
  const ledger = [{ date: "2026-06-04", sequence: "9", competition: "世界杯", match: "某队A 对 某队B", primary: "主胜" }];
  const out = rescanPendingLedgerRows(ledger, "2026-06-08", { loadFixturesFn: () => [], loadSnapshotsFn: () => [] });
  const row = out.rows[0];
  assert.strictEqual(row.actualStatus, "pending-result", "无状态行未被补状态");
  assert.ok(typeof row.pendingReason === "string" && row.pendingReason.trim(), "未写 pendingReason: " + JSON.stringify(row));
  assert.ok(out.pendingFilled >= 1);
});

test("P2 未开赛行:补'未开赛'理由,绝不假结算", () => {
  const ledger = [{ date: "2026-06-04", sequence: "9", competition: "世界杯", match: "西班牙 对 佛得角", primary: "主胜" }];
  const fixturesByDate = {
    "2026-06-07": [{ sequence: "1013", competition: "世界杯", homeTeam: "西班牙", awayTeam: "佛得角", kickoff: FUTURE, result: null }],
  };
  const out = rescanPendingLedgerRows(ledger, "2026-06-08", { loadFixturesFn: (d) => fixturesByDate[d] ?? [], loadSnapshotsFn: () => [] });
  const row = out.rows[0];
  assert.strictEqual(row.actualStatus, "pending-result");
  assert.match(row.pendingReason, /未开赛|未完赛/);
  assert.notStrictEqual(row.actualStatus, "settled");
});

test("findResultFixtureByTeams 只信队名(不信跨日 sequence)+ 必须带赛果且已开赛", () => {
  const row = { match: "西班牙 对 佛得角", sequence: "9" };
  const pool = [
    { sequence: "9", homeTeam: "别的队", awayTeam: "别的队2", kickoff: PAST, result: { home: 1, away: 0 } }, // seq同但队名不符→不取
    { sequence: "1013", homeTeam: "西班牙", awayTeam: "佛得角", kickoff: FUTURE, result: null }, // 队名符但未开赛/无赛果→不取
    { sequence: "1013", homeTeam: "西班牙", awayTeam: "佛得角", kickoff: PAST, result: { home: 3, away: 0 } }, // 正解
  ];
  const fx = findResultFixtureByTeams(row, pool);
  assert.ok(fx && fx.result.home === 3 && fx.result.away === 0, "未命中正确的带赛果跨日场");
});
