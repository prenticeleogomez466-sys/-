/**
 * OpenFootball 公开数据加载器
 * ──────────────────────────────────────────────────
 * 从 GitHub openfootball/football.json 加载五大联赛历史比赛数据,
 * 用来给 Dixon-Coles / Pi-ratings 增加训练样本(没 API key、无配额)。
 *
 * 数据源:https://github.com/openfootball/football.json
 *   - 英超: en.1
 *   - 英冠: en.2
 *   - 德甲: de.1
 *   - 西甲: es.1
 *   - 意甲: it.1
 *   - 法甲: fr.1
 *
 * 用法:
 *   const matches = await loadOpenFootballMatches(["en.1", "es.1"], ["2024-25", "2023-24"]);
 *   matches: [{ home, away, homeGoals, awayGoals, date, league }, ...]
 *
 * 缓存:D:\football-model-data\openfootball\<league>-<season>.json,TTL 7 天.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

const BASE_URL = "https://raw.githubusercontent.com/openfootball/football.json/master";
const DEFAULT_TTL_MINUTES = 60 * 24 * 7;  // 7 天

export async function loadOpenFootballMatches(leagues = [], seasons = [], opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.OPENFOOTBALL_ENABLED === "0") {
    return { ok: false, matches: [], warning: "OPENFOOTBALL_ENABLED=0" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, matches: [], warning: "fetch 不可用" };
  }
  const ttl = Number(env.OPENFOOTBALL_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
  const allMatches = [];
  const sourceStatus = [];

  for (const league of leagues) {
    for (const season of seasons) {
      try {
        const data = await fetchSeason(league, season, fetchImpl, ttl);
        const matches = extractMatches(data, league, season);
        allMatches.push(...matches);
        sourceStatus.push({ league, season, ok: true, count: matches.length });
      } catch (error) {
        sourceStatus.push({ league, season, ok: false, error: error.message });
      }
    }
  }

  return { ok: allMatches.length > 0, matches: allMatches, sourceStatus };
}

async function fetchSeason(league, season, fetchImpl, ttlMinutes) {
  const cacheKey = `${league}-${season}`;
  const cachePath = join(getDataSubdir("openfootball"), `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    const age = (Date.now() - statSync(cachePath).mtimeMs) / 60000;
    if (age < ttlMinutes) {
      return JSON.parse(readFileSync(cachePath, "utf8"));
    }
  }
  const url = `${BASE_URL}/${season}/${league}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const data = JSON.parse(text);
    mkdirSync(getDataSubdir("openfootball"), { recursive: true });
    try { writeFileSync(cachePath, text, "utf8"); } catch { /* best-effort */ }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractMatches(data, league, season) {
  const out = [];
  if (!data?.matches) return out;
  for (const m of data.matches) {
    const score = m.score?.ft;
    if (!Array.isArray(score) || score.length < 2) continue;
    const home = m.team1?.name ?? m.team1;
    const away = m.team2?.name ?? m.team2;
    if (!home || !away) continue;
    out.push({
      home, away,
      homeGoals: Number(score[0]),
      awayGoals: Number(score[1]),
      date: m.date,
      league, season,
      round: m.round
    });
  }
  return out;
}
