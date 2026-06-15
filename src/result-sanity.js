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
 * 第二不变量(2026-06-11 ledger-settlement-2 / store-hygiene-2):
 * 同一场物理比赛(真实赛日|主队|客队)在跨业务日 store 文件里的全部已结算副本,
 * 比分必须一致——互相矛盾 ⇒ 至少一份是假赛果/错配(06-10 事故同源残留:
 * 摩洛哥1-1挪威被四份 4-0 假副本压垮 DC 拟合)。这类坏值因 kickoff 已过,
 * findPrematureResults 永远抓不到;backfill 跳过已有 result 也不自愈,必须独立检测。
 *
 * @param {Array<{storeDate:string, fixture:object}>} entries 全 store 展平的(业务日,场次)对
 * @returns {Array<{key:string, scores:string[], copies:Array<{storeDate,score,competition,source}>}>}
 *   比分互斥的冲突组(比分集合 size>1);干净时返回 []。
 */
export function findCrossFileResultConflicts(entries) {
  const groups = new Map();
  for (const { storeDate, fixture: f } of Array.isArray(entries) ? entries : []) {
    const home = Number(f?.result?.home);
    const away = Number(f?.result?.away);
    if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
    const matchDay = String(f.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0]
      ?? (String(f.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "");
    const key = `${matchDay}|${String(f.homeTeam ?? "").trim()}|${String(f.awayTeam ?? "").trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      storeDate: String(storeDate ?? ""),
      score: `${home}-${away}`,
      competition: f.competition ?? f.league ?? null,
      source: f.source ?? null
    });
  }
  const conflicts = [];
  for (const [key, copies] of groups) {
    const scores = [...new Set(copies.map((c) => c.score))];
    if (scores.length > 1) conflicts.push({ key, scores, copies });
  }
  return conflicts;
}

/**
 * 第三不变量(2026-06-15):recommendation-ledger 里"已结算行"(actualStatus==="settled"
 * 或 row.actual 非空)绝不应残留 pendingReason 字段。
 * 根因:daily-recap.js 结算成功时 settled={...row} 会把上一次未开赛时写的 pendingReason
 *   原样带进 settled 行 → "已结算却显示未开赛"的自相矛盾残留(误导,虽不影响 settled 统计
 *   口径,但污染人读/复盘可信度)。源头已修(settled 显式置 pendingReason:undefined)+ 历史
 *   订正(fix-settled-pendingreason-residue.mjs);本探针守复发。
 * @param {Array<object>} rows ledger 行
 * @returns {Array<object>} 矛盾行子集(原引用)
 */
export function findSettledWithPendingResidue(rows) {
  const isSettled = (r) => r?.actualStatus === "settled" || Boolean(r?.actual);
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => isSettled(r) && typeof r.pendingReason === "string" && r.pendingReason.trim()
  );
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
