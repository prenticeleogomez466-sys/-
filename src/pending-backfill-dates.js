// 旧业务日 pending 自愈——待回填日期决策(2026-06-10 审计缺陷修复)。
//
// 背景:调度链(run-football-automation.ps1 Run-Recap)恒带 --date=昨天,而跨日开赛的场
// (业务日 06-09 的 2202 匈牙利 vs 哈萨克斯坦,kickoff=06-10 凌晨)在"昨天"那次 recap 里被
// hasKickedOff 闸**正确**拦下(date-only kickoff 取 23:59:59 宁晚勿早);但次日调度只访问
// --date=新昨天,旧业务日文件从无人重访 → result 永远回填不进 → 永久 pending。
//
// 本模块给 backfill-results.mjs 的"无 --date 扫 ledger"模式提供日期决策:
//   - 只取 ledger 仍 pending(未结算)的**过去**业务日(排除今天/未来——没踢完);
//   - 默认窗口近 PENDING_BACKFILL_WINDOW_DAYS 天:与 daily-recap.rescanPendingLedgerRows 的
//     PENDING_RESCAN_DAYS 同窗——backfill 写进 store 的 result 必须落在 rescan 能结算的窗内
//     才有意义;同时避免对永远配不上 ESPN 的陈年 pending 每天无限重抓。
//   - windowDays<=0 = 不设窗(人工全量扫場景,scripts/backfill-results.mjs --days all)。
//
// 不在此处兜底任何赛果——这里只挑日期,回填本体仍受 hasKickedOff 闸 + strict 双边匹配保护。

import { isoAddDays, fixtureMatchDate } from "./kickoff-time.js";

// 与 src/daily-recap.js 的 PENDING_RESCAN_DAYS 保持一致(有测试锁定对齐,改一边必须同改)。
// 不直接 import daily-recap:避免把 recap 全链路依赖拖进轻量 backfill 脚本。
export const PENDING_BACKFILL_WINDOW_DAYS = 10;

/**
 * 从 ledger 行算出需要回填赛果的旧业务日(升序、去重)。
 * @param {Array}  ledgerRows recommendation-ledger.json 的行
 * @param {Object} opts
 * @param {string} opts.todayIso    今天(上海业务日,YYYY-MM-DD),必填——绝不在模块内偷取本机时区
 * @param {number} [opts.windowDays] 回看窗口天数;<=0 表示不设窗
 * @returns {string[]}
 */
export function pendingBackfillDates(ledgerRows, { todayIso, windowDays = PENDING_BACKFILL_WINDOW_DAYS } = {}) {
  if (!Array.isArray(ledgerRows) || !/^\d{4}-\d{2}-\d{2}$/.test(String(todayIso ?? ""))) return [];
  const minDate = windowDays > 0 ? isoAddDays(todayIso, -windowDays) : null;
  const set = new Set();
  for (const row of ledgerRows) {
    const settled = row?.actualStatus === "settled" || (row?.actual && row.actual !== "");
    if (settled) continue;
    const date = String(row?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date >= todayIso) continue; // 今天/未来没踢完,不抓
    if (minDate && date < minDate) continue; // 窗外陈年 pending 不每天重抓(与 rescan 同窗)
    set.add(date);
  }
  return [...set].sort();
}

// ───────────── ESPN 赛果池抓取日决策(审计③:池窗够不到真比赛日)─────────────
// 旧池恒为业务日±3 天;但竞彩业务日可比真实开赛日早很多(06-07 业务日的世界杯场
// 真开赛 06-12~06-16),开赛后回访旧业务日时池里根本没有真比赛日 → 永远配不上。
// 修法:基础窗(业务日±3,兼容旧行为)∪ 每个待回填场的真实比赛日±1
// (fixtureMatchDate=kickoff 内嵌日期优先;ESPN 按美区日界可与上海差 1 天)。

export const BASE_POOL_DELTAS = [-3, -2, -1, 0, 1, 2, 3];
export const MATCHDAY_POOL_DELTAS = [-1, 0, 1];

/**
 * 某业务日待回填场所需抓取的 ESPN scoreboard 日期集合(ISO,升序去重)。
 * @param {string} businessDate YYYY-MM-DD 业务日
 * @param {Array}  needFixtures 已开赛且缺 result 的 fixture 列表
 * @returns {string[]}
 */
export function espnPoolDays(businessDate, needFixtures = []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate ?? ""))) return [];
  const days = new Set();
  for (const d of BASE_POOL_DELTAS) days.add(isoAddDays(businessDate, d));
  for (const f of needFixtures ?? []) {
    const md = fixtureMatchDate(f);
    if (md) for (const d of MATCHDAY_POOL_DELTAS) days.add(isoAddDays(md, d));
  }
  return [...days].sort();
}

/**
 * 候选赛果与该场真实比赛日的最大允许日距(天)——防扩窗后跨期错配
 * (世界杯小组赛若 ESPN 当日抓取失败,绝不能让池里早几天的同对阵热身赛顶上,
 *  这正是 06-10"42 条假赛果"的毒源形态):
 *   - kickoff 内嵌真实比赛日的场:±1(只容 ESPN 美区日界差);
 *   - 只有业务日可锚的场:±3(实测业务日比真实开赛日早 1-2 天,5-21→5-23)。
 */
export function poolDayCapDays(fixture) {
  return /\d{4}-\d{2}-\d{2}/.test(String(fixture?.kickoff ?? "")) ? 1 : 3;
}
