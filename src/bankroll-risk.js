const OUTCOME_TO_KEY = { "3": "home", "1": "draw", "0": "away" };

export function buildBankrollRisk(prediction, env = process.env) {
  const enabled = env.BANKROLL_RISK_POLICY === "1";
  const pick = prediction?.pick;
  const key = OUTCOME_TO_KEY[pick?.code];
  const odds = key ? Number(prediction?.marketSnapshot?.europeanOdds?.current?.[key]) : Number.NaN;
  const probability = Number(pick?.probability);
  if (!enabled) return { enabled: false, decision: "未启用", reason: "缺 BANKROLL_RISK_POLICY=1" };
  if (!Number.isFinite(odds) || odds <= 1 || !Number.isFinite(probability) || probability <= 0) {
    return { enabled: true, decision: "跳过", reason: "缺少可计算 EV/凯利的欧赔或概率" };
  }
  const ev = round(probability * odds - 1, 4);
  const rawKelly = round((probability * odds - 1) / (odds - 1), 4);
  const maxKellyFraction = finiteNumber(env.BANKROLL_MAX_KELLY_FRACTION, 0.25);
  const maxStakePct = finiteNumber(env.BANKROLL_MAX_STAKE_PCT, 0.02);
  const minEv = finiteNumber(env.BANKROLL_MIN_EV, 0.02);
  const drawdownGuard = finiteNumber(env.BANKROLL_DRAWDOWN_GUARD, 0.35);
  const adjustedKelly = Math.max(0, rawKelly) * maxKellyFraction;
  const stakePct = round(Math.min(maxStakePct, adjustedKelly), 4);
  const decision = ev >= minEv && stakePct > 0 && prediction.risk !== "高" ? "可入池" : "观察/跳过";
  return {
    enabled: true,
    decimalOdds: odds,
    probability: round(probability, 4),
    ev,
    rawKelly,
    maxKellyFraction,
    stakePct,
    stakeUnitsPer100: round(stakePct * 100, 2),
    drawdownGuard,
    decision,
    reason: decision === "可入池" ? "EV、凯利和风险等级通过资金约束" : "EV不足、凯利过低或风险等级过高"
  };
}

function finiteNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
