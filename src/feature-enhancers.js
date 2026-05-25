/**
 * 命中率增益 · 第 2 层：特征增强
 * ──────────────────────────────────────────────────
 * 补两个公认有效、现有系统还缺失的高价值特征：
 *
 *  1. 对手强度归一化状态（strength-adjusted form）
 *     现有 formSignal 用原始 ppg —— "打弱队的 3 分"和"打强队的 3 分"
 *     被同等对待，造成"虐菜"球队状态虚高。本模块用对手 Elo 加权修正。
 *
 *  2. 赛程疲劳（schedule fatigue）
 *     现有系统抓了赛程但没量化"3 天 3 赛 + 跨国客场"的疲劳折损。
 *     在杯赛周、欧战周影响显著。
 *
 * 设计原则：纯函数，输出可直接并入 prediction-engine 的概率修正。
 * 与现有 eloSignal/formSignal 同构，融入 adjustProbabilitiesWithAdvancedData。
 *
 * 用法（prediction-engine.js）：
 *   import { strengthAdjustedFormSignal, fatigueSignal } from "./feature-enhancers.js";
 *   const saForm = strengthAdjustedFormSignal(fixtureData.form, fixtureData.elo);
 *   const fatigue = fatigueSignal(fixtureData.schedule);
 */

/**
 * 对手强度归一化状态信号。
 * 把球队近期战绩按对手 Elo 加权：打强队拿分加权更高。
 * @param {Object} form  fixtureData.form，含 home/away 的 pointsPerMatch / opponents
 * @param {Object} elo   fixtureData.elo，用于估计球队自身与对手强度
 * @returns {Object|null} 信号对象，格式与 formSignal 一致（含 score 字段）
 */
export function strengthAdjustedFormSignal(form, elo) {
  const home = form?.home;
  const away = form?.away;
  if ((home?.matches ?? 0) < 4 || (away?.matches ?? 0) < 4) return null;

  const homeAdj = adjustedPointsPerMatch(home);
  const awayAdj = adjustedPointsPerMatch(away);
  if (homeAdj === null || awayAdj === null) {
    // 缺对手强度数据时，退回原始 ppg，不报错
    return null;
  }

  // 归一化后的 ppg 差，范围裁剪到 [-2, 2]
  const adjustedPpgDiff = clamp(homeAdj - awayAdj, -2, 2);

  return {
    key: "strengthAdjustedForm",
    homeAdjustedPpg: round(homeAdj),
    awayAdjustedPpg: round(awayAdj),
    adjustedPpgDiff: round(adjustedPpgDiff),
    // 系数略低于原 formSignal(0.08)，因为它是对原状态的"精修"而非替代
    score: round(adjustedPpgDiff * 0.06),
  };
}

/**
 * 计算单队的对手强度归一化场均积分。
 * 若每场记录里带 opponentElo 和 points，则按对手强度加权；
 * 否则返回 null（让调用方退回原始 ppg）。
 */
function adjustedPointsPerMatch(team) {
  const recent = team?.recentMatches ?? team?.matchesDetail ?? team?.results;
  if (!Array.isArray(recent) || recent.length < 4) return null;

  let weightedPoints = 0;
  let totalWeight = 0;
  for (const m of recent) {
    const points = Number(m.points ?? pointsFromResult(m));
    const oppElo = Number(m.opponentElo ?? m.oppElo);
    if (!Number.isFinite(points)) continue;
    // 对手 Elo 缺失时权重为 1（中性）
    // 对手越强（Elo 越高），该场表现的权重越大
    const weight = Number.isFinite(oppElo) ? eloToWeight(oppElo) : 1;
    weightedPoints += points * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return weightedPoints / totalWeight;
}

/**
 * 对手 Elo → 权重。
 * Elo 1500 为基准（权重 1.0），每高 100 分权重 +0.12，裁剪到 [0.6, 1.6]。
 */
function eloToWeight(oppElo) {
  return clamp(1 + ((oppElo - 1500) / 100) * 0.12, 0.6, 1.6);
}

function pointsFromResult(m) {
  const gf = Number(m.goalsFor ?? m.scored);
  const ga = Number(m.goalsAgainst ?? m.conceded);
  if (!Number.isFinite(gf) || !Number.isFinite(ga)) return NaN;
  if (gf > ga) return 3;
  if (gf === ga) return 1;
  return 0;
}

/**
 * 赛程疲劳信号。
 * 量化"休息天数不足 + 连续作战 + 跨国客场"对球队的折损。
 * @param {Object} schedule  fixtureData.schedule，含 home/away 的
 *   restDays（距上一场天数）、matchesIn7Days、travelKm（可选）
 * @returns {Object|null}
 */
export function fatigueSignal(schedule) {
  const home = schedule?.home;
  const away = schedule?.away;
  if (!home && !away) return null;

  const homeFatigue = teamFatigue(home);
  const awayFatigue = teamFatigue(away);
  if (homeFatigue === null && awayFatigue === null) return null;

  // 疲劳差：客队比主队更累 → 利好主队（score 为正）
  const fatigueDiff = (awayFatigue ?? 0) - (homeFatigue ?? 0);
  const clampedDiff = clamp(fatigueDiff, -1, 1);

  return {
    key: "fatigue",
    homeFatigue: homeFatigue === null ? null : round(homeFatigue),
    awayFatigue: awayFatigue === null ? null : round(awayFatigue),
    fatigueDiff: round(clampedDiff),
    // 疲劳是较弱信号，系数保守
    score: round(clampedDiff * 0.05),
    // 疲劳通常也意味着进球减少 / 平局概率上升
    drawBoost: round(Math.abs(clampedDiff) * 0.02),
  };
}

/**
 * 单队疲劳分：0（充分休息）到 ~1（极度疲劳）。
 */
function teamFatigue(team) {
  if (!team) return null;
  const restDays = Number(team.restDays);
  const matchesIn7 = Number(team.matchesIn7Days);
  const travelKm = Number(team.travelKm);

  let fatigue = 0;
  let hasSignal = false;

  if (Number.isFinite(restDays)) {
    hasSignal = true;
    // 休息 ≥4 天无疲劳；3 天轻微；2 天明显；≤1 天严重
    if (restDays <= 1) fatigue += 0.5;
    else if (restDays === 2) fatigue += 0.32;
    else if (restDays === 3) fatigue += 0.15;
  }
  if (Number.isFinite(matchesIn7)) {
    hasSignal = true;
    // 7 天内 3 场及以上属高强度
    if (matchesIn7 >= 3) fatigue += 0.3;
    else if (matchesIn7 === 2) fatigue += 0.12;
  }
  if (Number.isFinite(travelKm) && travelKm > 0) {
    hasSignal = true;
    // 长途客场（>1500km）附加疲劳
    if (travelKm >= 3000) fatigue += 0.2;
    else if (travelKm >= 1500) fatigue += 0.1;
  }

  if (!hasSignal) return null;
  return clamp(fatigue, 0, 1);
}

/**
 * 把第 2 层两个信号合并应用到概率权重上。
 * 设计为在 adjustProbabilitiesWithAdvancedData 中调用。
 * @param {Object} weights  当前概率权重 { home, draw, away }
 * @param {Object} fixtureData  来自 advancedData 的单场数据
 * @param {Function} getScale   signal-weight-tuner 的 getSignalScale，可选
 * @returns {{weights, signals}}
 */
export function applyLayer2Signals(weights, fixtureData, getScale = () => 1) {
  const signals = [];
  const next = { ...weights };

  const saForm = strengthAdjustedFormSignal(fixtureData?.form, fixtureData?.elo);
  if (saForm) {
    const scale = getScale("strengthAdjustedForm");
    next.home *= Math.exp(saForm.score * scale);
    next.away *= Math.exp(-saForm.score * scale);
    next.draw *= Math.exp(-Math.abs(saForm.score * scale) * 0.3);
    signals.push(saForm);
  }

  const fatigue = fatigueSignal(fixtureData?.schedule);
  if (fatigue) {
    const scale = getScale("fatigue");
    next.home *= Math.exp(fatigue.score * scale);
    next.away *= Math.exp(-fatigue.score * scale);
    // 疲劳还会推高平局概率
    next.draw *= Math.exp(fatigue.drawBoost * scale);
    signals.push(fatigue);
  }

  return { weights: next, signals };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round((v + Number.EPSILON) * 10000) / 10000; }
