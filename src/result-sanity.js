// 赛果先于开赛的矛盾自检(2026-06-10 对抗审计 T1 去毒范围漏洞配套)。
//
// 不变量:fixture store 里"未开赛(hasKickedOff 口径,date-only kickoff 取 23:59:59
// 宁晚判)"的场绝不允许带 result——没踢的比赛不存在真实赛果,任何 result 都是
// 错配/假赛果(06-10 事故:42+12 条未开赛世界杯场被热身赛假赛果污染)。
//
// 两个消费点:
//   - scripts/detox-ledger-2026-06-10.mjs 第二步(清洗动作,扫描域=store 全部日期文件);
//   - scripts/backfill-results.mjs(只告警不写:backfill 跳过已有 result 的场,
//     毒数据对它"不可见不自愈",必须 fail-loud 提示跑 detox)。

import { readdirSync } from "node:fs";
import { hasKickedOff } from "./kickoff-time.js";

/**
 * 找出"已有 result 但按 hasKickedOff 口径当前仍未开赛"的矛盾场。
 * kickoff 缺失/不可解析也算矛盾(无法证明已开赛的 result 不可信,宁 pending 勿假)。
 * @param {Array<object>} fixtures
 * @param {number} now epoch ms
 * @returns {Array<object>} 矛盾 fixture 子集(原对象引用,不拷贝)
 */
export function findPrematureResults(fixtures, now = Date.now()) {
  return (Array.isArray(fixtures) ? fixtures : []).filter((f) => f?.result && !hasKickedOff(f, now));
}

/**
 * 枚举 fixture store 目录下全部"日期文件"(YYYY-MM-DD.json)的日期,升序。
 * 去毒/全量体检的扫描域必须用它,绝不能用"ledger 出现过的日期"——
 * ledger 某日 0 行时该日 store 文件就永远扫不到(T1 漏洞根因:2026-06-06.json
 * 12 条假赛果因 ledger 无 06-06 行而 0 清洗且永不自愈)。
 * 非日期命名(含 .bak/.backup 等)一律排除。
 * @param {string} dir fixture store 目录
 * @returns {string[]}
 */
export function listStoreDates(dir) {
  return readdirSync(dir)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .map((file) => file.slice(0, 10))
    .sort();
}
