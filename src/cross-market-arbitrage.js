/**
 * 跨盘口 Arbitrage Scanner
 * ──────────────────────────────────────────────────
 * 给多个市场(sporttery / 500 / 网易 / Bet365 mock)同一比赛的赔率,
 * 自动探测:
 *   1. Arbitrage(无风险套利):sum(1/best_odds) < 1
 *   2. Middle bet:让球盘 line 不同时,中间某结果两边都赢
 *   3. Value bet 跨盘对比:某盘明显高于均值
 *
 * 实战意义:国内体彩 + 国际盘口 + Bet365/SB 之间确实存在 vig 差异和延迟,
 * 偶尔出现 5-15 分钟窗口的 arbitrage 机会.
 */

/**
 * @param {Array} marketQuotes [{ bookmaker, fixtureId, market: "1x2"|"asian-1"|..., odds: {home, draw, away} }]
 * @returns {Object} { arbitrage, valueOpportunities, middleBets, bestOddsPerOutcome }
 */
export function scanArbitrage(marketQuotes, opts = {}) {
  if (!Array.isArray(marketQuotes) || !marketQuotes.length) {
    return { ok: false, reason: "no-quotes" };
  }
  const minProfit = opts.minProfit ?? 0.005;  // 0.5% 最小套利收益

  // 按 fixture+market 分组
  const byFixture = new Map();
  for (const q of marketQuotes) {
    const key = `${q.fixtureId}__${q.market ?? "1x2"}`;
    if (!byFixture.has(key)) byFixture.set(key, []);
    byFixture.get(key).push(q);
  }

  const arbitrageOpportunities = [];
  const valueBets = [];
  const bestOddsPerFixture = {};

  for (const [key, quotes] of byFixture.entries()) {
    // 找每个 outcome 的最高赔率
    const bestOdds = {};
    for (const q of quotes) {
      for (const [outcome, odds] of Object.entries(q.odds ?? {})) {
        const o = Number(odds);
        if (!Number.isFinite(o) || o <= 1) continue;
        if (!bestOdds[outcome] || o > bestOdds[outcome].odds) {
          bestOdds[outcome] = { odds: o, bookmaker: q.bookmaker };
        }
      }
    }
    bestOddsPerFixture[key] = bestOdds;

    // Arbitrage: sum(1/best_odds) < 1
    const impliedSum = Object.values(bestOdds).reduce((s, x) => s + 1 / x.odds, 0);
    if (impliedSum < 1 - minProfit) {
      const profit = 1 - impliedSum;
      // 计算每个 outcome 的下注比例,使无论哪个中都赚一样
      const stakes = {};
      for (const [outcome, info] of Object.entries(bestOdds)) {
        stakes[outcome] = round((1 / info.odds) / impliedSum);
      }
      arbitrageOpportunities.push({
        key,
        impliedSum: round(impliedSum),
        profitMargin: round(profit),
        bestOdds,
        stakes,
        narrative: `🟢 Arbitrage 机会: ${(profit * 100).toFixed(2)}% 无风险收益 (sum(1/odds)=${(impliedSum*100).toFixed(2)}%)`
      });
    }

    // Value bet:某盘的某 outcome 赔率明显高于均值 (>10% 高出)
    const meanOdds = {};
    for (const outcome of Object.keys(bestOdds)) {
      const oddsArray = quotes.map((q) => Number(q.odds?.[outcome])).filter(Number.isFinite);
      if (oddsArray.length >= 2) {
        meanOdds[outcome] = oddsArray.reduce((s, o) => s + o, 0) / oddsArray.length;
      }
    }
    for (const q of quotes) {
      for (const [outcome, odds] of Object.entries(q.odds ?? {})) {
        const o = Number(odds);
        const mean = meanOdds[outcome];
        if (!Number.isFinite(o) || !Number.isFinite(mean)) continue;
        const upside = (o - mean) / mean;
        if (upside > 0.10) {
          valueBets.push({
            key,
            bookmaker: q.bookmaker,
            outcome,
            odds: o,
            meanOdds: round(mean),
            upsidePct: round(upside),
            narrative: `${q.bookmaker} 的 ${outcome} 赔率 ${o} 比市场均值 ${mean.toFixed(2)} 高 ${(upside*100).toFixed(1)}% — value bet`
          });
        }
      }
    }
  }

  return {
    ok: true,
    quotes: marketQuotes.length,
    fixtures: byFixture.size,
    arbitrageOpportunities,
    valueBets: valueBets.sort((a, b) => b.upsidePct - a.upsidePct).slice(0, 20),
    bestOddsPerFixture,
    summary: {
      arbCount: arbitrageOpportunities.length,
      valueBetCount: valueBets.length,
      hasOpportunity: arbitrageOpportunities.length > 0 || valueBets.length > 0
    }
  };
}

/**
 * Middle bet 检测:让球盘 line 不同时,中间结果两边都赢.
 * 示例:盘口 A 让 -0.5(主胜),盘口 B 让 +0.5(主队反让 0.5);
 *      中间 0-0 平局时,两边都赢(在 A 上主胜没赢但 -0.5 输,B 上主队 +0.5 赢)
 * 这是 advanced 操作,实战机会少但存在.
 */
export function findMiddleBets(quotes1, quotes2) {
  // quotes1: { fixtureId, line: -0.5, odds: { home, away } }
  // quotes2: { fixtureId, line: +0.5, odds: { home, away } }
  if (quotes1.fixtureId !== quotes2.fixtureId) return null;
  if (Math.abs(quotes1.line) + Math.abs(quotes2.line) < 0.5) return null;
  // 简化:lin1 < lin2,中间分差区间存在 middle
  const middleRange = [Math.min(quotes1.line, quotes2.line), Math.max(quotes1.line, quotes2.line)];
  return {
    middleRange,
    fixtureId: quotes1.fixtureId,
    note: `当主队净进球差在 ${middleRange[0]}~${middleRange[1]} 之间,两边盘口都赢`,
    odds: { side1: quotes1.odds, side2: quotes2.odds }
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
