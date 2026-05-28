/**
 * Understat 公开数据抓取(纯 JS,无依赖)
 * ──────────────────────────────────────────────────
 * understat.com 在每个比赛页和球队页里把数据**直接嵌入 HTML**,以 JSON.parse(escaped) 形式
 * 暴露在 <script> 标签里:
 *
 *   var shotsData = JSON.parse('\x7B"h":[\x7B...\x5D...');     // 比赛页 shot 数据
 *   var datesData = JSON.parse('\x5B\x7B"id":"...","title":...');  // 球队页所有比赛
 *
 * 我们只需要:
 *   1. fetch HTML
 *   2. 正则提取上面字符串
 *   3. unescape 反转 \xNN → 真字符
 *   4. JSON.parse
 *
 * 覆盖范围:五大联赛 + RFPL(俄超),2014-15 至今每场每 shot 的 xG.
 *
 * URL 形态:
 *   - https://understat.com/league/{EPL,La_liga,Bundesliga,Serie_A,Ligue_1,RFPL}/{年份开始, e.g. 2024}
 *   - https://understat.com/team/{team_slug}/{season_year}
 *   - https://understat.com/match/{match_id}
 *
 * 这条数据**国内访问通**(实测 understat 在国内不需要梯子,服务器在欧洲但 cloudflare 加速)
 *
 * 缓存:D:\football-model-data\understat\<key>.json,TTL 24h(联赛/球队页),6h(比赛页).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

const BASE = "https://understat.com";
const DEFAULT_TTL = 60 * 24;  // 1 day
const MATCH_TTL = 60 * 6;     // 6 hours

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8"
};

const LEAGUE_SLUGS = {
  EPL: "EPL",
  "La Liga": "La_liga",
  "Bundesliga": "Bundesliga",
  "Serie A": "Serie_A",
  "Ligue 1": "Ligue_1",
  "RFPL": "RFPL"
};

/**
 * 抓某联赛某赛季的全部比赛.
 * @param {string} league 联赛名(中文/英文都行,会映射到 slug)
 * @param {number} startYear 赛季起始年(如 2024 = 2024-25)
 * @returns {{ ok, matches, sourceStatus }}
 */
export async function fetchUnderstatLeague(league, startYear, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.UNDERSTAT_ENABLED === "0") {
    return { ok: false, matches: [], warning: "UNDERSTAT_ENABLED=0" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, matches: [], warning: "fetch 不可用" };
  }
  const slug = LEAGUE_SLUGS[league] ?? league;
  const url = `${BASE}/league/${slug}/${startYear}`;
  try {
    const html = await fetchCached(url, fetchImpl, `league-${slug}-${startYear}`, DEFAULT_TTL);
    const datesData = extractEmbeddedJSON(html, "datesData");
    if (!Array.isArray(datesData)) {
      return { ok: false, matches: [], warning: "datesData not found or not array" };
    }
    return {
      ok: true,
      matches: datesData.map((m) => normalizeUnderstatMatch(m, league, startYear))
    };
  } catch (error) {
    return { ok: false, matches: [], error: error.message };
  }
}

/**
 * 抓某场比赛的详细 shot 数据.
 * @param {string|number} matchId  understat 内部 ID
 */
export async function fetchUnderstatMatch(matchId, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.UNDERSTAT_ENABLED === "0") return { ok: false, warning: "UNDERSTAT_ENABLED=0" };
  if (typeof fetchImpl !== "function") return { ok: false, warning: "fetch 不可用" };
  const url = `${BASE}/match/${matchId}`;
  try {
    const html = await fetchCached(url, fetchImpl, `match-${matchId}`, MATCH_TTL);
    const shotsData = extractEmbeddedJSON(html, "shotsData");
    const matchInfo = extractEmbeddedJSON(html, "match_info");
    return {
      ok: true,
      matchId,
      shotsData,
      matchInfo,
      summary: shotsData ? summarizeMatchXG(shotsData) : null
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 抓某球队某赛季的所有比赛.
 */
export async function fetchUnderstatTeam(teamSlug, startYear, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = opts.env ?? process.env;
  if (env.UNDERSTAT_ENABLED === "0") return { ok: false, matches: [], warning: "UNDERSTAT_ENABLED=0" };
  if (typeof fetchImpl !== "function") return { ok: false, matches: [], warning: "fetch 不可用" };
  const url = `${BASE}/team/${teamSlug}/${startYear}`;
  try {
    const html = await fetchCached(url, fetchImpl, `team-${teamSlug}-${startYear}`, DEFAULT_TTL);
    const datesData = extractEmbeddedJSON(html, "datesData");
    const statisticsData = extractEmbeddedJSON(html, "statisticsData");
    return {
      ok: true,
      teamSlug,
      matches: Array.isArray(datesData) ? datesData.map((m) => normalizeUnderstatMatch(m, null, startYear)) : [],
      statistics: statisticsData
    };
  } catch (error) {
    return { ok: false, matches: [], error: error.message };
  }
}

// ───── 公开:HTML 解析工具 ─────

export function extractEmbeddedJSON(html, varName) {
  // 匹配 var <varName> = JSON.parse('<escaped>')
  // <escaped> 是 single-quoted string with \xNN escapes
  const pattern = new RegExp(`var\\s+${varName}\\s*=\\s*JSON\\.parse\\('([\\s\\S]*?)'\\)`, "i");
  const m = String(html).match(pattern);
  if (!m) return null;
  const escaped = m[1];
  const unescaped = unescapeHexString(escaped);
  try {
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

export function unescapeHexString(str) {
  // \xNN → 对应字符;\\xNN → \xNN(转义保留)
  return String(str).replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function normalizeUnderstatMatch(m, league, season) {
  if (!m) return null;
  const home = m.h?.title ?? m.home_team ?? null;
  const away = m.a?.title ?? m.away_team ?? null;
  const homeGoals = m.goals?.h ?? m.home_goals;
  const awayGoals = m.goals?.a ?? m.away_goals;
  const homeXg = m.xG?.h ?? m.home_xg;
  const awayXg = m.xG?.a ?? m.away_xg;
  return {
    id: m.id,
    date: (m.datetime ?? "").slice(0, 10),
    home, away,
    homeGoals: homeGoals == null ? null : Number(homeGoals),
    awayGoals: awayGoals == null ? null : Number(awayGoals),
    homeXg: homeXg == null ? null : Number(homeXg),
    awayXg: awayXg == null ? null : Number(awayXg),
    league, season,
    isResult: Number.isFinite(Number(homeGoals)) && Number.isFinite(Number(awayGoals))
  };
}

export function summarizeMatchXG(shotsData) {
  // shotsData = { h: [...], a: [...] }, 每个 shot 含 xG 字段
  const hShots = Array.isArray(shotsData.h) ? shotsData.h : [];
  const aShots = Array.isArray(shotsData.a) ? shotsData.a : [];
  const sumXG = (arr) => arr.reduce((s, sh) => s + Number(sh.xG || 0), 0);
  return {
    homeShots: hShots.length,
    awayShots: aShots.length,
    homeXG: round(sumXG(hShots)),
    awayXG: round(sumXG(aShots)),
    homeShotsOnTarget: hShots.filter((sh) => /goal|saved/i.test(sh.result || "")).length,
    awayShotsOnTarget: aShots.filter((sh) => /goal|saved/i.test(sh.result || "")).length
  };
}

// ───── 缓存 ─────

async function fetchCached(url, fetchImpl, cacheKey, ttlMinutes) {
  const cacheDir = getDataSubdir("understat");
  const cachePath = join(cacheDir, `${cacheKey}.html`);
  if (existsSync(cachePath)) {
    const age = (Date.now() - statSync(cachePath).mtimeMs) / 60000;
    if (age < ttlMinutes) {
      return readFileSync(cachePath, "utf8");
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    mkdirSync(cacheDir, { recursive: true });
    try { writeFileSync(cachePath, html, "utf8"); } catch { /* best-effort */ }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
