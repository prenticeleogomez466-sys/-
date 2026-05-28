/**
 * xG-Chains: 进攻链 xG 建模
 * ──────────────────────────────────────────────────
 * 传统 xG 只算射门点 xG. xG-Chains 把整条进攻链(从夺回球到射门或失球)
 * 的所有传球+射门累加,更能反映"球队制造机会的能力"(Eilers et al.).
 *
 * 模型:
 *   chainXG = Σ (passXG_i × passSuccess_i) + shotXG_end
 *
 * 简化 JS 实现(无 event-level 数据时):
 *   - 输入:近 N 场的 shotEvents + chainStats(若无,只用 shotXG)
 *   - 输出:chainXG_per_match,作为 prediction-engine xG 替代/增强
 */

const DEFAULT_PASS_XG_SCALE = 0.02;  // 每次成功传球累计 ~0.02 xG
const DEFAULT_BUILD_UP_DECAY = 0.85; // 越远射点贡献越小

/**
 * @param {Array<{xg, chainLength, completedPasses, isShot}>} events
 *   chainLength: 进攻链球数; completedPasses: 链中成功传球
 * @returns {number}
 */
export function chainXgPerMatch(events = []) {
  if (!Array.isArray(events) || !events.length) return 0;
  let total = 0;
  for (const ev of events) {
    if (!ev) continue;
    if (ev.isShot) {
      total += Number(ev.xg ?? 0);
    }
    // build-up 贡献:每次成功传球折扣累加
    const passes = Number(ev.completedPasses ?? 0);
    const buildUpContribution = passes * DEFAULT_PASS_XG_SCALE *
      Math.pow(DEFAULT_BUILD_UP_DECAY, Math.max(0, (ev.chainLength ?? passes) - passes));
    total += buildUpContribution;
  }
  return round(total);
}

/**
 * 给一个队近 N 场比赛,产平均 chainXG.
 */
export function teamChainXgAverage(matches = []) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const xgs = matches.map((m) => chainXgPerMatch(m.events));
  return {
    matches: matches.length,
    avgChainXg: round(xgs.reduce((s, x) => s + x, 0) / xgs.length),
    stdChainXg: round(stdDev(xgs)),
    chainXgs: xgs
  };
}

/**
 * 比较主客 chainXG 期望.
 */
export function compareChainXg(homeStats, awayStats) {
  if (!homeStats || !awayStats) return null;
  const diff = homeStats.avgChainXg - awayStats.avgChainXg;
  return {
    home: homeStats.avgChainXg,
    away: awayStats.avgChainXg,
    diff: round(diff),
    homeProductionEdge: diff > 0.3 ? "strong" : diff > 0.1 ? "moderate" : diff > -0.1 ? "neutral" : diff > -0.3 ? "away-edge" : "away-strong",
    note: diff > 0.3
      ? "主队进攻链生产力显著高,xG 模型应抬升主胜概率"
      : diff < -0.3
      ? "客队进攻链生产力显著高,xG 模型应抬升客胜概率"
      : "进攻链生产力接近"
  };
}

/**
 * 把 chainXG 转 lambda 调整因子.
 * 1.0 = 跟传统 xG 一致,>1 = 进攻链强(实际产出 > 传统 xG 估计).
 */
export function chainToLambdaAdjustment(traditionalXg, chainXg) {
  if (!Number.isFinite(traditionalXg) || traditionalXg <= 0) return 1;
  if (!Number.isFinite(chainXg) || chainXg <= 0) return 1;
  const ratio = chainXg / traditionalXg;
  // 截断 [0.7, 1.4] 避免极值
  return Math.max(0.7, Math.min(1.4, ratio));
}

function stdDev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
