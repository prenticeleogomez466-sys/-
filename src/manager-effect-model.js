/**
 * Manager Effect 教练加成模型
 * ──────────────────────────────────────────────────
 * 两类效应:
 *   1. 新教练反弹:上任后前 5-10 场 form 提升(球员"想表现"心理 + 战术新鲜)
 *      经验:平均 +5% form lift,持续 5-8 场后衰减
 *   2. 教练个人战绩:历史 win rate 高的教练 → 战术质量信号
 *
 * 用途:
 *   - 球队换帅后前几周特别加成
 *   - 顶级教练(瓜帅 / 安帅 / 克洛普)长期保留 +2-3% lift
 */

const HONEYMOON_BOOST_SCHEDULE = [
  { matches: 3, boost: 0.07 },  // 上任前 3 场
  { matches: 6, boost: 0.05 },
  { matches: 10, boost: 0.03 },
  { matches: 15, boost: 0.01 },
  { matches: Infinity, boost: 0 }
];

/**
 * 从教练履历算个人 win rate profile.
 *
 * @param {Array} history [{ managerId, managerName, won: "home"|"draw"|"away", isHome }]
 */
export function fitManagerProfiles(history) {
  const profiles = new Map();
  for (const m of history) {
    const id = m.managerId ?? m.managerName;
    if (!id) continue;
    if (!profiles.has(id)) profiles.set(id, { id, name: m.managerName, matches: 0, wins: 0, draws: 0, losses: 0 });
    const p = profiles.get(id);
    p.matches++;
    const wonForThisManager = (m.isHome && m.won === "home") || (!m.isHome && m.won === "away");
    const drewForThisManager = m.won === "draw";
    if (wonForThisManager) p.wins++;
    else if (drewForThisManager) p.draws++;
    else p.losses++;
  }
  const out = {};
  for (const [id, p] of profiles.entries()) {
    if (p.matches < 20) continue;  // 至少 20 场样本
    out[id] = {
      id, name: p.name,
      matches: p.matches,
      winRate: round(p.wins / p.matches),
      drawRate: round(p.draws / p.matches),
      lossRate: round(p.losses / p.matches),
      pointsPerMatch: round((p.wins * 3 + p.draws) / p.matches),
      tier: tierFromWinRate(p.wins / p.matches)
    };
  }
  return out;
}

function tierFromWinRate(rate) {
  if (rate >= 0.60) return "elite";        // 60%+(顶级,瓜帅/克洛普级)
  if (rate >= 0.50) return "top";
  if (rate >= 0.40) return "above-average";
  if (rate >= 0.30) return "average";
  return "below-average";
}

/**
 * 新教练 honeymoon boost:上任 N 场后的 boost 系数.
 */
export function honeymoonBoost(matchesIntoTenure) {
  const n = Number(matchesIntoTenure);
  if (!Number.isFinite(n) || n < 0) return 0;
  for (const tier of HONEYMOON_BOOST_SCHEDULE) {
    if (n <= tier.matches) return tier.boost;
  }
  return 0;
}

/**
 * 综合教练影响:profile lift + honeymoon boost.
 */
export function computeManagerInfluence(profile, matchesIntoTenure = null) {
  if (!profile) return { lift: 0, breakdown: { profile: 0, honeymoon: 0 } };
  const profileLift = profile.tier === "elite" ? 0.03
                    : profile.tier === "top" ? 0.02
                    : profile.tier === "above-average" ? 0.01
                    : profile.tier === "below-average" ? -0.02
                    : 0;
  const honeymoon = honeymoonBoost(matchesIntoTenure ?? Infinity);
  return {
    lift: round(profileLift + honeymoon),
    breakdown: { profile: profileLift, honeymoon: round(honeymoon) },
    tier: profile.tier,
    matchesIntoTenure
  };
}

/**
 * 应用教练影响到 prediction 概率(主队 manager profile vs 客队 manager profile).
 */
export function applyManagerInfluence(probabilities, homeMgr, awayMgr) {
  const homeLift = homeMgr ? homeMgr.lift : 0;
  const awayLift = awayMgr ? awayMgr.lift : 0;
  const netHomeLift = homeLift - awayLift;
  if (Math.abs(netHomeLift) < 0.01) return probabilities;
  const adjusted = {
    home: probabilities.home * (1 + netHomeLift),
    draw: probabilities.draw,
    away: probabilities.away * (1 - netHomeLift)
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum)
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
