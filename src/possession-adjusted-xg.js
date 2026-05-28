/**
 * Possession-Adjusted xG (PADJ-xG)
 * ──────────────────────────────────────────────────
 * 防守反击型球队控球少但 xG 高效;控球型反过来.
 * 直接比较 xG 不公平 — 控球率不同样本不可比.
 *
 * 模型(StatsBomb / Opta 业内做法):
 *   PADJ-xG = xG_for × (50 / actualPossession)  // 标准化到 50%
 *   PADJ-xG-against = xG_against × (actualPossession / 50)
 *
 * 解读:
 *   - PADJ-xG 高 = 即使控球少也能制造机会(进攻效率)
 *   - PADJ-xG-against 高 = 即使控球多对手仍能威胁(防守漏洞)
 */

const TARGET_POSSESSION = 50;  // 标准化基准
const SAFE_FLOOR = 25;          // 控球率太低不调整(避免极端值)
const SAFE_CEIL = 75;

/**
 * @param {Object} match { xgFor, xgAgainst, possession (0-100) }
 */
export function adjustMatchPossession(match) {
  if (!match) return null;
  const poss = Number(match.possession);
  if (!Number.isFinite(poss)) {
    return {
      ...match,
      padjXgFor: Number(match.xgFor ?? 0),
      padjXgAgainst: Number(match.xgAgainst ?? 0),
      note: "no-possession-data"
    };
  }
  // 截断到安全范围
  const safePoss = Math.max(SAFE_FLOOR, Math.min(SAFE_CEIL, poss));
  const xgFor = Number(match.xgFor ?? 0);
  const xgAgainst = Number(match.xgAgainst ?? 0);

  const padjFor = xgFor * (TARGET_POSSESSION / safePoss);
  const padjAgainst = xgAgainst * (safePoss / TARGET_POSSESSION);

  return {
    rawXgFor: xgFor,
    rawXgAgainst: xgAgainst,
    possession: poss,
    padjXgFor: round(padjFor),
    padjXgAgainst: round(padjAgainst),
    style: classifyStyle(poss, padjFor, xgFor)
  };
}

function classifyStyle(poss, padjFor, rawFor) {
  if (poss < 40 && padjFor > rawFor * 1.2) return "counter-attack";
  if (poss > 60 && padjFor < rawFor * 0.9) return "possession-dominant";
  if (poss > 55 && padjFor > rawFor) return "possession-effective";
  if (poss < 45 && padjFor > 1.5) return "low-block-efficient";
  return "balanced";
}

/**
 * 近 N 场 PADJ-xG 平均.
 */
export function teamPossessionAdjustedAverage(matches = []) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const adjusted = matches.map(adjustMatchPossession).filter(Boolean);
  return {
    sampleSize: matches.length,
    avgRawXgFor: round(mean(adjusted.map((a) => a.rawXgFor))),
    avgRawXgAgainst: round(mean(adjusted.map((a) => a.rawXgAgainst))),
    avgPadjXgFor: round(mean(adjusted.map((a) => a.padjXgFor))),
    avgPadjXgAgainst: round(mean(adjusted.map((a) => a.padjXgAgainst))),
    avgPossession: round(mean(adjusted.map((a) => Number(a.possession ?? 50)))),
    dominantStyle: modeStyle(adjusted.map((a) => a.style))
  };
}

function modeStyle(styles) {
  const counts = {};
  for (const s of styles) counts[s] = (counts[s] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "balanced";
}

/**
 * 两队风格 matchup:进攻效率 vs 防守效率.
 */
export function comparePossessionStyles(homeAvg, awayAvg) {
  if (!homeAvg || !awayAvg) return null;
  const homeNetPadj = homeAvg.avgPadjXgFor - awayAvg.avgPadjXgAgainst;
  const awayNetPadj = awayAvg.avgPadjXgFor - homeAvg.avgPadjXgAgainst;
  const projectedHomeXg = round(homeAvg.avgPadjXgFor * 0.5 + awayAvg.avgPadjXgAgainst * 0.5);
  const projectedAwayXg = round(awayAvg.avgPadjXgFor * 0.5 + homeAvg.avgPadjXgAgainst * 0.5);
  return {
    homeStyle: homeAvg.dominantStyle,
    awayStyle: awayAvg.dominantStyle,
    homeNetEdge: round(homeNetPadj),
    awayNetEdge: round(awayNetPadj),
    projectedHomeXg,
    projectedAwayXg,
    matchup: matchupClassify(homeAvg.dominantStyle, awayAvg.dominantStyle)
  };
}

function matchupClassify(home, away) {
  if (home === "possession-dominant" && away === "counter-attack") return "经典控球 vs 反击 — 反击型客队可能 0-1/1-2 偷分";
  if (home === "counter-attack" && away === "possession-dominant") return "主队反击 + 客队控球 — 主队耐心等机会";
  if (home === "possession-effective" && away === "possession-effective") return "控球+效率双强,可能高比分大战";
  if (home === "low-block-efficient" && away === "low-block-efficient") return "双低 block — 大概率小比分平局";
  return "中性风格 matchup";
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
