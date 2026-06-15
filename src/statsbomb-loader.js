/**
 * StatsBomb Open Data 加载器
 * ──────────────────────────────────────────────────
 * github.com/statsbomb/open-data: MIT 开源 event-level 数据.
 * 免费部分覆盖:
 *   - 世界杯(男/女)2018/2022 全部 64+ 场
 *   - 欧冠 2019-20 决赛阶段
 *   - 美超 MLS(部分)
 *   - Arsenal Invincibles 2003-04
 *   - 等等
 *
 * 数据格式:每场比赛一个 JSON,包含逐 event(传球/射门/犯规/...).
 *
 * 用途:
 *   - 算 event-level xG(每脚射门有 xG 值)
 *   - 推导球员级实力(每个球员的关键 event 频率)
 *   - 补充 fixture-store 历史样本
 *
 * 注意:这是历史训练数据,不是 live 数据.对当前 fixtures 没直接用,
 *      但能给 DC/Pi/ensemble 提供更深训练样本.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

const BASE_URL = "https://raw.githubusercontent.com/statsbomb/open-data/master/data";
const DEFAULT_TTL_DAYS = 90;

/**
 * 加载某场比赛的完整 events(逐脚记录).
 * @param {number|string} matchId
 */
/**
 * 加载某竞赛某赛季的比赛列表.
 * @param {number} competitionId  competition id (如 11 = La Liga)
 * @param {number} seasonId  season id
 */
export async function fetchStatsbombMatches(competitionId, seasonId, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.STATSBOMB_ENABLED === "0") return { ok: false, warning: "STATSBOMB_ENABLED=0" };
  if (typeof fetchImpl !== "function") return { ok: false, warning: "fetch 不可用" };
  const url = `${BASE_URL}/matches/${competitionId}/${seasonId}.json`;
  try {
    const data = await fetchCached(`matches-${competitionId}-${seasonId}`, fetchImpl, url, DEFAULT_TTL_DAYS);
    if (!Array.isArray(data)) return { ok: false, reason: "not-an-array" };
    return {
      ok: true,
      competitionId, seasonId,
      matches: data.map(normalizeMatchRow)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function normalizeMatchRow(m) {
  return {
    matchId: m.match_id,
    date: m.match_date,
    competition: m.competition?.competition_name,
    season: m.season?.season_name,
    home: m.home_team?.home_team_name,
    away: m.away_team?.away_team_name,
    homeGoals: Number(m.home_score),
    awayGoals: Number(m.away_score),
    homeManagerName: m.home_team?.managers?.[0]?.name,
    awayManagerName: m.away_team?.managers?.[0]?.name
  };
}

/**
 * 一场 events 总结:
 *   - 双队 xG 总和
 *   - 射门次数
 *   - 关键传球
 *   - 黄牌 / 红牌
 */
export function summarizeMatchEvents(events) {
  const home = { xg: 0, shots: 0, sot: 0, passes: 0, keyPasses: 0, yellows: 0, reds: 0 };
  const away = { xg: 0, shots: 0, sot: 0, passes: 0, keyPasses: 0, yellows: 0, reds: 0 };
  const teams = new Set();
  for (const e of events) {
    if (!e?.team?.name) continue;
    teams.add(e.team.name);
  }
  const teamList = [...teams];
  const homeTeam = teamList[0];  // 简化:第一个出现的视为主队(真用 metadata 区分)
  const awayTeam = teamList[1];

  for (const e of events) {
    if (!e?.team?.name) continue;
    const target = e.team.name === homeTeam ? home : e.team.name === awayTeam ? away : null;
    if (!target) continue;
    const type = e.type?.name ?? "";
    if (type === "Shot") {
      target.shots += 1;
      const xg = Number(e.shot?.statsbomb_xg);
      if (Number.isFinite(xg)) target.xg += xg;
      const outcome = e.shot?.outcome?.name;
      if (["Goal", "Saved", "Saved To Post", "Saved Off T"].includes(outcome)) target.sot += 1;
    } else if (type === "Pass") {
      target.passes += 1;
      if (e.pass?.shot_assist || e.pass?.goal_assist) target.keyPasses += 1;
    } else if (type === "Foul Committed" || type === "Bad Behaviour") {
      const card = e.foul_committed?.card?.name ?? e.bad_behaviour?.card?.name;
      if (card === "Yellow Card") target.yellows += 1;
      if (card === "Red Card") target.reds += 1;
    }
  }

  return {
    homeTeam, awayTeam,
    home: { ...home, xg: round(home.xg) },
    away: { ...away, xg: round(away.xg) }
  };
}

/**
 * 从一组 events 提取 fixture-store 兼容的 result rows.
 */
export async function loadStatsbombSeasonForTraining(competitionId, seasonId, opts = {}) {
  const list = await fetchStatsbombMatches(competitionId, seasonId, opts);
  if (!list.ok) return list;
  return {
    ok: true,
    competitionId, seasonId,
    trainingRows: list.matches
      .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
      .map((m) => ({
        home: m.home,
        away: m.away,
        homeGoals: m.homeGoals,
        awayGoals: m.awayGoals,
        date: m.date,
        league: m.competition ?? "statsbomb"
      }))
  };
}

async function fetchCached(cacheKey, fetchImpl, url, ttlDays) {
  const cacheDir = getDataSubdir("statsbomb");
  const cachePath = join(cacheDir, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    const ageDays = (Date.now() - statSync(cachePath).mtimeMs) / 86400000;
    if (ageDays < ttlDays) return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    mkdirSync(cacheDir, { recursive: true });
    try { writeFileSync(cachePath, text, "utf8"); } catch {}
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
