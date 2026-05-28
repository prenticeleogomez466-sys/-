/**
 * 多源赔率 sharpener(去 vig 共识概率)
 * ──────────────────────────────────────────────────
 * 顶级 sharp 玩家"真实概率"估计的标准做法:
 *   1. 取 Pinnacle / Bet365 / 澳门系 多家盘口
 *   2. 每家算 vig(每家盘口 1/odds 之和 - 1)
 *   3. 各家分别"去 vig"得到 fair probability
 *   4. 加权平均(Pinnacle 权重最高,因为最 sharp)
 *
 * Pinnacle 是全球最"sharp"的庄家(欢迎 sharp money,vig 最低 ~2-3%),
 * 它的赔率最接近真实概率.其他盘口(Bet365 / Asian-line)有更高 vig 但
 * 提供额外信号(反映公众钱 vs sharp 钱).
 *
 * 直接命中率提升:用 sharpened probability 替代原始 odds-implied,
 * 让模型的 baseline 更准.
 */

const SHARPNESS_WEIGHTS = {
  pinnacle: 0.40,       // 最 sharp,权重最高
  asian: 0.25,          // 澳门系次之
  betfair: 0.15,        // 交易所
  bet365: 0.10,         // 公众盘
  sporttery: 0.05,      // 国内体彩(vig 最高)
  generic: 0.05         // 其他源
};

/**
 * @param {Array} quotes  [{ source, odds: { home, draw, away } }]
 * @returns {{ ok, fairProbabilities, sourceMetrics, sharpness }}
 */
export function sharpenOdds(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return { ok: false, reason: "no-quotes" };
  const valid = quotes.filter((q) => q.odds && Number.isFinite(Number(q.odds.home)) && Number.isFinite(Number(q.odds.draw)) && Number.isFinite(Number(q.odds.away)));
  if (!valid.length) return { ok: false, reason: "no-valid-quotes" };

  // 1. 每家算 fair probability(去 vig)
  const sources = valid.map((q) => {
    const inv = { home: 1/Number(q.odds.home), draw: 1/Number(q.odds.draw), away: 1/Number(q.odds.away) };
    const total = inv.home + inv.draw + inv.away;
    const vig = total - 1;
    // Multiplicative normalization(简化的去 vig 法)
    const fair = {
      home: inv.home / total,
      draw: inv.draw / total,
      away: inv.away / total
    };
    return {
      source: q.source,
      vig: round(vig),
      fairProbabilities: { home: round(fair.home), draw: round(fair.draw), away: round(fair.away) }
    };
  });

  // 2. 加权平均
  const weighted = { home: 0, draw: 0, away: 0 };
  let totalWeight = 0;
  for (const s of sources) {
    const sourceKey = (s.source || "generic").toLowerCase();
    const w = (() => {
      if (sourceKey.includes("pinnacle")) return SHARPNESS_WEIGHTS.pinnacle;
      if (sourceKey.includes("asian") || sourceKey.includes("澳门") || sourceKey.includes("皇冠") || sourceKey.includes("sb")) return SHARPNESS_WEIGHTS.asian;
      if (sourceKey.includes("betfair")) return SHARPNESS_WEIGHTS.betfair;
      if (sourceKey.includes("bet365") || sourceKey.includes("365")) return SHARPNESS_WEIGHTS.bet365;
      if (sourceKey.includes("sporttery") || sourceKey.includes("体彩") || sourceKey.includes("竞彩")) return SHARPNESS_WEIGHTS.sporttery;
      return SHARPNESS_WEIGHTS.generic;
    })();
    weighted.home += w * s.fairProbabilities.home;
    weighted.draw += w * s.fairProbabilities.draw;
    weighted.away += w * s.fairProbabilities.away;
    totalWeight += w;
  }
  if (totalWeight === 0) {
    // 等权
    const n = sources.length;
    for (const s of sources) {
      weighted.home += s.fairProbabilities.home / n;
      weighted.draw += s.fairProbabilities.draw / n;
      weighted.away += s.fairProbabilities.away / n;
    }
    totalWeight = 1;
  }

  const out = {
    home: weighted.home / totalWeight,
    draw: weighted.draw / totalWeight,
    away: weighted.away / totalWeight
  };
  // 归一化(防止舍入误差)
  const sum = out.home + out.draw + out.away;
  if (sum > 0) {
    out.home /= sum; out.draw /= sum; out.away /= sum;
  }

  // 3. sharpness 指标:多源标准差(越小越"市场共识")
  const homeProbs = sources.map((s) => s.fairProbabilities.home);
  const homeMean = homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length;
  const homeVar = homeProbs.reduce((a, b) => a + Math.pow(b - homeMean, 2), 0) / Math.max(1, homeProbs.length);
  const sharpnessStd = Math.sqrt(homeVar);

  return {
    ok: true,
    fairProbabilities: { home: round(out.home), draw: round(out.draw), away: round(out.away) },
    sourceMetrics: sources,
    sourceCount: sources.length,
    sharpnessStd: round(sharpnessStd),
    marketConsensus: sharpnessStd < 0.02 ? "强共识" : sharpnessStd < 0.05 ? "中等共识" : "市场分歧",
    averageVig: round(sources.reduce((s, x) => s + x.vig, 0) / sources.length)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
