/**
 * 二串一 / 三串一 智能组合生成器
 * ──────────────────────────────────────────────────
 * 基于每场预测的 (probability, odds, expectedValue),从胜负彩 14 场 / 竞彩 9 场里
 * 挑出最优过关组合,符合国内体彩玩家长期形成的实战经验:
 *
 *   1. SP 区间过滤:单场赔率落在 1.8 - 3.5 之间(2-3-2 区间)
 *      └─ 太低 (<1.8) 不值得,太高 (>3.5) 命中率不稳定
 *
 *   2. 持续正 EV:组合 EV = ∏(p_i × odds_i) - 1 > 0.10
 *      └─ 组合 EV 比单场 EV 衰减更慢但更脆弱,要求更高安全垫
 *
 *   3. 概率下限:两/三场联合命中概率 ≥ 8%(避免极小概率搏大赔)
 *
 *   4. 半凯利仓位:基于联合 EV 和联合赔率,给一个建议仓位(已经在 0.25 Kelly 上再砍半)
 *
 * 输出格式跟 prediction 结构兼容,可直接被 daily-report.js xlsx-writer 消费。
 */

import { canonicalTeamName } from "./team-aliases.js";

const MIN_LEG_ODDS = 1.8;
const MAX_LEG_ODDS = 3.5;
const MIN_COMBO_EV = 0.10;
const MIN_COMBO_PROBABILITY = 0.08;
const MAX_COMBO_COUNT_PER_LEVEL = 5;

/**
 * @param {Array} predictions  完整的 predictions 列表(已经带 expectedValue 字段)
 * @param {Object} opts
 *   opts.maxLegs   最多串关数,默认 3(二串一 + 三串一)
 *   opts.kellyFraction  凯利分数,默认 0.125(半凯利 × 1/4 凯利)
 * @returns {{twoLeg, threeLeg, summary}}
 */
export function buildComboRecommendations(predictions, opts = {}) {
  const maxLegs = opts.maxLegs ?? 3;
  const kellyFraction = opts.kellyFraction ?? 0.125;

  const candidates = predictions
    .map((prediction) => extractCandidate(prediction))
    .filter(Boolean);

  const twoLeg = maxLegs >= 2 ? generateCombos(candidates, 2, kellyFraction) : [];
  const threeLeg = maxLegs >= 3 ? generateCombos(candidates, 3, kellyFraction) : [];

  return {
    twoLeg: twoLeg.slice(0, MAX_COMBO_COUNT_PER_LEVEL),
    threeLeg: threeLeg.slice(0, MAX_COMBO_COUNT_PER_LEVEL),
    summary: {
      candidatePool: candidates.length,
      twoLegFound: twoLeg.length,
      threeLegFound: threeLeg.length,
      minLegOdds: MIN_LEG_ODDS,
      maxLegOdds: MAX_LEG_ODDS,
      minComboEv: MIN_COMBO_EV,
      kellyFraction
    }
  };
}

function extractCandidate(prediction) {
  if (!prediction?.fixture || !prediction?.expectedValue?.primary) return null;
  const primary = prediction.expectedValue.primary;
  // 必须是 value bet(EV>0.05)且 SP 在区间内,才能进候选
  if (!primary.valueBet) return null;
  if (!Number.isFinite(primary.odds) || primary.odds < MIN_LEG_ODDS || primary.odds > MAX_LEG_ODDS) return null;
  return {
    fixtureId: prediction.fixture.id,
    sequence: prediction.fixture.sequence,
    homeTeam: prediction.fixture.homeTeam,
    awayTeam: prediction.fixture.awayTeam,
    competition: prediction.fixture.competition,
    pickCode: primary.code,
    pickLabel: primary.label,
    probability: prediction.probabilities?.[codeToProbKey(primary.code)] ?? null,
    odds: primary.odds,
    legEv: primary.ev,
    confidence: prediction.confidence ?? null,
    risk: prediction.risk ?? null
  };
}

function codeToProbKey(code) {
  return code === "3" ? "home" : code === "1" ? "draw" : "away";
}

function generateCombos(candidates, legs, kellyFraction) {
  const combos = [];
  walkCombinations(candidates, legs, [], 0, (combo) => {
    const stats = evaluateCombo(combo, kellyFraction);
    if (stats.combinedProbability < MIN_COMBO_PROBABILITY) return;
    if (stats.combinedEv < MIN_COMBO_EV) return;
    combos.push({ ...stats, legs: combo.map((c) => ({
      fixtureId: c.fixtureId,
      sequence: c.sequence,
      match: `${c.homeTeam} vs ${c.awayTeam}`,
      competition: c.competition,
      pick: c.pickLabel,
      pickCode: c.pickCode,
      probability: round(c.probability),
      odds: round(c.odds),
      legEv: round(c.legEv)
    })) });
  });
  // 主排序:combinedEv 高,次排序:combinedProbability 高
  return combos.sort((a, b) => (b.combinedEv - a.combinedEv) || (b.combinedProbability - a.combinedProbability));
}

function walkCombinations(arr, k, current, start, emit) {
  if (current.length === k) { emit(current); return; }
  for (let i = start; i < arr.length; i++) {
    walkCombinations(arr, k, [...current, arr[i]], i + 1, emit);
  }
}

function evaluateCombo(combo, kellyFraction) {
  let combinedProbability = 1;
  let combinedOdds = 1;
  for (const leg of combo) {
    const p = Number(leg.probability);
    const o = Number(leg.odds);
    if (!Number.isFinite(p) || !Number.isFinite(o) || p <= 0 || o <= 1) {
      return { combinedProbability: 0, combinedOdds: 0, combinedEv: -1, kellyStake: 0 };
    }
    combinedProbability *= p;
    combinedOdds *= o;
  }
  const combinedEv = combinedProbability * combinedOdds - 1;
  // 凯利: f = (p × b - q) / b, 其中 b = combinedOdds - 1, q = 1 - p
  const b = combinedOdds - 1;
  const fullKelly = b > 0 ? (combinedProbability * b - (1 - combinedProbability)) / b : 0;
  const kellyStake = Math.max(0, fullKelly * kellyFraction);
  return {
    combinedProbability: round(combinedProbability),
    combinedOdds: round(combinedOdds),
    combinedEv: round(combinedEv),
    fullKellyFraction: round(fullKelly),
    kellyStake: round(kellyStake)
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
