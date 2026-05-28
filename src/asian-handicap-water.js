/**
 * 亚盘水位解读器(国内博彩 know-how)
 * ──────────────────────────────────────────────────
 * 国内体彩玩家最看重的「风向标公司」:皇冠、澳门、立博、SB、Bet365.
 * 水位 = 让球盘的赔率(俗称).
 *
 * 水位语义:
 *   - 0.70-0.79: 低水(深下)— 庄家强烈引导下注让球方
 *   - 0.80-0.89: 偏低水 — 让球方有信心
 *   - 0.90-0.95: 平水/中性
 *   - 0.96-1.05: 平水/上盘略热
 *   - 1.06-1.20: 高水(浅水)— 庄家警惕,上盘可能反向
 *   - >1.20: 极高水 — 庄家明显避险
 *
 * 早盘 vs 晚盘:
 *   - 早盘(开赛前 1-2 天):庄家初判,带防御性
 *   - 晚盘(开赛前 1-2 小时):资金积累后调整,更准
 *   - 早盘 → 晚盘水位变化 = 庄家观察资金流向后的真实判断
 *
 * 水位变化方向:
 *   - 主队水位 0.85 → 0.95(升水):让球方资金少,庄家鼓励上,但上盘可能强
 *   - 主队水位 0.95 → 0.85(降水):让球方资金多,庄家警惕,可能反向跑
 *
 * 用法:
 *   const reader = analyzeAsianHandicapWater({
 *     earlyHome: 0.95, earlyAway: 0.95, line: -1,
 *     lateHome: 0.85,  lateAway: 1.05
 *   });
 *   reader.movement;   // "主队降水"
 *   reader.implication; // 中文解读
 */

export function classifyWaterLevel(water) {
  const w = Number(water);
  if (!Number.isFinite(w) || w <= 0) return { level: "invalid", description: "水位无效" };
  if (w < 0.80) return { level: "very-low", description: "深下盘 — 庄家强烈引导上让球方" };
  if (w < 0.90) return { level: "low", description: "偏低水 — 让球方有信心" };
  if (w < 0.96) return { level: "mid-low", description: "平水偏下 — 让球方略受拥护" };
  if (w <= 1.05) return { level: "neutral", description: "平水 — 中性盘口" };
  if (w <= 1.20) return { level: "mid-high", description: "偏高水 — 上盘略热,庄家小幅警惕" };
  return { level: "very-high", description: "深上盘 — 庄家明显避险,警惕上盘反向" };
}

export function analyzeAsianHandicapWater({ earlyHome = null, earlyAway = null, lateHome, lateAway, line = 0 }) {
  const result = {
    line,
    early: earlyHome != null && earlyAway != null ? { home: classifyWaterLevel(earlyHome), away: classifyWaterLevel(earlyAway), homeOdds: earlyHome, awayOdds: earlyAway } : null,
    late: { home: classifyWaterLevel(lateHome), away: classifyWaterLevel(lateAway), homeOdds: lateHome, awayOdds: lateAway },
    movement: null,
    implication: null,
    signal: null
  };

  // 没早盘数据只能解读晚盘
  if (!result.early) {
    result.implication = `晚盘:主队 ${result.late.home.description};客队 ${result.late.away.description}。让 ${line}。`;
    result.signal = inferSignalFromLateOnly(lateHome, lateAway, line);
    return result;
  }

  // 早晚水位变化
  const homeMove = Number(lateHome) - Number(earlyHome);
  const awayMove = Number(lateAway) - Number(earlyAway);
  const homeMovePct = homeMove / earlyHome;

  // 主要看让球方(让 N 是负数 = 主队让球 → 让球方=主队)
  const isHomeFavorite = line < 0;
  const favoriteWater = isHomeFavorite ? lateHome : lateAway;
  const favoriteMove = isHomeFavorite ? homeMove : awayMove;

  if (Math.abs(homeMove) < 0.02 && Math.abs(awayMove) < 0.02) {
    result.movement = "水位平稳";
    result.implication = "庄家对当前盘口满意,无明显资金倾向";
  } else if (favoriteMove > 0.05) {
    result.movement = isHomeFavorite ? "主队升水" : "客队升水";
    result.implication = `${isHomeFavorite ? "主队" : "客队"}(让球方)资金少,庄家提高水位鼓励下注,但市场可能不信让球方,**警惕反向**`;
    result.signal = isHomeFavorite ? "warn-home" : "warn-away";
  } else if (favoriteMove < -0.05) {
    result.movement = isHomeFavorite ? "主队降水" : "客队降水";
    result.implication = `${isHomeFavorite ? "主队" : "客队"}(让球方)资金过多,庄家降水避险,**让球方反而 dangerous**`;
    result.signal = isHomeFavorite ? "danger-home" : "danger-away";
  } else if (favoriteMove > 0.02) {
    result.movement = isHomeFavorite ? "主队小幅升水" : "客队小幅升水";
    result.implication = `${isHomeFavorite ? "主队" : "客队"}水位微调上,庄家轻度鼓励下注让球方`;
    result.signal = "slight-up";
  } else {
    result.movement = isHomeFavorite ? "主队小幅降水" : "客队小幅降水";
    result.implication = `${isHomeFavorite ? "主队" : "客队"}水位微调下,庄家轻度警惕`;
    result.signal = "slight-down";
  }

  return result;
}

function inferSignalFromLateOnly(home, away, line) {
  const isHomeFav = line < 0;
  const favWater = isHomeFav ? Number(home) : Number(away);
  if (favWater < 0.85) return "favorite-strongly-backed";
  if (favWater > 1.10) return "favorite-suspicious";
  return "neutral";
}

/**
 * 跨多个风向标公司聚合:皇冠、澳门、立博、Bet365.
 * 公司之间水位差异大时 → 市场分歧,信号弱.
 */
export function analyzeMultipleBookmakers(bookmakerWaters) {
  // bookmakerWaters: [{ bookmaker, lateHome, lateAway, earlyHome, earlyAway, line }]
  if (!Array.isArray(bookmakerWaters) || bookmakerWaters.length === 0) {
    return { ok: false, reason: "no-data" };
  }
  const analyses = bookmakerWaters.map((b) => ({ bookmaker: b.bookmaker, ...analyzeAsianHandicapWater(b) }));
  // 一致性:多数公司给同方向信号
  const signals = analyses.map((a) => a.signal).filter(Boolean);
  const counts = signals.reduce((m, s) => ({ ...m, [s]: (m[s] || 0) + 1 }), {});
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return {
    ok: true,
    analyses,
    consensus: dominant ? { signal: dominant[0], support: dominant[1], total: signals.length } : null,
    consistency: dominant ? round(dominant[1] / signals.length) : 0
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
