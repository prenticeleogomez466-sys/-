/**
 * Tactical Formation Matchup
 * ──────────────────────────────────────────────────
 * 阵型对位历史胜率.从 fotmob 提取 formation 字符串(如 "4-3-3"),
 * 算每个 (home_formation, away_formation) 配对的历史 outcome 分布.
 *
 * 经验(从大量职业比赛数据):
 *   - 4-3-3 vs 4-4-2:4-3-3 主胜率略高(+2-3%)
 *   - 5-3-2 vs 4-3-3:5-3-2 防守优势,降低进球
 *   - 3-5-2 vs 4-3-3:三中卫体系易被边路打穿,客胜略高
 */

/**
 * 从历史比赛数据拟合 formation matchup 矩阵.
 *
 * @param {Array} history [{ homeFormation, awayFormation, won: "home"|"draw"|"away" }]
 */
export function fitFormationMatchups(history) {
  if (!Array.isArray(history) || !history.length) return {};
  const matrix = new Map();  // key = "home::away" → { home, draw, away, total }
  for (const m of history) {
    const hf = canonicalFormation(m.homeFormation);
    const af = canonicalFormation(m.awayFormation);
    if (!hf || !af) continue;
    const key = `${hf}::${af}`;
    if (!matrix.has(key)) matrix.set(key, { home: 0, draw: 0, away: 0, total: 0 });
    const cell = matrix.get(key);
    cell.total++;
    if (m.won === "home") cell.home++;
    else if (m.won === "away") cell.away++;
    else cell.draw++;
  }
  // Convert to rates(at least 10 samples 才输出)
  const out = {};
  for (const [key, cell] of matrix.entries()) {
    if (cell.total < 10) continue;
    out[key] = {
      key,
      total: cell.total,
      homeWinRate: round(cell.home / cell.total),
      drawRate: round(cell.draw / cell.total),
      awayWinRate: round(cell.away / cell.total)
    };
  }
  return out;
}

/**
 * 阵型字符串规范化.
 */
export function canonicalFormation(f) {
  if (!f) return null;
  let s = String(f).trim().replace(/[—–]/g, "-").replace(/\s+/g, "");
  // "433" or "4-3-3" or "4 3 3"(空格已去)→ 都规范成 "4-3-3"
  if (/^[1-9]+$/.test(s) && s.length >= 3 && s.length <= 5) {
    s = s.split("").join("-");
  }
  const m = s.match(/^[1-9](-[1-9])+$/);
  return m ? s : null;
}

/**
 * 给一对阵型,返回相对 league 平均的 lift(>1 = 主队优势,<1 = 客队优势).
 */
export function getFormationLift(homeFormation, awayFormation, matchups, leagueBaseline) {
  const hf = canonicalFormation(homeFormation);
  const af = canonicalFormation(awayFormation);
  if (!hf || !af) return null;
  const key = `${hf}::${af}`;
  const cell = matchups[key];
  if (!cell) return { found: false };
  const baseline = leagueBaseline ?? { homeWinRate: 0.45, drawRate: 0.27, awayWinRate: 0.28 };
  return {
    found: true,
    formation: { home: hf, away: af },
    samples: cell.total,
    homeWinRate: cell.homeWinRate,
    leagueHomeWinRate: baseline.homeWinRate,
    homeLift: round(cell.homeWinRate / baseline.homeWinRate),
    interpretation: cell.homeWinRate > baseline.homeWinRate + 0.05 ? "本阵型对位利主队"
                  : cell.homeWinRate < baseline.homeWinRate - 0.05 ? "本阵型对位利客队"
                  : "本阵型对位中性"
  };
}

/**
 * 应用 formation lift 到概率.
 */
export function applyFormationLift(probabilities, lift) {
  if (!lift || !lift.found) return probabilities;
  const factor = lift.homeLift ?? 1;
  if (Math.abs(factor - 1) < 0.03) return probabilities;
  const adjusted = {
    home: probabilities.home * factor,
    draw: probabilities.draw,
    away: probabilities.away * (2 - factor)
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
