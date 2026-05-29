/**
 * Signal Fusion Layer (V 档 — 整合层)
 * ────────────────────────────────────────────────────────────
 * 把此前游离在主预测路径之外的"高级信号"模块,统一以 likelihood ratio(LR)
 * 证据的形式,经 bayesian-belief-update 融进基础概率。
 *
 * 设计原则(对齐"系统级深度 + 诚实"两条要求):
 *  1. 统一机制:所有信号都转成 {home,draw,away} 的 LR,经 bayesianUpdate 的
 *     log-odds 加法组合 —— 取代各自散落在 prediction-engine 里的 Math.exp() 乘法。
 *  2. 数据门控:每个信号显式声明数据来源;数据缺失 → 进 dormant 列表,不 fire。
 *     冷启动数据下不会假装有信号;等数据源(伤停/H2H/近期赛果)到位后自动激活。
 *  3. 有界:每条 LR 先夹到 [LR_MIN, LR_MAX],融合后总位移再对每个 outcome 封顶
 *     (默认 ±MAX_TOTAL_SHIFT),防单一异常信号炸概率。
 *  4. 透明:返回 fired / dormant 两份清单,供 evidence 注释和审计。
 *
 * 当前(2026-05-29 冷启动)只有 season-phase / competition-type 两个元数据信号
 * 会真 fire;injury / h2h / clean-sheet-streak / rotation 因缺数据休眠。
 */

import { bayesianUpdate } from "./bayesian-belief-update.js";
import { adjustForSeasonPhase } from "./season-phase-model.js";
import { adjustProbabilitiesByCompetition, competitionProfile } from "./competition-type-model.js";
import { compareInjuryImpact, injuryToLR } from "./injury-impact-model.js";
import { analyzeH2H, h2hToLR } from "./head-to-head-history.js";
import { detectCleanSheetStreak, cleanSheetStreakToLR } from "./clean-sheet-streak.js";
import { estimateRotationProbability, rotationToLR } from "./rotation-policy-model.js";
import { detectStreak, streakToLR } from "./streak-detector.js";
import { compareFatigue, applyFatigueBias } from "./schedule-fatigue-model.js";

const OUTCOMES = ["home", "draw", "away"];
const LR_MIN = 0.5;
const LR_MAX = 2.0;
const DEFAULT_MAX_TOTAL_SHIFT = 0.12;

function round(v) {
  return Math.round(v * 10000) / 10000;
}

function clampLR(lr) {
  if (!lr) return null;
  const out = {};
  for (const o of OUTCOMES) {
    const v = Number(lr[o]);
    out[o] = Number.isFinite(v) ? Math.min(LR_MAX, Math.max(LR_MIN, v)) : 1;
  }
  // 全 1 视为无效信号(不产生位移)
  if (out.home === 1 && out.draw === 1 && out.away === 1) return null;
  return out;
}

// 由"已调整概率"反推一个等效 LR(adjusted/prior),供返回 adjusted-probs 的模块统一接入。
function lrFromAdjustment(prior, adjusted) {
  if (!prior || !adjusted) return null;
  const eps = 1e-9;
  return clampLR({
    home: (adjusted.home + eps) / (prior.home + eps),
    draw: (adjusted.draw + eps) / (prior.draw + eps),
    away: (adjusted.away + eps) / (prior.away + eps)
  });
}

function matchDateOf(fixture, advancedData) {
  return fixture?.date || fixture?.kickoff || fixture?.time || advancedData?.date || null;
}

function fixtureLayer(advancedData, fixture, layer) {
  const row = advancedData?.fixtures?.find((r) => r.fixtureId === fixture?.id || r.fixtureId === fixture?.fixtureId);
  return row?.data?.[layer] ?? null;
}

/**
 * 把单条信号的产出归一成 {name, source, lr} | {name, source, dormant}。
 */
function signalSeasonPhase(prior, fixture, advancedData, context) {
  const matchDate = matchDateOf(fixture, advancedData);
  if (!matchDate) return { name: "season-phase", source: "fixture.date", dormant: "no-match-date" };
  const res = adjustForSeasonPhase(prior, matchDate, context.motivations ?? {});
  const lr = clampLR(lrFromAdjustment(prior, res?.adjusted));
  if (!lr) return { name: "season-phase", source: "fixture.date", dormant: "neutral-phase" };
  return { name: "season-phase", source: "fixture.date", lr, detail: res?.detected?.phase ?? null };
}

function signalCompetitionType(prior, fixture, advancedData, context) {
  const competition = fixture?.competition;
  if (!competition) return { name: "competition-type", source: "fixture.competition", dormant: "no-competition" };
  const res = adjustProbabilitiesByCompetition(prior, competition);
  const lr = clampLR(lrFromAdjustment(prior, res?.adjusted));
  if (!lr) return { name: "competition-type", source: "fixture.competition", dormant: "neutral-profile" };
  return { name: "competition-type", source: "fixture.competition", lr, detail: competitionProfile(competition)?.label ?? competition };
}

function signalInjury(prior, fixture, advancedData, context) {
  // 数据源:advancedData injuries 层,或 context.injuries。形如 { home:[...], away:[...] } 或 { injuries:[{team,position,importance}] }
  const layer = context.injuries ?? fixtureLayer(advancedData, fixture, "injuries");
  let homeAbs = layer?.home;
  let awayAbs = layer?.away;
  if (!homeAbs && !awayAbs && Array.isArray(layer?.injuries) && layer.injuries.length) {
    homeAbs = layer.injuries.filter((x) => x.team === "home" || x.team === fixture?.homeTeam);
    awayAbs = layer.injuries.filter((x) => x.team === "away" || x.team === fixture?.awayTeam);
  }
  homeAbs = Array.isArray(homeAbs) ? homeAbs : [];
  awayAbs = Array.isArray(awayAbs) ? awayAbs : [];
  if (!homeAbs.length && !awayAbs.length) {
    return { name: "injury", source: "advancedData.injuries", dormant: "no-confirmed-injury-data" };
  }
  const cmp = compareInjuryImpact(homeAbs, awayAbs);
  const lr = clampLR(injuryToLR(cmp.netEloShift));
  if (!lr) return { name: "injury", source: "advancedData.injuries", dormant: "net-impact-neutral" };
  return { name: "injury", source: "advancedData.injuries", lr, detail: cmp.interpretation };
}

function signalH2H(prior, fixture, advancedData, context) {
  const matches = context.h2hMatches ?? fixtureLayer(advancedData, fixture, "h2h");
  if (!Array.isArray(matches) || matches.length < 2) {
    return { name: "h2h", source: "context.h2hMatches", dormant: "no-h2h-history" };
  }
  const analysis = analyzeH2H(matches, fixture?.homeTeam, fixture?.awayTeam);
  const lr = clampLR(h2hToLR(analysis));
  if (!lr) return { name: "h2h", source: "context.h2hMatches", dormant: "balanced-or-thin" };
  return { name: "h2h", source: "context.h2hMatches", lr, detail: analysis?.pattern ?? null };
}

function signalCleanSheetStreak(prior, fixture, advancedData, context) {
  const homeMatches = context.homeRecentMatches;
  const awayMatches = context.awayRecentMatches;
  if (!Array.isArray(homeMatches) && !Array.isArray(awayMatches)) {
    return { name: "clean-sheet-streak", source: "context.recentMatches", dormant: "no-recent-match-history" };
  }
  const homeStreak = Array.isArray(homeMatches) ? detectCleanSheetStreak(homeMatches) : null;
  const awayStreak = Array.isArray(awayMatches) ? detectCleanSheetStreak(awayMatches) : null;
  const lr = clampLR(cleanSheetStreakToLR(homeStreak, awayStreak));
  if (!lr) return { name: "clean-sheet-streak", source: "context.recentMatches", dormant: "no-significant-streak" };
  return { name: "clean-sheet-streak", source: "context.recentMatches", lr };
}

function signalRotation(prior, fixture, advancedData, context) {
  const rotationContext = context.rotationContext;
  if (!rotationContext) {
    return { name: "rotation", source: "context.rotationContext", dormant: "no-rotation-context" };
  }
  const prob = estimateRotationProbability(rotationContext);
  const rotationProbability = typeof prob === "number" ? prob : prob?.rotationProbability ?? 0;
  const lr = clampLR(rotationToLR(rotationProbability));
  if (!lr) return { name: "rotation", source: "context.rotationContext", dormant: "rotation-unlikely" };
  return { name: "rotation", source: "context.rotationContext", lr };
}

function mirrorLR(lr) {
  return lr ? { home: lr.away, draw: lr.draw, away: lr.home } : null;
}

function signalStreak(prior, fixture, advancedData, context) {
  const homeMatches = context.homeRecentMatches;
  const awayMatches = context.awayRecentMatches;
  if (!Array.isArray(homeMatches) && !Array.isArray(awayMatches)) {
    return { name: "streak", source: "context.recentMatches", dormant: "no-recent-match-history" };
  }
  // detectStreak 需最近在末尾;recentMatchesFor 给最近在前 → 反转副本
  const homeStreak = Array.isArray(homeMatches) ? detectStreak([...homeMatches].reverse()) : null;
  const awayStreak = Array.isArray(awayMatches) ? detectStreak([...awayMatches].reverse()) : null;
  const homeLR = streakToLR(homeStreak);
  const awayLR = mirrorLR(streakToLR(awayStreak));
  if (!homeLR && !awayLR) return { name: "streak", source: "context.recentMatches", dormant: "no-significant-streak" };
  const combined = {
    home: (homeLR?.home ?? 1) * (awayLR?.home ?? 1),
    draw: (homeLR?.draw ?? 1) * (awayLR?.draw ?? 1),
    away: (homeLR?.away ?? 1) * (awayLR?.away ?? 1)
  };
  const lr = clampLR(combined);
  if (!lr) return { name: "streak", source: "context.recentMatches", dormant: "net-neutral" };
  const detail = [homeStreak?.type !== "none" ? `主${homeStreak?.type}×${homeStreak?.length}` : null,
    awayStreak?.type !== "none" ? `客${awayStreak?.type}×${awayStreak?.length}` : null].filter(Boolean).join(" ");
  return { name: "streak", source: "context.recentMatches", lr, detail: detail || null };
}

function signalFatigue(prior, fixture, advancedData, context) {
  const homePrev = context.homePrevMatchDate ?? context.homeRecentMatches?.[0]?.date;
  const awayPrev = context.awayPrevMatchDate ?? context.awayRecentMatches?.[0]?.date;
  const matchDate = matchDateOf(fixture, advancedData);
  if (!homePrev || !awayPrev || !matchDate) {
    return { name: "fatigue", source: "context.recentMatches", dormant: "no-prev-match-dates" };
  }
  const cmp = compareFatigue(homePrev, awayPrev, matchDate);
  if (!cmp.significant) return { name: "fatigue", source: "context.recentMatches", dormant: "rest-balanced" };
  const lr = clampLR(lrFromAdjustment(prior, applyFatigueBias(prior, cmp)));
  if (!lr) return { name: "fatigue", source: "context.recentMatches", dormant: "negligible" };
  return { name: "fatigue", source: "context.recentMatches", lr, detail: `主息${homePrev}→客息${awayPrev}` };
}

const SIGNAL_HANDLERS = [
  signalSeasonPhase,
  signalCompetitionType,
  signalInjury,
  signalH2H,
  signalCleanSheetStreak,
  signalStreak,
  signalFatigue,
  signalRotation
];

/**
 * 收集所有信号的 LR 证据,分 fired / dormant 两类。
 */
export function collectFusionEvidence(prior, fixture, advancedData = {}, context = {}) {
  const evidence = [];
  const dormant = [];
  for (const handler of SIGNAL_HANDLERS) {
    let result;
    try {
      result = handler(prior, fixture, advancedData, context);
    } catch (err) {
      dormant.push({ name: handler.name, dormant: `error:${err.message}` });
      continue;
    }
    if (result?.lr) {
      evidence.push({ name: result.name, ratio: result.lr, source: result.source, detail: result.detail ?? null });
    } else if (result) {
      dormant.push({ name: result.name, source: result.source, dormant: result.dormant });
    }
  }
  return { evidence, dormant };
}

function capTotalShift(prior, posterior, maxShift) {
  const capped = {};
  for (const o of OUTCOMES) {
    const delta = posterior[o] - prior[o];
    const clamped = Math.min(maxShift, Math.max(-maxShift, delta));
    capped[o] = prior[o] + clamped;
  }
  const total = OUTCOMES.reduce((s, o) => s + Math.max(0, capped[o]), 0) || 1;
  const out = {};
  for (const o of OUTCOMES) out[o] = round(Math.max(0, capped[o]) / total);
  return out;
}

/**
 * 主入口:对基础概率做信号融合。
 * @returns {{ applied, probabilities, evidence, dormant, posterior, maxShift, bayes }}
 */
export function fuseSignals(prior, fixture, advancedData = {}, context = {}, opts = {}) {
  const maxShift = Number.isFinite(opts.maxTotalShift) ? opts.maxTotalShift : DEFAULT_MAX_TOTAL_SHIFT;
  if (!prior || !OUTCOMES.every((o) => Number.isFinite(prior[o]))) {
    return { applied: false, probabilities: prior, evidence: [], dormant: [], posterior: prior, maxShift: 0, reason: "invalid-prior" };
  }
  const { evidence, dormant } = collectFusionEvidence(prior, fixture, advancedData, context);
  if (!evidence.length) {
    return { applied: false, probabilities: prior, evidence: [], dormant, posterior: prior, maxShift: 0 };
  }
  const bayes = bayesianUpdate(prior, evidence);
  if (!bayes.ok) {
    return { applied: false, probabilities: prior, evidence, dormant, posterior: prior, maxShift: 0, reason: bayes.reason };
  }
  const capped = capTotalShift(prior, bayes.posterior, maxShift);
  const realizedShift = round(Math.max(...OUTCOMES.map((o) => Math.abs(capped[o] - prior[o]))));
  return {
    applied: true,
    probabilities: capped,
    evidence,
    dormant,
    posterior: bayes.posterior,
    maxShift: realizedShift,
    bayes
  };
}
