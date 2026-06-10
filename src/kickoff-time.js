// 开赛时刻解析(2026-06-10 结算去毒,缺陷#1#2 共用)。
//
// 背景:fixture.kickoff 在不同来源下有三种形态——
//   ① "HH:mm"(当日时刻,日期取 fixture.date)
//   ② "YYYY-MM-DD"(只有日期,常见于世界杯赛程:业务日 06-07 的场实际 06-12 开赛)
//   ③ "YYYY-MM-DD HH:mm"(完整时刻)
// 旧 isKickoffFuture 只解析 "HH:mm" 并一律用 fixture.date 拼日期 → 形态②的未来场被当成
// "已过期可结算",叠加 backfill 单边锚定错配,造成 42 条未开赛世界杯场被热身赛假赛果结算。
//
// 铁律:不兜底——kickoff 无法解析出可信时刻时返回 null,调用方必须拒绝结算(宁 pending 勿假)。

/**
 * 解析 fixture 的开赛时刻(epoch ms,北京时间口径)。
 * - kickoff 内嵌日期(YYYY-MM-DD)优先于 fixture.date(世界杯赛程 kickoff 才是真比赛日);
 * - 只有日期没有时刻时取该日 23:59:59+08:00 —— 宁可晚判"已开赛"几小时,绝不提前放行结算;
 * - kickoff 为空/完全不可解析 → null(调用方 fail-loud,不得结算)。
 * @returns {number|null}
 */
export function kickoffEpochMs(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  if (!kickoff) return null; // kickoff 不存在 → 不可判定,绝不允许结算
  const embeddedDate = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const date = embeddedDate ?? (String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null);
  if (!date) return null;
  const time = kickoff.match(/(\d{1,2}):(\d{2})/);
  const iso = time
    ? `${date}T${time[1].padStart(2, "0")}:${time[2]}:00+08:00`
    : `${date}T23:59:59+08:00`;
  const epoch = new Date(iso).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

/**
 * 该场是否已开赛。kickoff 缺失/不可解析 → false(绝不结算未知时刻的场)。
 */
export function hasKickedOff(fixture, now = Date.now()) {
  const epoch = kickoffEpochMs(fixture);
  return epoch !== null && epoch <= now;
}

/**
 * 该场的"真实比赛日"(YYYY-MM-DD):kickoff 内嵌日期优先,否则 fixture.date。
 * 供跨源对阵匹配做 ±N 天日期约束(同名对阵的世界杯小组赛 vs 热身赛不得视为同一场)。
 * @returns {string|null}
 */
export function fixtureMatchDate(fixture) {
  const kickoff = String(fixture?.kickoff ?? "").trim();
  const embedded = kickoff.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (embedded) return embedded;
  return String(fixture?.date ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

/**
 * 两个 fixture 的真实比赛日相差是否 ≤ maxDays 天。
 * 任一方解析不出日期时返回 true(不引入新的误杀,只在双方都有日期时收紧)。
 */
export function withinDays(left, right, maxDays = 2) {
  const ld = fixtureMatchDate(left);
  const rd = fixtureMatchDate(right);
  if (!ld || !rd) return true;
  const lt = Date.parse(`${ld}T00:00:00Z`);
  const rt = Date.parse(`${rd}T00:00:00Z`);
  if (!Number.isFinite(lt) || !Number.isFinite(rt)) return true;
  return Math.abs(lt - rt) <= maxDays * 86400000;
}
