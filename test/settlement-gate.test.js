import assert from "node:assert/strict";
import test from "node:test";
import { kickoffEpochMs, hasKickedOff, fixtureMatchDate, withinDays } from "../src/kickoff-time.js";
import { updateLedgerRow } from "../src/daily-recap.js";

// 结算硬闸守护(2026-06-10 缺陷#1#2):42+ 条未开赛世界杯场曾被热身赛假赛果结算
// (业务日 06-07 的场 kickoff=06-12,旧 isKickoffFuture 用 fixture.date 拼时刻误判"已过期",
//  叠加 backfill 单边锚定错配)。本组测试锁死:未开赛/kickoff 不可判定的场绝不结算。

// ── kickoff-time 解析 ──────────────────────────────────────────────
test("kickoff 内嵌日期优先于 fixture.date(世界杯赛程根因)", () => {
  const f = { date: "2026-06-07", kickoff: "2026-06-12" };
  assert.equal(fixtureMatchDate(f), "2026-06-12");
  assert.equal(kickoffEpochMs(f), new Date("2026-06-12T23:59:59+08:00").getTime());
});

test("kickoff 只有 HH:mm 时用 fixture.date 拼时刻", () => {
  const f = { date: "2026-06-07", kickoff: "19:30" };
  assert.equal(kickoffEpochMs(f), new Date("2026-06-07T19:30:00+08:00").getTime());
});

test("kickoff 缺失/不可解析 → null,hasKickedOff=false(不兜底,绝不放行结算)", () => {
  assert.equal(kickoffEpochMs({ date: "2026-06-07", kickoff: "" }), null);
  assert.equal(kickoffEpochMs({ date: "2026-06-07" }), null);
  assert.equal(hasKickedOff({ date: "2026-06-07", kickoff: "" }), false);
});

test("hasKickedOff:未来场=false,过去场=true", () => {
  assert.equal(hasKickedOff({ date: "2026-06-07", kickoff: "2099-01-01" }), false);
  assert.equal(hasKickedOff({ date: "2020-01-01", kickoff: "2020-01-01 19:30" }), true);
});

// ── 结算路径硬闸:未开赛场喂 result 也绝不结算 ─────────────────────
function row(extra = {}) {
  return {
    date: "2026-06-07", sequence: "1", competition: "世界杯",
    match: "墨西哥 对 南非", primary: "主胜", secondary: "平局",
    scorePrimary: "2-0", halfFullPrimary: "主胜-主胜",
    ...extra
  };
}

test("硬闸:kickoff 在未来的场即便 store 有 result 也拒绝结算(缺陷#1 根因)", () => {
  const fixture = {
    sequence: "1", competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非",
    date: "2026-06-07", kickoff: "2099-06-12", result: { home: 5, away: 1 }
  };
  const out = updateLedgerRow(row(), [fixture]);
  assert.equal(out.actualStatus, "pending-result");
  assert.equal(out.actual, undefined, "不得写入 actual");
  assert.equal(out.actualScore, undefined, "不得写入 actualScore");
  assert.equal(out.hit, undefined, "不得写入 hit");
  assert.match(out.pendingReason, /未开赛/);
});

test("硬闸:拒绝结算时清掉历史假结算残留字段(去毒不留 stale settled)", () => {
  const fixture = {
    sequence: "1", competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非",
    date: "2026-06-07", kickoff: "2099-06-12", result: { home: 5, away: 1 }
  };
  const poisoned = row({ actual: "主胜", actualScore: "5-1", actualStatus: "settled", hit: true, settledAt: "2026-06-08T03:16:27.196Z" });
  const out = updateLedgerRow(poisoned, [fixture]);
  assert.equal(out.actualStatus, "pending-result");
  assert.equal(out.actual, undefined, "stale actual 必须清掉(统计口径 actual 非空即算 settled)");
  assert.equal(out.actualScore, undefined);
  assert.equal(out.hit, undefined);
  assert.equal(out.settledAt, undefined);
  assert.equal(out.primary, "主胜", "pick 本身必须保留");
});

test("硬闸:kickoff 缺失的场有 result 也拒绝结算(不可判定=不结算)", () => {
  const fixture = {
    sequence: "1", competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非",
    date: "2026-06-07", kickoff: "", result: { home: 5, away: 1 }
  };
  const out = updateLedgerRow(row(), [fixture]);
  assert.equal(out.actualStatus, "pending-result");
  assert.equal(out.actual, undefined);
  assert.match(out.pendingReason, /缺失|不可解析/);
});

test("对照:已开赛的场照常结算(闸只挡未开赛,不误杀正常结算)", () => {
  const fixture = {
    sequence: "1", competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非",
    date: "2020-01-01", kickoff: "2020-01-01 19:30", result: { home: 2, away: 0 }
  };
  const out = updateLedgerRow(row({ date: "2020-01-01" }), [fixture]);
  assert.equal(out.actualStatus, "settled");
  assert.equal(out.actualScore, "2-0");
  assert.equal(out.actual, "主胜");
  assert.equal(out.hit, true);
});

// ── 跨源对阵匹配 ±2 天约束(缺陷#2:同对阵不同日期不得共享赛果) ──
test("withinDays:真实比赛日相差>2天 → 不是同一场(热身赛≠世界杯小组赛)", () => {
  const friendly = { date: "2026-06-09", kickoff: "2026-06-09 23:00" };
  const worldCup = { date: "2026-06-09", kickoff: "2026-06-12" };
  assert.equal(withinDays(friendly, worldCup, 2), false);
});

test("withinDays:相差≤2天放行;任一方无日期不收紧(防误杀)", () => {
  assert.equal(withinDays({ date: "2026-06-09" }, { date: "2026-06-10" }, 2), true);
  assert.equal(withinDays({ date: "2026-06-09" }, { date: "", kickoff: "" }, 2), true);
});
