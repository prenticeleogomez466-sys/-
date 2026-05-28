/**
 * Rotation Policy Model
 * ──────────────────────────────────────────────────
 * 强队遇到弱对手 / 不重要赛事 / 密集赛程时会轮换主力.
 * 战力发挥下降 → 胜率下降 / upset 概率上升.
 *
 * 触发条件(基于经验):
 *   - 杯赛 + 对手 Elo 低于自己 200+ → 高概率轮换
 *   - 联赛已锁定排名(冠军 / 降级) → 末轮可能轮换
 *   - 中间夹欧战 + 联赛中游对手 → 杯赛优先
 *   - 国脚伤病高峰期 → 被迫轮换
 */

/**
 * @param {Object} context
 *   competition: "联赛" | "杯赛-..." | etc.
 *   selfElo, opponentElo
 *   nextImportantMatchInDays: 下一场重要比赛距今天数
 *   leagueRankSecured: 排名是否已锁定(冠军/降级/欧战席位)
 *   isCupKnockoutDay: 当天是否在杯赛淘汰阶段
 */
export function estimateRotationProbability(context = {}) {
  const {
    competition = "联赛",
    selfElo = 1500,
    opponentElo = 1500,
    nextImportantMatchInDays = 7,
    leagueRankSecured = false,
    isCupKnockoutDay = false
  } = context;

  let p = 0.05;  // baseline

  // 杯赛 + Elo 差大 → 高概率
  const eloDelta = selfElo - opponentElo;
  if (competition.includes("杯") && eloDelta > 200) p += 0.30;
  else if (competition.includes("杯") && eloDelta > 100) p += 0.15;

  // 友谊赛 → 必轮换
  if (/友谊|Friendly/i.test(competition)) p += 0.60;

  // 下一场重要比赛在 3 天内 → 轮换概率高
  if (nextImportantMatchInDays <= 3) p += 0.25;
  else if (nextImportantMatchInDays <= 5) p += 0.10;

  // 联赛已锁排名(末轮) → 轮换
  if (leagueRankSecured) p += 0.30;

  // 强队在杯赛 → 节制
  if (isCupKnockoutDay) p -= 0.15;

  p = Math.max(0, Math.min(1, p));

  return {
    rotationProbability: round(p),
    level: classifyRotation(p),
    eloDelta: round(eloDelta),
    factors: identifyFactors(context, p)
  };
}

function classifyRotation(p) {
  if (p >= 0.6) return "heavy-rotation";
  if (p >= 0.35) return "moderate-rotation";
  if (p >= 0.15) return "light-rotation";
  return "full-strength";
}

function identifyFactors(ctx, p) {
  const factors = [];
  if (ctx.competition?.includes("友谊")) factors.push("友谊赛");
  if (ctx.nextImportantMatchInDays && ctx.nextImportantMatchInDays <= 3) factors.push("3 天内有重要比赛");
  if (ctx.leagueRankSecured) factors.push("赛季排名已锁定");
  if (ctx.selfElo - ctx.opponentElo > 200) factors.push("对手实力差距大");
  return factors;
}

/**
 * 轮换概率 → 战力发挥折扣 + upset 概率上升.
 */
export function applyRotationDiscount(rotationProb, baseProbs) {
  if (!baseProbs) return null;
  // heavy rotation → 主胜率 -15%, 客胜+upset 概率 +10%
  const discount = rotationProb * 0.20;
  const adjusted = {
    home: baseProbs.home * (1 - discount * 0.7),  // 假设主队是强队轮换更多
    draw: baseProbs.draw * (1 + discount * 0.5),
    away: baseProbs.away * (1 + discount * 0.4)
  };
  const sum = adjusted.home + adjusted.draw + adjusted.away;
  return {
    home: round(adjusted.home / sum),
    draw: round(adjusted.draw / sum),
    away: round(adjusted.away / sum),
    discountApplied: round(discount)
  };
}

/**
 * Rotation → LR(bayesian).
 */
export function rotationToLR(rotationProb) {
  if (rotationProb < 0.15) return null;
  return {
    home: round(1 - rotationProb * 0.2),
    draw: round(1 + rotationProb * 0.15),
    away: round(1 + rotationProb * 0.1)
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
