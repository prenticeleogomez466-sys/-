/**
 * Evidence Collector 统一汇总所有 evidence 模块
 * ──────────────────────────────────────────────────
 * 单点入口:输入 fixture + 上下文(advanced data / profiles / standings 等),
 * 输出所有 evidence 模块产出的 LR 列表,直接喂给 bayesian-belief-update.
 *
 * 集成的 evidence 源:
 *   - streak (近期连胜/连败)
 *   - derby (同城/历史宿敌)
 *   - referee bias
 *   - schedule fatigue
 *   - travel distance
 *   - weather adjustment
 *   - manager effect
 *   - standings pressure
 *   - big-game form
 *   - line movement (sharp money / steam / reverse)
 *
 * 每个 module 返回 0 或 1 个 LR,collector 汇总成数组.
 */

import { detectStreak, streakToLR } from "./streak-detector.js";
import { detectDerby, derbyToLR } from "./derby-intensity.js";
import { computeRefereeLR } from "./referee-bias-model.js";
import { compareFatigue } from "./schedule-fatigue-model.js";
import { computeTravelImpact } from "./travel-distance-model.js";
import { weatherXgMultiplier } from "./weather-adjusted-xg.js";
import { computeManagerInfluence } from "./manager-effect-model.js";
import { computePressureProfile, pressureToFormMultiplier } from "./standings-pressure.js";
import { bigGameReadinessLR } from "./big-game-form.js";

/**
 * @param {Object} context  所有可用的上下文数据,结构灵活
 *   fixture: { homeTeam, awayTeam, date, league, kickoffTime }
 *   homeRecent / awayRecent: 近期比赛
 *   refereeProfile / leagueBaseline
 *   homeManagerProfile / awayManagerProfile + tenureMatches
 *   homeStandings / awayStandings
 *   weather
 *   homeCity / awayCity (含 lat/lon/timezone)
 *   homeFormProfile / awayFormProfile (big-game 形式)
 *   lineMovementSignal: "sharp-money-home" / "reverse-line-home" / ...
 *   marketBalanceWarn / mustWin / derby
 *   distanceKm: derby detection 用
 * @returns {Array<{ name, ratio, source }>}
 */
export function collectAllEvidence(context = {}) {
  const evidence = [];

  // 1. Streak (home + away)
  if (Array.isArray(context.homeRecent) && context.homeRecent.length >= 2) {
    const streak = detectStreak(context.homeRecent);
    if (streak.length >= 3) {
      const lr = streakToLR(streak);
      if (lr) evidence.push({ name: `home-streak-${streak.type}-${streak.length}`, ratio: lr, source: "streak-home" });
    }
  }
  if (Array.isArray(context.awayRecent) && context.awayRecent.length >= 2) {
    const streak = detectStreak(context.awayRecent);
    if (streak.length >= 3) {
      const lr = streakToLR(streak);
      if (lr) {
        // 反向(客队 winning streak → 利客胜)
        evidence.push({
          name: `away-streak-${streak.type}-${streak.length}`,
          ratio: { home: lr.away, draw: lr.draw, away: lr.home },
          source: "streak-away"
        });
      }
    }
  }

  // 2. Derby
  if (context.fixture?.homeTeam && context.fixture?.awayTeam) {
    const derby = detectDerby(context.fixture.homeTeam, context.fixture.awayTeam, { distanceKm: context.distanceKm });
    if (derby.isDerby) {
      const lr = derbyToLR(derby);
      if (lr) evidence.push({ name: `derby-${derby.intensity}`, ratio: lr, source: "derby" });
    }
  }

  // 3. Referee
  if (context.refereeProfile && context.leagueBaseline) {
    const lr = computeRefereeLR(context.refereeProfile, context.leagueBaseline);
    if (lr) evidence.push({ name: "referee-bias", ratio: lr, source: "referee" });
  }

  // 4. Fatigue
  if (context.homePrevDate && context.awayPrevDate && context.matchDate) {
    const fatigue = compareFatigue(context.homePrevDate, context.awayPrevDate, context.matchDate);
    if (fatigue.significant) {
      const lift = fatigue.homeAdvantageFromFatigue - 1;
      evidence.push({
        name: lift > 0 ? "home-rested-vs-tired-away" : "home-tired-vs-rested-away",
        ratio: {
          home: 1 + lift * 0.5,
          draw: 1 - Math.abs(lift) * 0.1,
          away: 1 - lift * 0.5
        },
        source: "fatigue"
      });
    }
  }

  // 5. Travel
  if (context.homeCity && context.awayCity) {
    const travel = computeTravelImpact(context.homeCity, context.awayCity);
    if (travel.significant) {
      evidence.push({
        name: `away-travel-${travel.note}`,
        ratio: {
          home: 1 + travel.homeAdvantageFromTravel,
          draw: 1,
          away: 1 - travel.homeAdvantageFromTravel
        },
        source: "travel"
      });
    }
  }

  // 6. Weather
  if (context.weather) {
    const wm = weatherXgMultiplier(context.weather);
    if (wm.multiplier < 0.95) {
      // 极端天气 → 平局率上升
      const drawShift = (1 - wm.multiplier) * 0.5;
      evidence.push({
        name: `weather-${wm.factors.map((f) => f.name).join("-")}`,
        ratio: { home: 1 - drawShift / 2, draw: 1 + drawShift, away: 1 - drawShift / 2 },
        source: "weather"
      });
    }
  }

  // 7. Manager(主 vs 客)
  if (context.homeManagerProfile || context.awayManagerProfile) {
    const homeInfluence = computeManagerInfluence(context.homeManagerProfile, context.homeTenureMatches);
    const awayInfluence = computeManagerInfluence(context.awayManagerProfile, context.awayTenureMatches);
    const netLift = homeInfluence.lift - awayInfluence.lift;
    if (Math.abs(netLift) >= 0.02) {
      evidence.push({
        name: netLift > 0 ? "home-manager-edge" : "away-manager-edge",
        ratio: { home: 1 + netLift, draw: 1, away: 1 - netLift },
        source: "manager"
      });
    }
  }

  // 8. Standings pressure
  if (context.homeStandings) {
    const profile = computePressureProfile(context.homeStandings);
    const mult = pressureToFormMultiplier(profile);
    if (Math.abs(mult - 1) > 0.01) {
      const lift = mult - 1;
      evidence.push({
        name: `home-${profile.tier}`,
        ratio: { home: 1 + lift, draw: 1, away: 1 - lift },
        source: "standings-pressure"
      });
    }
  }
  if (context.awayStandings) {
    const profile = computePressureProfile(context.awayStandings);
    const mult = pressureToFormMultiplier(profile);
    if (Math.abs(mult - 1) > 0.01) {
      const lift = mult - 1;
      evidence.push({
        name: `away-${profile.tier}`,
        ratio: { home: 1 - lift, draw: 1, away: 1 + lift },
        source: "standings-pressure"
      });
    }
  }

  // 9. Big-game form
  if (context.homeFormProfile && context.awayFormProfile) {
    const lr = bigGameReadinessLR(context.homeFormProfile, context.awayFormProfile);
    if (lr) evidence.push({ name: "big-game-readiness", ratio: lr, source: "big-game-form" });
  }

  // 10. Line movement (sharp signal already directly available)
  if (context.lineMovementSignal) {
    const lr = mapLineMovementToLR(context.lineMovementSignal);
    if (lr) evidence.push({ name: context.lineMovementSignal, ratio: lr, source: "line-movement" });
  }

  return evidence;
}

function mapLineMovementToLR(signal) {
  // 把 line-movement 模块的离散信号转 LR
  const map = {
    "sharp-money-home": { home: 1.20, draw: 0.95, away: 0.90 },
    "sharp-money-away": { home: 0.90, draw: 0.95, away: 1.20 },
    "steam-home":       { home: 1.30, draw: 0.92, away: 0.85 },
    "steam-away":       { home: 0.85, draw: 0.92, away: 1.30 },
    "reverse-line-home":{ home: 1.40, draw: 0.92, away: 0.78 },
    "reverse-line-away":{ home: 0.78, draw: 0.92, away: 1.40 }
  };
  return map[signal] ?? null;
}

/**
 * 一键应用所有 evidence:接 prior + context → posterior.
 */
export function applyAllEvidenceToProbabilities(prior, context) {
  const evidence = collectAllEvidence(context);
  if (!evidence.length) return { posterior: prior, evidenceCount: 0, evidence };
  // 直接用 log-odds 累加(同 bayesian-belief-update)
  const eps = 1e-9;
  let logProb = {
    home: Math.log(Math.max(eps, prior.home)),
    draw: Math.log(Math.max(eps, prior.draw)),
    away: Math.log(Math.max(eps, prior.away))
  };
  for (const ev of evidence) {
    logProb.home += Math.log(Math.max(eps, ev.ratio.home));
    logProb.draw += Math.log(Math.max(eps, ev.ratio.draw));
    logProb.away += Math.log(Math.max(eps, ev.ratio.away));
  }
  const maxL = Math.max(logProb.home, logProb.draw, logProb.away);
  const exps = {
    home: Math.exp(logProb.home - maxL),
    draw: Math.exp(logProb.draw - maxL),
    away: Math.exp(logProb.away - maxL)
  };
  const total = exps.home + exps.draw + exps.away;
  return {
    prior,
    posterior: {
      home: round(exps.home / total),
      draw: round(exps.draw / total),
      away: round(exps.away / total)
    },
    evidenceCount: evidence.length,
    evidence
  };
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
