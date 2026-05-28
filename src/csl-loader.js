/**
 * 中超数据加载器(via fotmob,无专门 GitHub 数据集)
 * ──────────────────────────────────────────────────
 * 2026-05-28 调研:awesome-football / openfootball / FootballData 都不包含
 * 中超历史数据.WebSearch 也没找到专门 GitHub 仓库.
 *
 * 现实方案:fotmob 全球覆盖,包括中超.从 fotmob league/leagues?id=53 抓数据.
 * fotmob 中超联赛 id: 53 (经验值,需要时验证).
 *
 * 用法:
 *   const csl = await loadChineseSuperLeague(season);  // season=2024/2025
 *   csl.matches  // 全部赛季比赛
 *   csl.standings // 当时积分榜
 *
 * 缓存:D:\football-model-data\csl\,TTL 7 天.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

const FOTMOB_BASE = "https://www.fotmob.com/api";
const CSL_LEAGUE_ID = 53;  // 中超 fotmob ID(2024)
const DEFAULT_TTL = 60 * 24 * 7;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Accept": "application/json,text/plain,*/*"
};

export async function loadChineseSuperLeague(season = null, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.CSL_ENABLED === "0") {
    return { ok: false, matches: [], warning: "CSL_ENABLED=0" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, matches: [], warning: "fetch 不可用" };
  }
  const cslLeagueId = Number(env.CSL_FOTMOB_LEAGUE_ID ?? CSL_LEAGUE_ID);

  try {
    const cacheKey = `csl-${cslLeagueId}-${season ?? "current"}`;
    const data = await fetchCached(`${FOTMOB_BASE}/leagues?id=${cslLeagueId}`, fetchImpl, cacheKey, DEFAULT_TTL);
    const matches = extractFotmobLeagueMatches(data);
    const standings = extractFotmobStandings(data);
    return { ok: true, matches, standings, leagueId: cslLeagueId, season };
  } catch (error) {
    return { ok: false, matches: [], error: error.message };
  }
}

export function extractFotmobLeagueMatches(data) {
  const out = [];
  if (!data) return out;
  // fotmob 联赛 API 在 data.matches 或 data.fixtures 下
  const candidates = [
    data.matches?.allMatches,
    data.matches?.matches,
    data.fixtures?.allFixtures,
    data.fixtures,
    data.allMatches,
    data.matches
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) {
      for (const m of list) {
        const home = m.home?.name ?? m.homeName;
        const away = m.away?.name ?? m.awayName;
        if (!home || !away) continue;
        const hg = m.home?.score ?? m.status?.scoreStr?.split("-")?.[0];
        const ag = m.away?.score ?? m.status?.scoreStr?.split("-")?.[1];
        out.push({
          home, away,
          homeGoals: Number(hg),
          awayGoals: Number(ag),
          date: (m.status?.utcTime ?? m.utcTime ?? "").slice(0, 10),
          status: m.status?.finished ? "finished" : "scheduled",
          fotmobId: m.id,
          league: "中超"
        });
      }
      break;
    }
  }
  return out;
}

export function extractFotmobStandings(data) {
  if (!data) return [];
  // fotmob 积分榜在 data.table 或 data.standings
  const candidates = [
    data.table?.[0]?.data?.table?.all,
    data.standings?.table,
    data.table?.all,
    data.standings
  ];
  for (const list of candidates) {
    if (Array.isArray(list) && list.length) {
      return list.map((row) => ({
        team: row.name ?? row.teamName,
        position: row.position ?? row.idx,
        played: row.played,
        wins: row.wins,
        draws: row.draws,
        losses: row.losses,
        goalsScored: row.goals_scored ?? row.goalsScored ?? row.scoresStr,
        points: row.pts ?? row.points
      })).filter((r) => r.team);
    }
  }
  return [];
}

async function fetchCached(url, fetchImpl, cacheKey, ttlMinutes) {
  const cacheDir = getDataSubdir("csl");
  const cachePath = join(cacheDir, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    const age = (Date.now() - statSync(cachePath).mtimeMs) / 60000;
    if (age < ttlMinutes) return JSON.parse(readFileSync(cachePath, "utf8"));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    mkdirSync(cacheDir, { recursive: true });
    try { writeFileSync(cachePath, text, "utf8"); } catch { /* */ }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
