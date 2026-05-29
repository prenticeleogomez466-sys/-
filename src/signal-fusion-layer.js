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
import { lineMovementToLR, analyzeLineMovement } from "./line-movement-signal.js";
import { splitStats, homeAwaySplitToLR } from "./home-away-split-stats.js";
import { timeDecayFormToLR } from "./time-decay-weighting.js";
import { weatherXgMultiplier } from "./weather-adjusted-xg.js";
import { computeManagerInfluence } from "./manager-effect-model.js";
import { detectDerby, derbyToLR } from "./derby-intensity.js";
import { computePressureProfile, pressureToFormMultiplier } from "./standings-pressure.js";
import { bigGameReadinessLR } from "./big-game-form.js";
import { computeTravelImpact } from "./travel-distance-model.js";
import { getFormationLift } from "./tactical-matchup.js";
import { computeRefereeLR } from "./referee-bias-model.js";
import { compareAdjustedForm, adjustedFormSummary } from "./opponent-strength-adjustment.js";
import { teamChainXgAverage, compareChainXg } from "./xg-chains.js";
import { teamPossessionAdjustedAverage, comparePossessionStyles } from "./possession-adjusted-xg.js";
import { computeSetPieceProfile } from "./set-piece-model.js";
import { analyzeAsianHandicapWater, analyzeMultipleBookmakers } from "./asian-handicap-water.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getExportDir } from "./paths.js";

const OUTCOMES = ["home", "draw", "away"];
const LR_MIN = 0.5;
const LR_MAX = 2.0;
const DEFAULT_MAX_TOTAL_SHIFT = 0.12;

function round(v) {
  return Math.round(v * 10000) / 10000;
}

// 回测学到的融合信号权重 profile(由 npm run weights:search --apply 写)。
// 进程内缓存一次,避免每场预测都读盘;生产路径据此弱化/剔除害校准的信号。
let _weightProfileCache;
export function loadFusionWeightProfile() {
  if (_weightProfileCache !== undefined) return _weightProfileCache;
  try {
    const p = join(getExportDir(), "fusion-signal-weights.json");
    if (!existsSync(p)) { _weightProfileCache = null; return null; }
    const profile = JSON.parse(readFileSync(p, "utf8"));
    _weightProfileCache = profile?.usable
      ? { signalWeights: profile.signalWeights ?? {}, disabledSignals: profile.disabledSignals ?? [], chosen: profile.chosen, temperature: Number.isFinite(profile.temperature) ? profile.temperature : null }
      : null;
  } catch { _weightProfileCache = null; }
  return _weightProfileCache;
}
// 测试/重载用
export function _resetFusionWeightCache() { _weightProfileCache = undefined; }

// 对一个 {home,draw,away} LR 做幂缩放:lr^w(w<1 弱化信号、w>1 放大),再夹回区间。
function scaleLR(lr, w) {
  const out = {};
  for (const o of OUTCOMES) {
    const v = Number(lr[o]);
    out[o] = Number.isFinite(v) && v > 0 ? Math.pow(v, w) : 1;
  }
  return clampLR(out) ?? { home: 1, draw: 1, away: 1 };
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

function signalHomeAwaySplit(prior, fixture, advancedData, context) {
  // 数据源:context.homeRecentMatches / awayRecentMatches(带 venue 标签,fusion-context-builder 装配)。
  const homeMatches = context.homeRecentMatches;
  const awayMatches = context.awayRecentMatches;
  if (!Array.isArray(homeMatches) || !Array.isArray(awayMatches)) {
    return { name: "home-away-split", source: "context.recentMatches", dormant: "no-recent-match-history" };
  }
  const homeSplit = splitStats(homeMatches);
  const awaySplit = splitStats(awayMatches);
  const lr = clampLR(homeAwaySplitToLR(homeSplit, awaySplit));
  if (!lr) return { name: "home-away-split", source: "context.recentMatches", dormant: "thin-or-balanced-split" };
  const detail = `主主场${homeSplit?.home?.ppg ?? "?"}ppg vs 客客场${awaySplit?.away?.ppg ?? "?"}ppg`;
  return { name: "home-away-split", source: "context.recentMatches", lr, detail };
}

function signalTimeDecayForm(prior, fixture, advancedData, context) {
  // 数据源:context.homeRecentMatches / awayRecentMatches(fusion-context-builder 装配,带 date)。
  // 参考日取比赛日,使半衰期衰减相对赛前、可回测复现。
  const homeMatches = context.homeRecentMatches;
  const awayMatches = context.awayRecentMatches;
  if (!Array.isArray(homeMatches) || !Array.isArray(awayMatches)) {
    return { name: "time-decay-form", source: "context.recentMatches", dormant: "no-recent-match-history" };
  }
  const lr = clampLR(timeDecayFormToLR(homeMatches, awayMatches, { referenceDate: fixture?.date }));
  if (!lr) return { name: "time-decay-form", source: "context.recentMatches", dormant: "thin-ess-or-balanced-form" };
  return { name: "time-decay-form", source: "context.recentMatches", lr, detail: "Dixon-Coles 90d 半衰期加权近期 PPG 净差" };
}

function signalLineMovement(prior, fixture, advancedData, context) {
  // 数据源:context.openingOdds(开盘隐含)+ context.currentOdds(当前/收盘快照隐含)。
  // 两者齐全才 fire —— live jingcai 多次捕获赔率变化时装配;缺则休眠(向后兼容)。
  const opening = context.openingOdds;
  const later = context.currentOdds ?? context.closingOdds;
  if (!opening || !later) {
    return { name: "line-movement", source: "context.openingOdds+currentOdds", dormant: "no-odds-snapshots" };
  }
  const lr = clampLR(lineMovementToLR(opening, later, context.lineMovementOpts ?? {}));
  if (!lr) return { name: "line-movement", source: "context.openingOdds+currentOdds", dormant: "movement-below-noise-floor" };
  const a = analyzeLineMovement(opening, later);
  return {
    name: "line-movement",
    source: "context.openingOdds+currentOdds",
    lr,
    detail: a ? `${a.classification} steam→${a.steamOutcome}(${a.steamMagnitude >= 0 ? "+" : ""}${a.steamMagnitude})` : null
  };
}

/**
 * 极端天气(precip + wind + cold/heat)→ xG 折扣;转 LR 走"恶劣比赛 → 平局率上升、
 * 净进球减少"的常规假设。数据源:context.weather 或 advancedData fixture 层 weather。
 * 缺数据/天气适宜 → dormant。
 */
function signalWeather(prior, fixture, advancedData, context) {
  const weather = context.weather ?? fixtureLayer(advancedData, fixture, "weather");
  if (!weather) return { name: "weather", source: "context.weather", dormant: "no-weather-data" };
  const wm = weatherXgMultiplier(weather);
  if (!wm || wm.multiplier >= 0.95) {
    return { name: "weather", source: "context.weather", dormant: "weather-mild" };
  }
  // 极端天气 → 整体进球下降(multiplier < 1)→ 平局率上升 + 主客胜率下降
  const drawShift = (1 - wm.multiplier) * 0.5;
  const lr = clampLR({
    home: 1 - drawShift / 2,
    draw: 1 + drawShift,
    away: 1 - drawShift / 2
  });
  if (!lr) return { name: "weather", source: "context.weather", dormant: "negligible-shift" };
  return { name: "weather", source: "context.weather", lr, detail: wm.narrative };
}

/**
 * 教练加成:档次(elite/top/.../bad)+ 蜜月期(接手前 15 场)的净 lift。
 * 数据源:context.{home,away}ManagerProfile + context.{home,away}TenureMatches。
 * 通常由 fitManagerProfiles 拟合后塞进 context。
 */
function signalManager(prior, fixture, advancedData, context) {
  const homeMgr = context.homeManagerProfile ?? fixtureLayer(advancedData, fixture, "homeManager");
  const awayMgr = context.awayManagerProfile ?? fixtureLayer(advancedData, fixture, "awayManager");
  if (!homeMgr && !awayMgr) {
    return { name: "manager", source: "context.{home,away}ManagerProfile", dormant: "no-manager-profiles" };
  }
  const homeInfluence = computeManagerInfluence(homeMgr, context.homeTenureMatches);
  const awayInfluence = computeManagerInfluence(awayMgr, context.awayTenureMatches);
  const netLift = homeInfluence.lift - awayInfluence.lift;
  if (Math.abs(netLift) < 0.02) {
    return { name: "manager", source: "context.{home,away}ManagerProfile", dormant: "net-lift-below-floor" };
  }
  const lr = clampLR({
    home: 1 + netLift,
    draw: 1 - Math.abs(netLift) * 0.2,
    away: 1 - netLift
  });
  if (!lr) return { name: "manager", source: "context.{home,away}ManagerProfile", dormant: "neutral" };
  return {
    name: "manager", source: "context.{home,away}ManagerProfile", lr,
    detail: `主${homeInfluence.tier ?? "-"}(${homeInfluence.lift >= 0 ? "+" : ""}${homeInfluence.lift}) vs 客${awayInfluence.tier ?? "-"}(${awayInfluence.lift >= 0 ? "+" : ""}${awayInfluence.lift})`
  };
}

/**
 * 同城/历史宿敌 derby:平局率显著上升,主客胜率压缩。
 * 数据源:fixture.homeTeam/awayTeam 直接命中已注册的 18 个宿敌对 + 可选 context.distanceKm。
 */
function signalDerby(prior, fixture, advancedData, context) {
  if (!fixture?.homeTeam || !fixture?.awayTeam) {
    return { name: "derby", source: "fixture.teams", dormant: "no-team-names" };
  }
  const derby = detectDerby(fixture.homeTeam, fixture.awayTeam, { distanceKm: context.distanceKm });
  if (!derby.isDerby) {
    return { name: "derby", source: "fixture.teams", dormant: "not-a-derby" };
  }
  const lr = clampLR(derbyToLR(derby));
  if (!lr) return { name: "derby", source: "fixture.teams", dormant: "neutral" };
  return { name: "derby", source: "fixture.teams", lr, detail: `${derby.intensity}` };
}

/**
 * 排名压力(争冠/保级/欧战席位/已锁定/摆烂)→ 战力发挥乘子。
 * 数据源:context.homeStandings / awayStandings(由 league-table 拟合后塞)。
 */
function signalStandingsPressure(prior, fixture, advancedData, context) {
  const homeStd = context.homeStandings ?? fixtureLayer(advancedData, fixture, "homeStandings");
  const awayStd = context.awayStandings ?? fixtureLayer(advancedData, fixture, "awayStandings");
  if (!homeStd && !awayStd) {
    return { name: "standings-pressure", source: "context.{home,away}Standings", dormant: "no-standings" };
  }
  const homeProfile = homeStd ? computePressureProfile(homeStd) : null;
  const awayProfile = awayStd ? computePressureProfile(awayStd) : null;
  const homeMult = homeProfile ? pressureToFormMultiplier(homeProfile) : 1;
  const awayMult = awayProfile ? pressureToFormMultiplier(awayProfile) : 1;
  if (Math.abs(homeMult - awayMult) < 0.01) {
    return { name: "standings-pressure", source: "context.{home,away}Standings", dormant: "balanced-pressure" };
  }
  // 主队 mult > 1 → 利主胜;mult < 1(已锁/摆烂)→ 利客胜
  const homeAdvantage = homeMult / awayMult - 1;
  const lr = clampLR({
    home: 1 + homeAdvantage * 0.5,
    draw: 1 - Math.abs(homeAdvantage) * 0.1,
    away: 1 - homeAdvantage * 0.5
  });
  if (!lr) return { name: "standings-pressure", source: "context.{home,away}Standings", dormant: "neutral" };
  const detail = `主${homeProfile?.tier ?? "-"} × 客${awayProfile?.tier ?? "-"}`;
  return { name: "standings-pressure", source: "context.{home,away}Standings", lr, detail };
}

/**
 * 强强对决专项 form(只在双方 Elo ≥ 1600 等"大场子"时有效)。
 * 数据源:context.{home,away}FormProfile(由 computeBigGameForm 产)。
 * 任一队没"大场子"样本 → dormant。
 */
function signalBigGameForm(prior, fixture, advancedData, context) {
  const homeProfile = context.homeFormProfile ?? fixtureLayer(advancedData, fixture, "homeFormProfile");
  const awayProfile = context.awayFormProfile ?? fixtureLayer(advancedData, fixture, "awayFormProfile");
  if (!homeProfile?.bigGameDataAvailable || !awayProfile?.bigGameDataAvailable) {
    return { name: "big-game-form", source: "context.{home,away}FormProfile", dormant: "no-big-game-data" };
  }
  const lr = clampLR(bigGameReadinessLR(homeProfile, awayProfile));
  if (!lr) return { name: "big-game-form", source: "context.{home,away}FormProfile", dormant: "neutral-readiness" };
  return {
    name: "big-game-form", source: "context.{home,away}FormProfile", lr,
    detail: `主大场ppm${homeProfile.bigGamePpm} vs 客${awayProfile.bigGamePpm}`
  };
}

/**
 * 客队跨城/跨洋长途旅行 + 时差 → 客队 form 折扣,主队净优势上升。
 * 数据源:context.homeCity / awayCity(含 lat/lon/timezone)。
 * 短途(<500 km)或缺城市 → dormant。
 */
function signalTravelDistance(prior, fixture, advancedData, context) {
  const homeCity = context.homeCity ?? fixtureLayer(advancedData, fixture, "homeCity");
  const awayCity = context.awayCity ?? fixtureLayer(advancedData, fixture, "awayCity");
  if (!homeCity || !awayCity) {
    return { name: "travel-distance", source: "context.{home,away}City", dormant: "no-city-coordinates" };
  }
  const travel = computeTravelImpact(homeCity, awayCity);
  if (!travel.significant) {
    return { name: "travel-distance", source: "context.{home,away}City", dormant: `short-travel-${travel.note}` };
  }
  const lift = travel.homeAdvantageFromTravel;  // > 0,客队折扣→主队净优势
  const lr = clampLR({
    home: 1 + lift,
    draw: 1 + lift * 0.1,
    away: 1 - lift
  });
  if (!lr) return { name: "travel-distance", source: "context.{home,away}City", dormant: "neutral" };
  return { name: "travel-distance", source: "context.{home,away}City", lr, detail: `${travel.distanceKm}km/${travel.note}` };
}

/**
 * 阵型克制(4-3-3 vs 5-4-1 等):需要 fitFormationMatchups 拟合的 matchup 表 +
 * league baseline,以及双方排出的阵型。任一缺失 → dormant。
 * 数据源:context.{home,away}Formation + context.formationMatchups + context.leagueBaseline。
 */
function signalTacticalMatchup(prior, fixture, advancedData, context) {
  const hF = context.homeFormation ?? fixtureLayer(advancedData, fixture, "homeFormation");
  const aF = context.awayFormation ?? fixtureLayer(advancedData, fixture, "awayFormation");
  const matchups = context.formationMatchups;
  if (!hF || !aF) return { name: "tactical-matchup", source: "context.{home,away}Formation", dormant: "no-formations" };
  if (!matchups) return { name: "tactical-matchup", source: "context.formationMatchups", dormant: "no-matchup-table" };
  const lift = getFormationLift(hF, aF, matchups, context.leagueBaseline);
  if (!lift?.found) return { name: "tactical-matchup", source: "context.formationMatchups", dormant: "no-cell-for-pair" };
  const factor = lift.homeLift ?? 1;
  if (Math.abs(factor - 1) < 0.03) {
    return { name: "tactical-matchup", source: "context.formationMatchups", dormant: "neutral-lift" };
  }
  // factor=1.2 → home LR 1.2;factor=0.8 → home LR 0.8 / away LR ~1.2
  const lr = clampLR({
    home: factor,
    draw: 1 - Math.abs(factor - 1) * 0.15,
    away: 2 - factor
  });
  if (!lr) return { name: "tactical-matchup", source: "context.formationMatchups", dormant: "neutral" };
  return {
    name: "tactical-matchup", source: "context.formationMatchups", lr,
    detail: `${lift.formation.home}vs${lift.formation.away} ${lift.interpretation}(n=${lift.samples})`
  };
}

/**
 * 主裁判 bias:某些裁判主胜率显著偏离联赛 baseline。
 * 数据源:context.refereeProfile(由 fitRefereeProfiles 拟合)+ context.leagueBaseline。
 */
function signalReferee(prior, fixture, advancedData, context) {
  const profile = context.refereeProfile ?? fixtureLayer(advancedData, fixture, "referee");
  const baseline = context.leagueBaseline;
  if (!profile || !baseline) {
    return { name: "referee", source: "context.refereeProfile", dormant: "no-referee-or-baseline" };
  }
  const lr = clampLR(computeRefereeLR(profile, baseline));
  if (!lr) return { name: "referee", source: "context.refereeProfile", dormant: "neutral-or-thin" };
  return { name: "referee", source: "context.refereeProfile", lr, detail: profile.refereeId ?? profile.name ?? null };
}

/**
 * 对手强度调整的 form 差:adjusted PPG 比 raw PPG 更能反映"真实质量"。
 * 输入主客队近期赛 + 对手 Elo(每场)→ 净 adjustedPpg 差转 LR。
 * 数据源:context.homeRecentMatchesWithElo / awayRecentMatchesWithElo(带 opponentElo)。
 */
function signalOpponentStrengthForm(prior, fixture, advancedData, context) {
  const homeMatches = context.homeRecentMatchesWithElo;
  const awayMatches = context.awayRecentMatchesWithElo;
  if (!Array.isArray(homeMatches) || !Array.isArray(awayMatches) || !homeMatches.length || !awayMatches.length) {
    return { name: "opponent-strength-form", source: "context.recentMatchesWithElo", dormant: "no-elo-tagged-recent-matches" };
  }
  const homeAdj = adjustedFormSummary(homeMatches);
  const awayAdj = adjustedFormSummary(awayMatches);
  if (!homeAdj || !awayAdj) return { name: "opponent-strength-form", source: "context.recentMatchesWithElo", dormant: "thin-form" };
  const cmp = compareAdjustedForm(homeAdj, awayAdj);
  if (!cmp || Math.abs(cmp.gap) < 0.4) {  // PPG 净差 < 0.4 视为噪声
    return { name: "opponent-strength-form", source: "context.recentMatchesWithElo", dormant: "gap-below-floor" };
  }
  const k = 0.12;  // 1.5 PPG 净差 ≈ ~1.2 LR
  const fav = Math.exp(Math.max(-0.5, Math.min(0.5, k * cmp.gap)));
  const lr = clampLR({ home: fav, draw: 1, away: 1 / fav });
  if (!lr) return { name: "opponent-strength-form", source: "context.recentMatchesWithElo", dormant: "neutral" };
  return { name: "opponent-strength-form", source: "context.recentMatchesWithElo", lr, detail: cmp.interpretation };
}

/**
 * xG-Chains 进攻链生产力差:近期 build-up + shot 整链 xG 平均的主客差。
 * 数据源:context.homeChainEvents / awayChainEvents(每场带 events 数组,含 isShot/xg/chainLength/completedPasses)。
 */
function signalXgChains(prior, fixture, advancedData, context) {
  const homeMatches = context.homeChainEvents;
  const awayMatches = context.awayChainEvents;
  if (!Array.isArray(homeMatches) || !Array.isArray(awayMatches) || !homeMatches.length || !awayMatches.length) {
    return { name: "xg-chains", source: "context.{home,away}ChainEvents", dormant: "no-chain-event-data" };
  }
  const homeAvg = teamChainXgAverage(homeMatches);
  const awayAvg = teamChainXgAverage(awayMatches);
  if (!homeAvg || !awayAvg) return { name: "xg-chains", source: "context.{home,away}ChainEvents", dormant: "thin-chain-samples" };
  const cmp = compareChainXg(homeAvg, awayAvg);
  if (!cmp || Math.abs(cmp.diff) < 0.2) {  // chainXG 差 < 0.2 视为噪声
    return { name: "xg-chains", source: "context.{home,away}ChainEvents", dormant: "diff-below-floor" };
  }
  const k = 0.25;
  const fav = Math.exp(Math.max(-0.4, Math.min(0.4, k * cmp.diff)));
  const lr = clampLR({ home: fav, draw: 1 - Math.abs(cmp.diff) * 0.05, away: 1 / fav });
  if (!lr) return { name: "xg-chains", source: "context.{home,away}ChainEvents", dormant: "neutral" };
  return { name: "xg-chains", source: "context.{home,away}ChainEvents", lr, detail: cmp.homeProductionEdge };
}

/**
 * Possession-Adjusted xG 风格 matchup:控球率标准化后的 xG-for / xG-against。
 * 数据源:context.homePossMatches / awayPossMatches(每场含 xgFor/xgAgainst/possession)。
 */
function signalPADJxG(prior, fixture, advancedData, context) {
  const homeMatches = context.homePossMatches;
  const awayMatches = context.awayPossMatches;
  if (!Array.isArray(homeMatches) || !Array.isArray(awayMatches) || !homeMatches.length || !awayMatches.length) {
    return { name: "padj-xg", source: "context.{home,away}PossMatches", dormant: "no-possession-data" };
  }
  const homeAvg = teamPossessionAdjustedAverage(homeMatches);
  const awayAvg = teamPossessionAdjustedAverage(awayMatches);
  if (!homeAvg || !awayAvg) return { name: "padj-xg", source: "context.{home,away}PossMatches", dormant: "thin-poss-samples" };
  const cmp = comparePossessionStyles(homeAvg, awayAvg);
  if (!cmp) return { name: "padj-xg", source: "context.{home,away}PossMatches", dormant: "no-comparable-styles" };
  const projectedHome = cmp.projectedHomeXg;
  const projectedAway = cmp.projectedAwayXg;
  const xgDiff = projectedHome - projectedAway;
  if (Math.abs(xgDiff) < 0.25) {
    return { name: "padj-xg", source: "context.{home,away}PossMatches", dormant: "xg-diff-below-floor" };
  }
  const k = 0.20;
  const fav = Math.exp(Math.max(-0.4, Math.min(0.4, k * xgDiff)));
  const lr = clampLR({ home: fav, draw: 1, away: 1 / fav });
  if (!lr) return { name: "padj-xg", source: "context.{home,away}PossMatches", dormant: "neutral" };
  return { name: "padj-xg", source: "context.{home,away}PossMatches", lr, detail: cmp.matchup };
}

/**
 * 定位球专项:双方都 set-piece-specialist → 进球率上升,平局率下降。
 * 数据源:context.homeGoalsByType / awayGoalsByType(每条 { type: "corner"/"open"/... })。
 */
function signalSetPiece(prior, fixture, advancedData, context) {
  const homeGoals = context.homeGoalsByType;
  const awayGoals = context.awayGoalsByType;
  if (!Array.isArray(homeGoals) || !Array.isArray(awayGoals) || homeGoals.length < 5 || awayGoals.length < 5) {
    return { name: "set-piece", source: "context.{home,away}GoalsByType", dormant: "no-goal-type-breakdown" };
  }
  const homeProfile = Object.values(computeSetPieceProfile(homeGoals))[0];
  const awayProfile = Object.values(computeSetPieceProfile(awayGoals))[0];
  if (!homeProfile || !awayProfile) return { name: "set-piece", source: "context.{home,away}GoalsByType", dormant: "no-profiles" };
  const avgSetShare = ((homeProfile.setPieceShare ?? 0.25) + (awayProfile.setPieceShare ?? 0.25)) / 2;
  // 双方 set-piece 高 → 比赛变更"事件多元",平局率下降、决胜概率上升
  // 双方 set-piece 低 → 比赛变化少,平局略上升
  let lr;
  if (avgSetShare > 0.32) {
    lr = clampLR({ home: 1.03, draw: 0.92, away: 1.03 });
  } else if (avgSetShare < 0.20) {
    lr = clampLR({ home: 0.98, draw: 1.05, away: 0.98 });
  } else {
    return { name: "set-piece", source: "context.{home,away}GoalsByType", dormant: "neutral-set-share" };
  }
  if (!lr) return { name: "set-piece", source: "context.{home,away}GoalsByType", dormant: "neutral" };
  return {
    name: "set-piece", source: "context.{home,away}GoalsByType", lr,
    detail: `主${homeProfile.classification} × 客${awayProfile.classification}(set-share avg ${(avgSetShare*100).toFixed(0)}%)`
  };
}

/**
 * 亚盘水位变化(国内博彩 know-how):皇冠/澳门/立博等风向标公司
 * 早盘→晚盘水位 +5pp 升水 = 庄家鼓励下注让球方,反向警示;
 * 让球方降水 5pp = 资金过多,庄家避险,让球方反 dangerous。
 * 数据源:context.asianHandicapWater = { lateHome, lateAway, earlyHome, earlyAway, line } 单家
 *        或 [{bookmaker, ...}] 多家
 */
function signalAsianHandicapWater(prior, fixture, advancedData, context) {
  const water = context.asianHandicapWater ?? fixtureLayer(advancedData, fixture, "asianHandicapWater");
  if (!water) return { name: "asian-handicap-water", source: "context.asianHandicapWater", dormant: "no-water-data" };
  const analysis = Array.isArray(water)
    ? analyzeMultipleBookmakers(water)?.consensus
    : analyzeAsianHandicapWater(water);
  if (!analysis) return { name: "asian-handicap-water", source: "context.asianHandicapWater", dormant: "analysis-empty" };
  const signal = analysis.signal ?? analysis.dominantSignal;
  if (!signal) return { name: "asian-handicap-water", source: "context.asianHandicapWater", dormant: "no-signal" };
  const lrMap = {
    "warn-home":            { home: 0.92, draw: 1.03, away: 1.08 },
    "warn-away":            { home: 1.08, draw: 1.03, away: 0.92 },
    "danger-home":          { home: 0.88, draw: 1.05, away: 1.12 },
    "danger-away":          { home: 1.12, draw: 1.05, away: 0.88 },
    "favorite-strongly-backed": null,
    "favorite-suspicious":  { home: 0.95, draw: 1.05, away: 1.00 },
    "slight-up":            null,
    "slight-down":          null,
    "neutral":              null
  };
  const raw = lrMap[signal];
  if (!raw) return { name: "asian-handicap-water", source: "context.asianHandicapWater", dormant: `weak-signal:${signal}` };
  const lr = clampLR(raw);
  if (!lr) return { name: "asian-handicap-water", source: "context.asianHandicapWater", dormant: "neutral" };
  return { name: "asian-handicap-water", source: "context.asianHandicapWater", lr, detail: signal };
}

const SIGNAL_HANDLERS = [
  signalSeasonPhase,
  signalCompetitionType,
  signalInjury,
  signalH2H,
  signalCleanSheetStreak,
  signalStreak,
  signalFatigue,
  signalRotation,
  signalHomeAwaySplit,
  signalTimeDecayForm,
  signalLineMovement,
  signalWeather,
  signalManager,
  signalDerby,
  signalStandingsPressure,
  signalBigGameForm,
  signalTravelDistance,
  signalTacticalMatchup,
  signalReferee,
  signalOpponentStrengthForm,
  signalXgChains,
  signalPADJxG,
  signalSetPiece,
  signalAsianHandicapWater
];

/** 所有信号名(供消融回测 / 权重调优枚举)。 */
export const SIGNAL_NAMES = [
  "season-phase", "competition-type", "injury", "h2h", "clean-sheet-streak",
  "streak", "fatigue", "rotation", "home-away-split", "time-decay-form", "line-movement",
  "weather", "manager", "derby", "standings-pressure", "big-game-form",
  "travel-distance", "tactical-matchup",
  "referee", "opponent-strength-form", "xg-chains", "padj-xg", "set-piece",
  "asian-handicap-water"
];

/**
 * 收集所有信号的 LR 证据,分 fired / dormant 两类。
 * @param {{disabledSignals?: string[]|Set<string>, signalWeights?: Object}} [opts]
 *   disabledSignals: 这些信号名直接跳过(消融回测用,记为 dormant:disabled)。
 *   signalWeights: { 信号名: w } 对该信号 LR 做幂缩放 lr^w(w<1 弱化, w>1 放大, w=0 等于禁用)。
 */
export function collectFusionEvidence(prior, fixture, advancedData = {}, context = {}, opts = {}) {
  const evidence = [];
  const dormant = [];
  const disabled = opts.disabledSignals instanceof Set ? opts.disabledSignals : new Set(opts.disabledSignals ?? []);
  const weights = opts.signalWeights ?? null;
  for (const handler of SIGNAL_HANDLERS) {
    let result;
    try {
      result = handler(prior, fixture, advancedData, context);
    } catch (err) {
      dormant.push({ name: handler.name, dormant: `error:${err.message}` });
      continue;
    }
    if (result && disabled.has(result.name)) {
      dormant.push({ name: result.name, source: result.source, dormant: "disabled" });
      continue;
    }
    if (result?.lr) {
      const w = weights ? Number(weights[result.name]) : 1;
      const ratio = Number.isFinite(w) && w !== 1 ? scaleLR(result.lr, w) : result.lr;
      if (Number.isFinite(w) && w <= 0) {
        dormant.push({ name: result.name, source: result.source, dormant: "weight-zero" });
        continue;
      }
      evidence.push({ name: result.name, ratio, source: result.source, detail: result.detail ?? null });
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
  const { evidence, dormant } = collectFusionEvidence(prior, fixture, advancedData, context, opts);
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
