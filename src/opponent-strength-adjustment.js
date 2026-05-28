/**
 * Opponent-Strength Adjustment
 * ──────────────────────────────────────────────────
 * 输强队 0-1 不算差,赢弱队 5-0 不算好.
 * 把每场结果按对手 Elo 校准,得到"对手调整后形势分".
 *
 * 模型:
 *   adjustedPoints = rawPoints + α × (opponentElo - baseElo) / scaler
 *   adjustedGoalDiff = rawGD + β × (opponentElo - baseElo) / scaler
 *
 * 防止"刷弱队战绩"误判球队真实强度.
 */

const BASE_ELO = 1500;
const ELO_SCALER = 200;  // 每差 200 Elo 一档
const POINT_ADJUSTMENT_ALPHA = 0.5;
const GD_ADJUSTMENT_BETA = 0.3;

/**
 * @param {Object} match { result: "W"|"D"|"L", goalDiff, opponentElo }
 */
export function adjustMatchOutcome(match) {
  if (!match) return null;
  const rawPoints = match.result === "W" ? 3 : match.result === "D" ? 1 : 0;
  const rawGD = Number(match.goalDiff ?? 0);
  const oppElo = Number(match.opponentElo ?? BASE_ELO);
  const eloDelta = (oppElo - BASE_ELO) / ELO_SCALER;

  const adjustedPoints = rawPoints + POINT_ADJUSTMENT_ALPHA * eloDelta;
  const adjustedGD = rawGD + GD_ADJUSTMENT_BETA * eloDelta;

  return {
    rawPoints,
    rawGoalDiff: rawGD,
    opponentElo: oppElo,
    eloDelta: round(eloDelta),
    adjustedPoints: round(adjustedPoints),
    adjustedGoalDiff: round(adjustedGD),
    interpretation: interpret(rawPoints, eloDelta)
  };
}

function interpret(rawPoints, eloDelta) {
  if (rawPoints === 3 && eloDelta > 1) return "强强对决拿下,真实质量高";
  if (rawPoints === 3 && eloDelta < -1) return "赢弱队,样本含金量低";
  if (rawPoints === 0 && eloDelta > 1) return "输强队,样本含金量低(不应严罚)";
  if (rawPoints === 0 && eloDelta < -1) return "输弱队,样本含金量高(严重信号)";
  if (rawPoints === 1 && eloDelta > 1) return "强敌客场平局,质量分高";
  return "标准对手,无显著调整";
}

/**
 * 给近 N 场,产 adjusted PPG / GD.
 */
export function adjustedFormSummary(matches = []) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const adjusted = matches.map(adjustMatchOutcome).filter(Boolean);
  const avgRawPpg = mean(adjusted.map((a) => a.rawPoints));
  const avgAdjPpg = mean(adjusted.map((a) => a.adjustedPoints));
  const avgRawGD = mean(adjusted.map((a) => a.rawGoalDiff));
  const avgAdjGD = mean(adjusted.map((a) => a.adjustedGoalDiff));
  const inflation = avgAdjPpg - avgRawPpg;

  return {
    sampleSize: matches.length,
    rawPpg: round(avgRawPpg),
    adjustedPpg: round(avgAdjPpg),
    rawGoalDiff: round(avgRawGD),
    adjustedGoalDiff: round(avgAdjGD),
    qualityInflation: round(inflation),
    qualityVerdict: inflation > 0.3
      ? "对手质量被低估(真实强度高于 raw form)"
      : inflation < -0.3
      ? "对手质量被高估(刷弱队拿分,真实强度低于 raw form)"
      : "对手质量中性"
  };
}

/**
 * 给两支队的 form,产对比:谁的近期质量含金量更高.
 */
export function compareAdjustedForm(homeForm, awayForm) {
  if (!homeForm || !awayForm) return null;
  const ppgGap = homeForm.adjustedPpg - awayForm.adjustedPpg;
  return {
    home: homeForm.adjustedPpg,
    away: awayForm.adjustedPpg,
    gap: round(ppgGap),
    interpretation: Math.abs(ppgGap) < 0.3
      ? "adjusted form 接近"
      : ppgGap > 0
      ? `主队 adjusted PPG 高 ${ppgGap.toFixed(2)},真实强度更高`
      : `客队 adjusted PPG 高 ${(-ppgGap).toFixed(2)},真实强度更高`
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
