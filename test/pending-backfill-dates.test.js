import assert from "node:assert/strict";
import test from "node:test";
import { pendingBackfillDates, PENDING_BACKFILL_WINDOW_DAYS, espnPoolDays, poolDayCapDays } from "../src/pending-backfill-dates.js";
import { PENDING_RESCAN_DAYS } from "../src/daily-recap.js";

// 旧业务日 pending 自愈守护(2026-06-10 审计缺陷):调度链恒带 --date=昨天,跨日开赛的场
// (06-09 业务日 2202 匈牙利 vs 哈萨克斯坦,kickoff=06-10 凌晨,date-only 被开赛闸按 23:59:59
// 宁晚判)在"昨天"那次 recap 被正确拦下后,旧业务日文件再无人重访 → result 永远回填不进 →
// 永久 pending。修法 = Run-Recap 增加无 --date 的 ledger 扫描回填,本组测试锁日期决策逻辑。

const TODAY = "2026-06-10";

test("回填窗与 recap 结算孤儿重扫窗必须同宽(backfill 写的 result 要落在 rescan 能结算的窗内)", () => {
  assert.equal(PENDING_BACKFILL_WINDOW_DAYS, PENDING_RESCAN_DAYS);
});

test("2202 回归场景:昨天业务日仍 pending → 必须进回填日期(调度已带过 --date 也要重访)", () => {
  const ledger = [
    { date: "2026-06-09", sequence: "2202", primary: "主胜", actualStatus: "pending-result" },
  ];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), ["2026-06-09"]);
});

test("只取 pending 行:settled / actual 非空的行不再重访", () => {
  const ledger = [
    { date: "2026-06-09", actualStatus: "settled", actual: "主胜" },
    { date: "2026-06-08", actual: "客胜" }, // 统计口径 actual 非空即算 settled
    { date: "2026-06-07", actualStatus: "pending-result" },
  ];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), ["2026-06-07"]);
});

test("排除今天与未来业务日(没踢完,绝不抓)", () => {
  const ledger = [
    { date: "2026-06-10", actualStatus: "pending-result" }, // 今天
    { date: "2026-06-11", actualStatus: "pending-result" }, // 未来
    { date: "2026-06-09", actualStatus: "pending-result" },
  ];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), ["2026-06-09"]);
});

test("默认窗口:超过近 N 天的陈年 pending 不再每天重抓;windowDays<=0 = 不设窗", () => {
  const old = "2026-05-20"; // 今天-21 天,窗外
  const inWindow = "2026-06-05";
  const ledger = [
    { date: old, actualStatus: "pending-result" },
    { date: inWindow, actualStatus: "pending-result" },
  ];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), [inWindow]);
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY, windowDays: 0 }), [old, inWindow]);
});

test("窗口边界:恰好 today-窗宽 的日期在窗内(>=minDate)", () => {
  const boundary = "2026-05-31"; // TODAY - 10 天
  const ledger = [{ date: boundary, actualStatus: "pending-result" }];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), [boundary]);
});

test("去重 + 升序;非法 date / 缺 todayIso 不崩、宁可返回空", () => {
  const ledger = [
    { date: "2026-06-09", actualStatus: "pending-result" },
    { date: "2026-06-09", actualStatus: "pending-result" },
    { date: "2026-06-07", actualStatus: "pending-result" },
    { date: "06-08", actualStatus: "pending-result" }, // 非法格式忽略
    { actualStatus: "pending-result" }, // 缺 date 忽略
  ];
  assert.deepEqual(pendingBackfillDates(ledger, { todayIso: TODAY }), ["2026-06-07", "2026-06-09"]);
  assert.deepEqual(pendingBackfillDates(ledger, {}), []);
  assert.deepEqual(pendingBackfillDates(null, { todayIso: TODAY }), []);
});

// ── ESPN 池抓取日扩窗(审计③:业务日±3 够不到真比赛日)──────────────────────

test("espnPoolDays 基础窗=业务日±3(无待回填场或场无真实比赛日时与旧行为一致)", () => {
  assert.deepEqual(espnPoolDays("2026-06-09", []), [
    "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09",
    "2026-06-10", "2026-06-11", "2026-06-12",
  ]);
});

test("espnPoolDays 并入待回填场真实比赛日±1:06-07 业务日的世界杯场(开赛 06-12/06-16)开赛后能被池覆盖", () => {
  const need = [
    { homeTeam: "墨西哥", awayTeam: "南非", kickoff: "2026-06-12" },
    { homeTeam: "沙特阿拉伯", awayTeam: "乌拉圭", kickoff: "2026-06-16" },
  ];
  const days = espnPoolDays("2026-06-07", need);
  for (const d of ["2026-06-11", "2026-06-12", "2026-06-13", "2026-06-15", "2026-06-16", "2026-06-17"]) {
    assert.ok(days.includes(d), `池抓取日必须含 ${d}(实际:${days.join(",")})`);
  }
  // 基础窗仍在(老式 kickoff 只有 HH:mm 的场靠业务日±3 命中)
  assert.ok(days.includes("2026-06-04") && days.includes("2026-06-10"));
  // 去重 + 升序
  assert.deepEqual(days, [...new Set(days)].sort());
});

test("espnPoolDays 非法业务日返回空(不猜)", () => {
  assert.deepEqual(espnPoolDays("06-07", []), []);
  assert.deepEqual(espnPoolDays(null, []), []);
});

test("poolDayCapDays 日距闸:kickoff 内嵌真实比赛日 ±1 天;只有业务日可锚 ±3 天(防扩窗后同对阵热身赛跨期顶包——06-10 假赛果毒源形态)", () => {
  assert.equal(poolDayCapDays({ kickoff: "2026-06-12" }), 1);
  assert.equal(poolDayCapDays({ kickoff: "2026-06-12 03:00" }), 1);
  assert.equal(poolDayCapDays({ kickoff: "15:30" }), 3);
  assert.equal(poolDayCapDays({}), 3);
});
