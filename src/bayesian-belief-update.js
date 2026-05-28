/**
 * Bayesian Belief Update
 * ──────────────────────────────────────────────────
 * 给一个 prior(模型预测) + 一组 evidence(伤兵/天气/裁判/线移),
 * 用 Bayes' rule 算 posterior 概率.
 *
 *   P(outcome | evidence) ∝ P(outcome) × ∏ P(evidence_i | outcome)
 *
 * 简化:用 log-odds 加法(数值稳定 + 直觉:每个 evidence 是个 "vote shift"):
 *   log_odds(o | E) = log_odds(o) + Σ log_likelihood_ratio(e_i, o)
 *
 * 每个 evidence 提供一个 likelihood ratio(LR > 1 利此 outcome,LR < 1 反).
 * 标准 LR 表(经验值):
 *   "key-injury-home" → home: 0.7, draw: 1.1, away: 1.3
 *   "harsh-weather" → home: 0.95, draw: 1.2, away: 0.95(低进球 → 平局率上)
 *   "steam-money-home" → home: 1.3, draw: 0.95, away: 0.85
 *   "reverse-line-to-away" → away: 1.4, ...
 */

const OUTCOMES = ["home", "draw", "away"];

// 经验 LR 表(可调)
export const EVIDENCE_LR = {
  "key-injury-home":  { home: 0.70, draw: 1.10, away: 1.30 },
  "key-injury-away":  { home: 1.30, draw: 1.10, away: 0.70 },
  "harsh-weather":    { home: 0.95, draw: 1.25, away: 0.95 },
  "rain":             { home: 0.97, draw: 1.15, away: 0.97 },
  "steam-money-home": { home: 1.30, draw: 0.95, away: 0.85 },
  "steam-money-away": { home: 0.85, draw: 0.95, away: 1.30 },
  "reverse-line-home":{ home: 1.40, draw: 0.95, away: 0.80 },
  "reverse-line-away":{ home: 0.80, draw: 0.95, away: 1.40 },
  "tilted-bookmaker": { home: 0.95, draw: 1.10, away: 0.95 },
  "home-fatigue":     { home: 0.85, draw: 1.05, away: 1.20 },
  "away-fatigue":     { home: 1.20, draw: 1.05, away: 0.85 },
  "home-tactical-advantage": { home: 1.20, draw: 0.95, away: 0.90 },
  "derby":            { home: 0.95, draw: 1.20, away: 0.95 },
  "must-win-home":    { home: 1.15, draw: 0.95, away: 0.95 },
  "must-win-away":    { home: 0.95, draw: 0.95, away: 1.15 }
};

/**
 * @param {Object} prior  { home, draw, away }
 * @param {Array} evidence  [{ name, ratio? }],name 可在 EVIDENCE_LR 表里
 *   若 ratio 自定义,覆盖默认.
 */
export function bayesianUpdate(prior, evidence = []) {
  if (!prior || !Number.isFinite(prior.home) || !Number.isFinite(prior.draw) || !Number.isFinite(prior.away)) {
    return { ok: false, reason: "invalid-prior" };
  }
  if (!Array.isArray(evidence)) evidence = [];

  // Log-odds 起步
  const epsilon = 1e-9;
  const logProb = {
    home: Math.log(Math.max(epsilon, prior.home)),
    draw: Math.log(Math.max(epsilon, prior.draw)),
    away: Math.log(Math.max(epsilon, prior.away))
  };

  const evidenceApplied = [];
  for (const ev of evidence) {
    const lr = ev.ratio ?? EVIDENCE_LR[ev.name];
    if (!lr) continue;
    for (const o of OUTCOMES) {
      logProb[o] += Math.log(Math.max(epsilon, lr[o]));
    }
    evidenceApplied.push({ name: ev.name, lr });
  }

  // 归一化
  const maxL = Math.max(logProb.home, logProb.draw, logProb.away);
  const exps = {
    home: Math.exp(logProb.home - maxL),
    draw: Math.exp(logProb.draw - maxL),
    away: Math.exp(logProb.away - maxL)
  };
  const total = exps.home + exps.draw + exps.away;
  const posterior = {
    home: exps.home / total,
    draw: exps.draw / total,
    away: exps.away / total
  };

  return {
    ok: true,
    prior,
    posterior: {
      home: round(posterior.home),
      draw: round(posterior.draw),
      away: round(posterior.away)
    },
    delta: {
      home: round(posterior.home - prior.home),
      draw: round(posterior.draw - prior.draw),
      away: round(posterior.away - prior.away)
    },
    evidenceApplied,
    largestShift: largestShift(prior, posterior)
  };
}

function largestShift(prior, posterior) {
  let max = 0;
  let dir = null;
  for (const o of OUTCOMES) {
    const d = posterior[o] - prior[o];
    if (Math.abs(d) > Math.abs(max)) {
      max = d;
      dir = o;
    }
  }
  return { outcome: dir, shift: round(max) };
}

/**
 * 注册新的 evidence pattern.
 */
export function registerEvidence(name, lrTable) {
  if (!lrTable || !Number.isFinite(lrTable.home) || !Number.isFinite(lrTable.draw) || !Number.isFinite(lrTable.away)) {
    throw new Error(`Invalid LR table for ${name}`);
  }
  EVIDENCE_LR[name] = lrTable;
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
