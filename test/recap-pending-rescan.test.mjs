import test from "node:test";
import assert from "node:assert/strict";
import { rescanPendingLedgerRows, PENDING_RESCAN_DAYS } from "../src/daily-recap.js";

// 结算孤儿重扫守护(2026-06-10 审计rank3):recap 主路径只在 row.date===targetDate 当次
// 访问一次;WC 场 kickoff 纯日期判 23:59:59 才算已开赛、recap 固定业务日+1 的 11:10 跑 →
// 永远早于判定线,之后无人重访 → pending 永久(实证 99/102)。本组测试锁死:
//   ① 窗内已开赛的 pending 孤儿在后续 recap 运行中被既有结算逻辑补结算;
//   ② 未开赛的行仍 pending(hasKickedOff 硬闸原样生效,绝不假结算);
//   ③ 窗外/已结算/targetDate 当日行不被重扫触碰。

function isoShift(base, days) {
  const value = new Date(`${base}T00:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

const targetDate = "2026-06-09"; // 模拟 06-10 上午跑 recap(targetDate=业务日昨天)
const orphanDate = isoShift(targetDate, -2);     // 窗内孤儿:06-07(date!==targetDate,主路径不再访问)
const todayDate = isoShift(targetDate, 1);       // “今天”:06-10
const outsideDate = isoShift(targetDate, -(PENDING_RESCAN_DAYS + 1)); // 窗外

function pendingRow(date, sequence, match, extra = {}) {
  return {
    date, sequence, competition: "世界杯", match,
    primary: "主胜", secondary: "平局",
    actualStatus: "pending-result", pendingReason: "比赛未开赛/未完赛",
    ...extra,
  };
}

// fixtures 按日期注入(deps),不触真盘。
const fixturesByDate = {
  [orphanDate]: [{
    sequence: "1", competition: "世界杯", homeTeam: "墨西哥", awayTeam: "南非",
    date: orphanDate, kickoff: `${orphanDate} 19:30`, // 已开赛(过去时刻)
    result: { home: 2, away: 0 },
  }],
  [todayDate]: [{
    sequence: "2", competition: "世界杯", homeTeam: "美国", awayTeam: "加拿大",
    date: todayDate, kickoff: "2099-06-12", // 未开赛(未来),即便 store 被错误回填 result
    result: { home: 5, away: 1 },
  }],
  [outsideDate]: [{
    sequence: "3", competition: "英超", homeTeam: "阿森纳", awayTeam: "切尔西",
    date: outsideDate, kickoff: `${outsideDate} 19:30`,
    result: { home: 1, away: 1 },
  }],
};
const deps = {
  loadFixturesFn: (date) => fixturesByDate[date] ?? [],
  loadSnapshotsFn: () => [],
};

test("窗内孤儿(date=前天,kickoff 已过)重扫后被结算", () => {
  const ledger = [pendingRow(orphanDate, "1", "墨西哥 对 南非")];
  const out = rescanPendingLedgerRows(ledger, targetDate, deps);
  assert.equal(out.rescanned, 1);
  assert.equal(out.settled, 1);
  const row = out.rows[0];
  assert.equal(row.actualStatus, "settled");
  assert.equal(row.actualScore, "2-0");
  assert.equal(row.actual, "主胜");
  assert.equal(row.hit, true);
});

test("date=今天、kickoff 未到 → 仍 pending(硬闸生效,store 有 result 也不结算)", () => {
  const ledger = [pendingRow(todayDate, "2", "美国 对 加拿大")];
  const out = rescanPendingLedgerRows(ledger, targetDate, deps);
  assert.equal(out.rescanned, 0, "未开赛的行不得进入结算路径");
  assert.equal(out.settled, 0);
  const row = out.rows[0];
  assert.equal(row.actualStatus, "pending-result");
  assert.equal(row.actual, undefined, "不得写入 actual");
  assert.equal(row.hit, undefined, "不得写入 hit");
});

test("窗外(>10天)pending 行不重扫;已结算行不重访;targetDate 当日行留给主路径", () => {
  const settledRow = pendingRow(orphanDate, "1", "墨西哥 对 南非", { actualStatus: "settled", actual: "主胜", actualScore: "2-0", settledAt: "2026-06-08T03:00:00Z" });
  const ledger = [
    pendingRow(outsideDate, "3", "阿森纳 对 切尔西"), // 窗外:fixture 有赛果也不碰
    settledRow,                                        // 已结算:原样返回
    pendingRow(targetDate, "9", "巴西 对 阿根廷"),      // targetDate 当日:主路径管,重扫跳过
  ];
  const out = rescanPendingLedgerRows(ledger, targetDate, deps);
  assert.equal(out.rescanned, 0);
  assert.equal(out.settled, 0);
  assert.equal(out.rows[0].actualStatus, "pending-result", "窗外行必须原样保留");
  assert.deepEqual(out.rows[1], settledRow, "已结算行必须原样返回");
  assert.equal(out.rows[2].actualStatus, "pending-result", "targetDate 行不在重扫范围");
  assert.equal(out.window.from, isoShift(targetDate, -PENDING_RESCAN_DAYS));
  assert.equal(out.window.to, isoShift(targetDate, 1), "窗上限=targetDate+1,覆盖“今天”的行");
});
