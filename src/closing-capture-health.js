// 收盘捕获红灯(缺陷#9 配套,2026-06-10)。
// 背景:capture-closing-live 因双重 +8h 时区 bug 上线以来 0 次真实捕获,但计划任务恒绿灯
// (无临场场次=正常退出),坏了 24 天无人察觉。本模块给捕获链装"连续 24h 零捕获"红灯:
//   - 每轮把"出现过应捕获场次 / 实际冻结过收盘"写进状态文件(D:\football-model-data\closing-capture-state.json);
//   - 超 24h 没有任何真实捕获、且期间确有应捕获场次 → 红灯(exit≠0),计划任务面板立刻可见。
// 纯函数(状态进/状态出),I/O 由 capture 脚本做,便于固定时间断言单测。

export const CAPTURE_STATE_FILENAME = "closing-capture-state.json";
export const DEFAULT_MAX_GAP_MS = 24 * 3600 * 1000;

/**
 * 滚动更新捕获状态。
 * @param {object|null} prev 旧状态(无/损坏 → 当新建)
 * @param {{eligibleCount?:number, frozenCount?:number, nowMs?:number}} run 本轮结果
 */
export function nextCaptureState(prev, { eligibleCount = 0, frozenCount = 0, nowMs = Date.now() } = {}) {
  const state = prev && typeof prev === "object" ? { ...prev } : {};
  const iso = new Date(nowMs).toISOString();
  if (!state.startedAt || !Number.isFinite(Date.parse(state.startedAt))) state.startedAt = iso;
  if (eligibleCount > 0) state.lastEligibleAt = iso;
  if (frozenCount > 0) state.lastCaptureAt = iso;
  state.updatedAt = iso;
  return state;
}

/**
 * 红灯判定:距上次真实捕获(无捕获史则距状态建立)超过 maxGapMs,且期间出现过应捕获场次 → red。
 * 红灯持续到下一次真实捕获为止(报警不自愈,逼人修)。
 * @returns {{red:boolean, reason:string}}
 */
export function assessCaptureHealth(state, nowMs = Date.now(), maxGapMs = DEFAULT_MAX_GAP_MS) {
  const t = (v) => { const ms = Date.parse(v ?? ""); return Number.isFinite(ms) ? ms : null; };
  const lastCapture = t(state?.lastCaptureAt);
  const lastEligible = t(state?.lastEligibleAt);
  const baseline = lastCapture ?? t(state?.startedAt);
  if (baseline === null) return { red: false, reason: "状态新建,尚无基线" };
  if (lastEligible === null) return { red: false, reason: "尚无应捕获场次记录" };
  const gapMs = nowMs - baseline;
  if (gapMs <= maxGapMs) return { red: false, reason: "未超时窗" };
  if (lastEligible <= baseline) return { red: false, reason: "超时窗但期间无应捕获场次(如世界杯休赛日)" };
  return {
    red: true,
    reason: `连续 ${(gapMs / 3600000).toFixed(1)}h 零真实捕获,期间有应捕获场次(最近应捕获 ${state.lastEligibleAt},最近捕获 ${state.lastCaptureAt ?? "从未"})`
  };
}
