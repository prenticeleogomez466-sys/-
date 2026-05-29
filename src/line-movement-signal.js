/**
 * Line Movement Signal(X 档 — 盘口移动 = 市场正在消化的信息)
 * ────────────────────────────────────────────────────────────
 * 待续 ① 要的"市场未消化信息"的**免授权**抓手:开盘 → 收盘(或开盘 → 当前)
 * 隐含概率的漂移。学界与博彩实务一致:
 *   - 收盘线(closing line)是公认最有效的概率估计,极难打败;
 *   - 开盘→收盘的漂移方向,捕捉的是开盘后才进场的**锐钱 / 信息**
 *     (晚到的伤停、阵容、天气、内幕),即市场"正在消化"的部分。
 * football-data.co.uk 的 CSV 已免费同时带开盘均赔(Avg列)与收盘均赔(AvgC列)、
 * Pinnacle 开/收(PS / PSC 列),所以这条信号零授权、零爬虫、数据已在手。
 *
 * ⚠️ 泄漏边界(诚实):**收盘线只在 kickoff 已知**。赛前数小时出推荐时,只能用
 * 「开盘 → 当前快照」的漂移(live jingcai 多次捕获的赔率变化),不能用收盘。
 * 收盘仅用于回测量化"这块信息饼有多大"(line-movement-backtest)。
 *
 * 接口对齐 signal-fusion-layer:导出 toLR,产 {home,draw,away} 的 likelihood ratio。
 */

const OUTCOMES = ["home", "draw", "away"];

function round(v) {
  return Math.round(v * 10000) / 10000;
}

function valid(p) {
  return p && OUTCOMES.every((o) => Number.isFinite(p[o]) && p[o] > 0);
}

/**
 * 分析开盘 → later(收盘/当前)的盘口移动。
 * @param {{home,draw,away}} opening 开盘隐含概率(去 vig)
 * @param {{home,draw,away}} later   收盘 / 当前快照隐含概率(去 vig)
 * @returns {null | {drift, totalMovement, steamOutcome, steamMagnitude, classification}}
 */
export function analyzeLineMovement(opening, later) {
  if (!valid(opening) || !valid(later)) return null;
  const drift = {};
  for (const o of OUTCOMES) drift[o] = round(later[o] - opening[o]);
  // 总移动幅度(各 outcome 绝对漂移之和的一半 ≈ 概率质量搬运量)
  const totalMovement = round(OUTCOMES.reduce((s, o) => s + Math.abs(drift[o]), 0) / 2);
  // 被锐钱推高最多的 outcome
  const steamOutcome = OUTCOMES.reduce((best, o) => (drift[o] > drift[best] ? o : best), "home");
  const steamMagnitude = round(drift[steamOutcome]);
  let classification = "flat";
  if (totalMovement >= 0.05) classification = "strong-steam";
  else if (totalMovement >= 0.02) classification = "drift";
  else if (totalMovement >= 0.008) classification = "mild";
  return { drift, totalMovement, steamOutcome, steamMagnitude, classification };
}

/**
 * 把盘口移动转成 likelihood ratio。
 * 思路:later 线更接近真值 → 朝 later 修正,但漂移有噪声,故用 sensitivity(<1)阻尼,
 * 不全盘追线。LR_o = 1 + sensitivity * (later_o/opening_o - 1),再夹 [0.5, 2.0]。
 * 漂移极小(噪声)时返回 null(休眠)。
 * @param {{home,draw,away}} opening
 * @param {{home,draw,away}} later
 * @param {{sensitivity?:number, minMovement?:number}} opts
 */
export function lineMovementToLR(opening, later, opts = {}) {
  if (!valid(opening) || !valid(later)) return null;
  const sensitivity = Number.isFinite(opts.sensitivity) ? opts.sensitivity : 0.6;
  const minMovement = Number.isFinite(opts.minMovement) ? opts.minMovement : 0.008;
  const analysis = analyzeLineMovement(opening, later);
  if (!analysis || analysis.totalMovement < minMovement) return null;
  const lr = {};
  for (const o of OUTCOMES) {
    const ratio = later[o] / opening[o];
    lr[o] = round(Math.min(2.0, Math.max(0.5, 1 + sensitivity * (ratio - 1))));
  }
  if (OUTCOMES.every((o) => lr[o] === 1)) return null;
  return lr;
}
