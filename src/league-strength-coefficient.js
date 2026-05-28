/**
 * League Strength Coefficient
 * ──────────────────────────────────────────────────
 * 不同联赛绝对强度差异巨大. 跨联赛比较 / 欧战 / 国家队球员评估时必要.
 *
 * 系数(基于 UEFA / Elo / 综合):
 *   - 英超 / 西甲 / 德甲 = 1.00 (顶级基准)
 *   - 意甲 / 法甲 = 0.95
 *   - 葡超 / 荷甲 = 0.85
 *   - 比甲 / 苏超 / 土超 = 0.75
 *   - 俄超 / 乌超 / 中甲 = 0.70
 *   - 中超 / 沙特联 / J联赛 = 0.65
 *   - 美职联 / 巴西甲 / 阿甲 = 0.70
 *   - 韩 K1 / 澳超 = 0.60
 *   - 中乙 / 越南联赛 / 印度联赛 = 0.50
 *   - 友谊赛 = 0.40
 */

const LEAGUE_COEFFICIENTS = new Map([
  // Tier 1 (top 5 + similar)
  ["英超", 1.00], ["Premier League", 1.00], ["EPL", 1.00],
  ["西甲", 1.00], ["La Liga", 1.00],
  ["德甲", 0.98], ["Bundesliga", 0.98],
  ["意甲", 0.95], ["Serie A", 0.95],
  ["法甲", 0.92], ["Ligue 1", 0.92],
  // Tier 2
  ["葡超", 0.85], ["Primeira Liga", 0.85],
  ["荷甲", 0.85], ["Eredivisie", 0.85],
  ["比甲", 0.75], ["Jupiler Pro League", 0.75],
  ["苏超", 0.72], ["Scottish Premiership", 0.72],
  ["土超", 0.75], ["Süper Lig", 0.75],
  ["希超", 0.70], ["Super League Greece", 0.70],
  // Eastern Europe
  ["俄超", 0.70], ["Russian Premier League", 0.70],
  ["乌超", 0.65], ["Ukrainian Premier League", 0.65],
  ["波超", 0.62], ["Ekstraklasa", 0.62],
  ["捷超", 0.62],
  // Asia
  ["中超", 0.62], ["Chinese Super League", 0.62], ["CSL", 0.62],
  ["中甲", 0.50], ["China League One", 0.50],
  ["中乙", 0.42],
  ["日 J1", 0.65], ["J1 League", 0.65],
  ["日 J2", 0.50],
  ["韩 K1", 0.62], ["K League 1", 0.62],
  ["沙特联", 0.65], ["Saudi Pro League", 0.65],
  ["澳超", 0.58], ["A-League", 0.58],
  ["印度联赛", 0.45], ["ISL", 0.45],
  ["越南联赛", 0.45], ["V.League 1", 0.45],
  // Americas
  ["美职联", 0.70], ["MLS", 0.70],
  ["巴西甲", 0.72], ["Brasileirão", 0.72], ["Serie A Brazil", 0.72],
  ["阿甲", 0.70], ["Liga Profesional", 0.70],
  ["智利甲", 0.62],
  ["墨西哥联赛", 0.65], ["Liga MX", 0.65],
  // International / lower
  ["世预赛", 0.85], ["WC Qualifiers", 0.85],
  ["欧国联", 0.92], ["Nations League", 0.92],
  ["欧冠", 1.05], ["Champions League", 1.05],
  ["欧联", 0.92], ["Europa League", 0.92],
  ["欧会杯", 0.78], ["Conference League", 0.78],
  ["友谊赛", 0.40], ["Friendly", 0.40]
]);

/**
 * 查询联赛系数.
 */
export function leagueCoefficient(leagueName) {
  if (!leagueName) return 0.60;
  const direct = LEAGUE_COEFFICIENTS.get(leagueName);
  if (direct != null) return direct;
  // 模糊匹配
  for (const [key, value] of LEAGUE_COEFFICIENTS.entries()) {
    if (leagueName.includes(key) || key.includes(leagueName)) return value;
  }
  return 0.60;  // 未知联赛默认中游
}

/**
 * 调整一个 Elo 评分到"通用 Elo"(可跨联赛比较).
 */
export function normalizeElo(eloInLeague, leagueName, opts = {}) {
  const c = leagueCoefficient(leagueName);
  const baseElo = opts.baseElo ?? 1500;
  // (Elo - 1500) × coefficient + 1500
  return round((eloInLeague - baseElo) * c + baseElo);
}

/**
 * 跨联赛对比:不同联赛的两队真实强度.
 */
export function compareCrossLeague(team1Elo, team1League, team2Elo, team2League) {
  const norm1 = normalizeElo(team1Elo, team1League);
  const norm2 = normalizeElo(team2Elo, team2League);
  return {
    team1: { rawElo: team1Elo, league: team1League, normalizedElo: norm1, coefficient: leagueCoefficient(team1League) },
    team2: { rawElo: team2Elo, league: team2League, normalizedElo: norm2, coefficient: leagueCoefficient(team2League) },
    delta: round(norm1 - norm2),
    note: Math.abs(norm1 - norm2) < 50
      ? "标准化后真实强度接近"
      : norm1 > norm2
      ? `team1 标准化 Elo 领先 ${Math.abs(norm1 - norm2)} 点(联赛差异已校正)`
      : `team2 标准化 Elo 领先 ${Math.abs(norm1 - norm2)} 点(联赛差异已校正)`
  };
}

/**
 * 在欧战 / 国际比赛上,把联赛 form 调整成"国际 form".
 */
export function intlAdjustedFormScore(domesticPpg, leagueName) {
  const c = leagueCoefficient(leagueName);
  return round(domesticPpg * c);
}

function round(v) {
  return Math.round(v * 100) / 100;
}
