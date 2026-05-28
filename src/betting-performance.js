/**
 * 投注绩效评估(Sharpe / Sortino / Risk Parity)
 * ──────────────────────────────────────────────────
 * 从 ledger 算金融行业级别的绩效指标,衡量投注是否"稳定盈利":
 *
 *   - Sharpe ratio: (mean_return - risk_free) / std(return)
 *     越高越好,>1 算优秀,>2 算顶级
 *
 *   - Sortino ratio: 像 Sharpe,但只看下行波动 std(returns < 0)
 *     体育投注更适合 Sortino(我们关心损失波动,不关心盈利波动)
 *
 *   - Calmar ratio: 年化回报 / 最大回撤
 *     >1 算好(年化等于最大单次回撤)
 *
 *   - Risk Parity: 多个独立组合(竞彩/大乐透/排三/排五),每个分配等风险仓位
 *     避免"重押一个就翻车"
 */

const RISK_FREE_DAILY = 0.0001;  // 接近 0 的无风险回报基线

/**
 * 从 ledger 行序列算单期回报序列.
 * @param {Array} rows  ledger rows,每行需 hit + stake + odds
 * @returns {Array}  returns array(每注回报率)
 */
export function computeReturnsFromLedger(rows) {
  return (rows ?? []).filter((r) => typeof r.hit === "boolean").map((r) => {
    const stake = Number(r.stakeUnitsPer100 ?? 1);
    const odds = Number(r.primaryOdds ?? 2.0);
    if (r.hit === true) return (stake * (odds - 1)) / stake;  // 净盈 / 仓位
    return -1;  // 输全部仓位
  });
}

/**
 * Sharpe ratio.
 */
export function sharpeRatio(returns, opts = {}) {
  const rf = opts.riskFree ?? RISK_FREE_DAILY;
  if (!Array.isArray(returns) || returns.length < 5) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / Math.max(1, returns.length - 1);
  const std = Math.sqrt(variance);
  if (std < 1e-9) return null;
  // 年化(假设每天 1 注,250 个交易日)
  const annualizedSharpe = (mean - rf) / std * Math.sqrt(250);
  return round(annualizedSharpe);
}

/**
 * Sortino ratio:只看负回报的波动.
 */
export function sortinoRatio(returns, opts = {}) {
  const rf = opts.riskFree ?? RISK_FREE_DAILY;
  if (!Array.isArray(returns) || returns.length < 5) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const downside = returns.filter((r) => r < rf);
  if (!downside.length) return Infinity;  // 没有亏损 → 完美
  const downsideVar = downside.reduce((s, r) => s + Math.pow(r - rf, 2), 0) / downside.length;
  const downsideStd = Math.sqrt(downsideVar);
  if (downsideStd < 1e-9) return null;
  return round((mean - rf) / downsideStd * Math.sqrt(250));
}

/**
 * Calmar ratio: 年化回报 / 最大回撤.
 */
export function calmarRatio(returns, opts = {}) {
  if (!Array.isArray(returns) || returns.length < 5) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const annualized = mean * 250;
  // 计算 equity curve 最大回撤
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returns) {
    equity *= (1 + r * 0.01);  // 假设每注 1% 仓位
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  if (maxDD < 1e-9) return null;
  return round(annualized / maxDD);
}

/**
 * 综合绩效报告
 */
export function performanceReport(rows) {
  const returns = computeReturnsFromLedger(rows);
  if (returns.length < 5) {
    return { ok: false, reason: `insufficient-returns:${returns.length}`, samples: returns.length };
  }
  const wins = returns.filter((r) => r > 0).length;
  const losses = returns.filter((r) => r < 0).length;
  const winRate = wins / returns.length;
  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const cumReturn = returns.reduce((s, r) => s + r, 0);
  return {
    ok: true,
    samples: returns.length,
    winRate: round(winRate),
    meanReturn: round(meanReturn),
    cumulativeReturn: round(cumReturn),
    sharpe: sharpeRatio(returns),
    sortino: sortinoRatio(returns),
    calmar: calmarRatio(returns),
    bestReturn: round(Math.max(...returns)),
    worstReturn: round(Math.min(...returns)),
    rating: rateRiskAdjustedPerformance(sharpeRatio(returns))
  };
}

function rateRiskAdjustedPerformance(sharpe) {
  if (sharpe == null) return "insufficient-data";
  if (sharpe > 2.0) return "🏆 顶级(Sharpe >2)";
  if (sharpe > 1.0) return "🟢 优秀(Sharpe >1)";
  if (sharpe > 0.5) return "🟠 中等";
  if (sharpe > 0) return "🟡 微正(可改进)";
  return "🔴 负 Sharpe,需重审策略";
}

/**
 * Risk Parity:多组合等风险分配.
 * @param {Array} portfolios [{ id, expectedVolatility, expectedReturn }]
 * @returns {Object} 每个组合的目标仓位比例
 */
export function riskParityAllocation(portfolios) {
  const valid = portfolios.filter((p) => Number.isFinite(p.expectedVolatility) && p.expectedVolatility > 0);
  if (!valid.length) return { ok: false, reason: "no-valid-portfolios" };
  // 等风险贡献:weight_i ∝ 1 / volatility_i
  const inverseVols = valid.map((p) => 1 / p.expectedVolatility);
  const total = inverseVols.reduce((s, v) => s + v, 0);
  const allocations = valid.map((p, i) => ({
    id: p.id,
    weight: round(inverseVols[i] / total),
    expectedReturn: p.expectedReturn,
    expectedVolatility: p.expectedVolatility,
    riskContribution: round(1 / valid.length)  // 等风险:每个贡献 1/N
  }));
  return { ok: true, allocations };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
