/**
 * Fusion Context Builder (V 档 — 内部数据源装配)
 * ────────────────────────────────────────────────────────────
 * 信号融合层 (signal-fusion-layer) 里的 h2h / clean-sheet-streak / streak
 * 等信号需要 match-history 数据。这份数据**不需要外部 API** —— 仓库自己的
 * 历史 fixture store(带 result 的场次)就够算。本模块从历史赛果装配出
 * 每场比赛的 fusionContext,接进 recommendFixtures 后,赛果一累积信号就自动激活。
 *
 * 防数据泄漏:loadHistoricalResults({ beforeDate }) 只收集**早于**当前比赛日的赛果,
 * 绝不让"未来"结果污染当场预测。
 *
 * 当前(2026-05-29)历史 store 仅 1 场带赛果 → 装配结果几乎为空,但逻辑正确、
 * 有测试,数据累积后自动产出真实 H2H / 近期赛果 / 连胜连败。
 */

import { listFixtureDates, loadFixtures } from "./fixture-store.js";
import { canonicalTeamName } from "./team-aliases.js";

function wonLabel(goalsFor, goalsAgainst) {
  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";
  return "D";
}

/**
 * 跨所有日期收集带赛果的历史 fixture,按时间正序。
 * @param {{ beforeDate?: string }} opts beforeDate 给定时只收严格早于它的赛果(防泄漏)
 */
export function loadHistoricalResults(opts = {}) {
  const { beforeDate } = opts;
  const out = [];
  let dates;
  try {
    dates = listFixtureDates();
  } catch {
    return out;
  }
  for (const date of dates) {
    if (beforeDate && date >= beforeDate) continue;
    let set;
    try {
      set = loadFixtures(date);
    } catch {
      continue;
    }
    for (const fx of set.fixtures || []) {
      const home = Number(fx.result?.home);
      const away = Number(fx.result?.away);
      if (!Number.isFinite(home) || !Number.isFinite(away)) continue;
      out.push({
        date: fx.date || date,
        homeTeam: fx.homeTeam,
        awayTeam: fx.awayTeam,
        homeCanon: canonicalTeamName(fx.homeTeam),
        awayCanon: canonicalTeamName(fx.awayTeam),
        homeGoals: home,
        awayGoals: away
      });
    }
  }
  return out;
}

/** 两队历史交手(任意主客),映射成 analyzeH2H 需要的 {date,homeTeam,awayTeam,homeGoals,awayGoals}。*/
export function h2hMatchesFor(history, homeTeam, awayTeam) {
  if (!Array.isArray(history)) return [];
  const a = canonicalTeamName(homeTeam);
  const b = canonicalTeamName(awayTeam);
  return history
    .filter((m) => (m.homeCanon === a && m.awayCanon === b) || (m.homeCanon === b && m.awayCanon === a))
    .map((m) => ({ date: m.date, homeTeam: m.homeTeam, awayTeam: m.awayTeam, homeGoals: m.homeGoals, awayGoals: m.awayGoals }));
}

/**
 * 单队近期赛果,**最近在前**,team 视角:{ date, goalsFor, goalsAgainst, won }。
 * clean-sheet-streak 直接吃此序;streak-detector 需最近在末尾,由 handler 反转。
 */
export function recentMatchesFor(history, team, limit = 10) {
  if (!Array.isArray(history)) return [];
  const t = canonicalTeamName(team);
  return history
    .filter((m) => m.homeCanon === t || m.awayCanon === t)
    .map((m) => {
      const isHome = m.homeCanon === t;
      const goalsFor = isHome ? m.homeGoals : m.awayGoals;
      const goalsAgainst = isHome ? m.awayGoals : m.homeGoals;
      // venue 标签供 home-away-split 信号区分主客场表现;其余信号忽略此字段,向后兼容。
      return { date: m.date, venue: isHome ? "home" : "away", goalsFor, goalsAgainst, won: wonLabel(goalsFor, goalsAgainst) };
    })
    .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0))
    .slice(0, limit);
}

/** 为单场比赛装配 fusionContext。history 为空时返回 {}(融合层据此走 dormant)。*/
export function buildFusionContext(fixture, history, opts = {}) {
  if (!fixture || !Array.isArray(history) || !history.length) return {};
  const limit = opts.recentLimit ?? 10;
  return {
    h2hMatches: h2hMatchesFor(history, fixture.homeTeam, fixture.awayTeam),
    homeRecentMatches: recentMatchesFor(history, fixture.homeTeam, limit),
    awayRecentMatches: recentMatchesFor(history, fixture.awayTeam, limit)
  };
}
