/**
 * Fotmob 公开兜底数据源
 * ──────────────────────────────────────────────────
 * 当 INJURY_SOURCE_URL / LINEUP_SOURCE_URL / XG_SOURCE_URL 都未配置,
 * 而 API_FOOTBALL_KEY 也缺失时,使用 fotmob 的公开 JSON API 作为
 * injury / lineup / xg 三层的最终兜底。
 *
 * 工作流:
 *   1. GET https://www.fotmob.com/api/matches?date=YYYYMMDD
 *      —— 拿当天全球所有比赛索引,文件级缓存(public-cache/fotmob-day-DATE.json)
 *   2. 用 canonicalTeamName 匹配中国彩票 fixture 的主客队
 *   3. 对每场命中,GET https://www.fotmob.com/api/matchDetails?matchId=N
 *      —— 文件级缓存 + 模块级 Map,同一天三层共享同一份 matchDetails
 *   4. 从 matchDetails 中抽取 injuries / lineups / xg 三类
 *
 * 设计原则:
 *   - 任何 fetch/parse 失败都降级为 { ok:false, warning },不抛错阻断
 *   - fotmob API 字段路径会变,extract* 函数对多条已知路径做 best-effort
 *   - 通过 FOTMOB_PUBLIC_ENABLED="0" 可一键禁用
 *   - 通过 PUBLIC_SOURCE_TTL_MINUTES 调缓存(默认 240 分钟)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";
import { canonicalTeamName } from "./team-aliases.js";

const DEFAULT_TTL_MINUTES = 240;
const FOTMOB_BASE = "https://www.fotmob.com/api";

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
  Referer: "https://www.fotmob.com/"
};

// 同进程内 day-index 缓存,避免一次 syncAdvancedFootballData 内
// 三层各调一次 day-index。matchDetails 也走同样的 Map 消重。
const memoryCache = {
  dayIndex: { date: null, payload: null },
  matchDetails: new Map()
};

export async function syncFotmobAllLayers(date, fixtures, fetchImpl, env = process.env) {
  if (env.FOTMOB_PUBLIC_ENABLED === "0") {
    const reason = "FOTMOB_PUBLIC_ENABLED=0";
    return { injuries: emptyLayer(reason), lineups: emptyLayer(reason), xg: emptyLayer(reason) };
  }
  if (typeof fetchImpl !== "function") {
    const reason = "fetch 不可用";
    return { injuries: emptyLayer(reason), lineups: emptyLayer(reason), xg: emptyLayer(reason) };
  }

  const ttlMinutes = Number(env.PUBLIC_SOURCE_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);

  let dayIndex;
  try {
    dayIndex = await getDayIndex(date, fetchImpl, ttlMinutes);
  } catch (error) {
    const reason = `fotmob day-index 失败: ${error.message}`;
    return { injuries: emptyLayer(reason), lineups: emptyLayer(reason), xg: emptyLayer(reason) };
  }

  const matched = matchFixturesToFotmob(fixtures, dayIndex);

  const matchDetailsByFixtureId = new Map();
  await Promise.all(matched.map(async ({ fixture, matchId }) => {
    try {
      const detail = await getMatchDetails(matchId, date, fetchImpl, ttlMinutes);
      matchDetailsByFixtureId.set(fixture.id, detail);
    } catch (error) {
      matchDetailsByFixtureId.set(fixture.id, { __error: error.message });
    }
  }));

  return {
    injuries: buildInjuriesLayer(fixtures, matchDetailsByFixtureId),
    lineups: buildLineupsLayer(fixtures, matchDetailsByFixtureId),
    xg: buildXgLayer(fixtures, matchDetailsByFixtureId)
  };
}

// ───── Day index + match details ─────

async function getDayIndex(date, fetchImpl, ttlMinutes) {
  if (memoryCache.dayIndex.date === date && memoryCache.dayIndex.payload) {
    return memoryCache.dayIndex.payload;
  }
  const cacheKey = `fotmob-day-${date}`;
  const cached = readCache(cacheKey, ttlMinutes);
  if (cached) {
    memoryCache.dayIndex = { date, payload: cached };
    return cached;
  }
  const compactDate = String(date).replaceAll("-", "");
  const url = `${FOTMOB_BASE}/matches?date=${compactDate}`;
  const payload = await fetchJson(fetchImpl, url, DEFAULT_HEADERS);
  writeCache(cacheKey, payload);
  memoryCache.dayIndex = { date, payload };
  return payload;
}

async function getMatchDetails(matchId, date, fetchImpl, ttlMinutes) {
  const key = `${date}:${matchId}`;
  if (memoryCache.matchDetails.has(key)) return memoryCache.matchDetails.get(key);
  const cacheKey = `fotmob-match-${date}-${matchId}`;
  const cached = readCache(cacheKey, ttlMinutes);
  if (cached) {
    memoryCache.matchDetails.set(key, cached);
    return cached;
  }
  const url = `${FOTMOB_BASE}/matchDetails?matchId=${matchId}`;
  const payload = await fetchJson(fetchImpl, url, DEFAULT_HEADERS);
  writeCache(cacheKey, payload);
  memoryCache.matchDetails.set(key, payload);
  return payload;
}

// ───── Fixture matching ─────

export function matchFixturesToFotmob(fixtures, dayIndex) {
  // fotmob day-index shape (best-known):
  //   { leagues: [{ matches: [{ id, home: { name }, away: { name }, status, time }] }] }
  // 也兼容老/新路径变体。
  const allMatches = collectFotmobDayMatches(dayIndex);
  const matched = [];
  for (const fixture of fixtures) {
    const fixHome = canonicalTeamName(fixture.homeTeam);
    const fixAway = canonicalTeamName(fixture.awayTeam);
    if (!fixHome || !fixAway) continue;
    const found = allMatches.find((match) => {
      const matchHome = canonicalTeamName(extractTeamName(match.home));
      const matchAway = canonicalTeamName(extractTeamName(match.away));
      return matchHome === fixHome && matchAway === fixAway;
    });
    if (found?.id) matched.push({ fixture, matchId: found.id });
  }
  return matched;
}

function collectFotmobDayMatches(dayIndex) {
  if (!dayIndex) return [];
  if (Array.isArray(dayIndex.leagues)) {
    return dayIndex.leagues.flatMap((league) => Array.isArray(league.matches) ? league.matches : []);
  }
  if (Array.isArray(dayIndex.matches)) return dayIndex.matches;
  return [];
}

function extractTeamName(side) {
  if (!side) return "";
  if (typeof side === "string") return side;
  return side.name ?? side.longName ?? side.shortName ?? "";
}

// ───── Layer builders ─────

function buildInjuriesLayer(fixtures, matchDetailsByFixtureId) {
  const fixtureData = {};
  let count = 0;
  for (const fixture of fixtures) {
    const detail = matchDetailsByFixtureId.get(fixture.id);
    if (!detail || detail.__error) continue;
    const injuries = extractFotmobInjuries(detail);
    if (injuries.length) {
      fixtureData[fixture.id] = { source: "fotmob", injuries };
      count += 1;
    }
  }
  return {
    ok: count > 0,
    source: "Fotmob public matchDetails",
    count,
    fixtureData,
    warning: count ? null : "Fotmob 未返回伤停信息(可能比赛 fotmob 暂无追踪)"
  };
}

function buildLineupsLayer(fixtures, matchDetailsByFixtureId) {
  const fixtureData = {};
  let count = 0;
  for (const fixture of fixtures) {
    const detail = matchDetailsByFixtureId.get(fixture.id);
    if (!detail || detail.__error) continue;
    const lineups = extractFotmobLineups(detail);
    if (lineups) {
      fixtureData[fixture.id] = { source: "fotmob", ...lineups };
      count += 1;
    }
  }
  return {
    ok: count > 0,
    source: "Fotmob public matchDetails",
    count,
    fixtureData,
    warning: count ? null : "Fotmob 未返回首发/预计阵容(可能赛前 1 小时内才发布)"
  };
}

function buildXgLayer(fixtures, matchDetailsByFixtureId) {
  const fixtureData = {};
  let count = 0;
  for (const fixture of fixtures) {
    const detail = matchDetailsByFixtureId.get(fixture.id);
    if (!detail || detail.__error) continue;
    const xg = extractFotmobXg(detail, fixture);
    if (xg) {
      fixtureData[fixture.id] = { source: "fotmob", ...xg };
      count += 1;
    }
  }
  return {
    ok: count > 0,
    source: "Fotmob public matchDetails",
    count,
    fixtureData,
    warning: count ? null : "Fotmob 未返回 xG(可能比赛未开赛、或冷门联赛未追踪)"
  };
}

// ───── Extractors (best-effort, fotmob 字段路径多次变更) ─────

export function extractFotmobInjuries(detail) {
  if (!detail) return [];
  const candidates = [
    detail?.content?.injuries?.injuries,
    detail?.content?.injuries?.list,
    detail?.content?.injuries,
    detail?.content?.lineup2?.injuries,
    detail?.content?.lineup?.injuries,
    detail?.injuries,
    detail?.matchInjuries
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) {
      return candidate.map(normalizeInjuryRow).filter(Boolean);
    }
  }
  return [];
}

function normalizeInjuryRow(row) {
  if (!row || typeof row !== "object") return null;
  const player = row.player ?? row.name ?? row.playerName ?? row.fullName ?? null;
  if (!player) return null;
  return {
    player: typeof player === "string" ? player : (player.name ?? null),
    team: row.team ?? row.teamName ?? row.club ?? null,
    reason: row.reason ?? row.injury ?? row.injuryReason ?? row.status ?? null,
    expectedReturn: row.expectedReturn ?? row.returnDate ?? row.expectedBack ?? null
  };
}

export function extractFotmobLineups(detail) {
  if (!detail) return null;
  const lineup = detail?.content?.lineup2 ?? detail?.content?.lineup ?? detail?.lineup ?? null;
  if (!lineup) return null;
  const home = pickLineupSide(lineup, "home", 0);
  const away = pickLineupSide(lineup, "away", 1);
  if (!home && !away) return null;
  return {
    confirmed: Boolean(lineup.confirmed ?? lineup.isConfirmed ?? lineup.lineupConfirmed ?? false),
    home,
    away
  };
}

function pickLineupSide(lineup, side, index) {
  const direct = lineup?.[side];
  if (direct) return normalizeLineupSide(direct);
  if (Array.isArray(lineup?.lineup) && lineup.lineup[index]) return normalizeLineupSide(lineup.lineup[index]);
  if (Array.isArray(lineup?.teams) && lineup.teams[index]) return normalizeLineupSide(lineup.teams[index]);
  return null;
}

function normalizeLineupSide(side) {
  if (!side || typeof side !== "object") return null;
  return {
    team: side.team ?? side.teamName ?? side.name ?? null,
    formation: side.formation ?? side.lineupFormation ?? null,
    startXI: collectPlayers(side.startXI ?? side.lineup ?? side.players ?? []),
    bench: collectPlayers(side.bench ?? side.substitutes ?? [])
  };
}

function collectPlayers(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (Array.isArray(entry)) return entry;
    if (entry && Array.isArray(entry.players)) return entry.players;
    if (entry && entry.player) return [entry.player];
    return entry ? [entry] : [];
  }).map((player) => ({
    name: player?.name ?? player?.playerName ?? player?.fullName ?? null,
    number: player?.shirtNumber ?? player?.shirt ?? player?.number ?? null,
    position: player?.role ?? player?.position ?? player?.positionId ?? null
  })).filter((entry) => entry.name);
}

export function extractFotmobXg(detail, fixture) {
  if (!detail) return null;
  // 已开赛/已完赛:从 stats.Periods.All.stats 找 "Expected goals" 行
  const periodStats = detail?.content?.stats?.Periods?.All?.stats
    ?? detail?.content?.stats?.Periods?.["0"]?.stats
    ?? detail?.content?.stats?.stats
    ?? null;
  if (Array.isArray(periodStats)) {
    for (const entry of periodStats) {
      const label = String(entry.key ?? entry.title ?? entry.localizedTitleId ?? "").toLowerCase();
      if (label.includes("expected") && label.includes("goal")) {
        const values = entry.stats ?? entry.values ?? entry.data ?? null;
        const home = Number(Array.isArray(values) ? values[0] : null);
        const away = Number(Array.isArray(values) ? values[1] : null);
        if (Number.isFinite(home) || Number.isFinite(away)) {
          return {
            home: { team: fixture.homeTeam, xg: Number.isFinite(home) ? round3(home) : null },
            away: { team: fixture.awayTeam, xg: Number.isFinite(away) ? round3(away) : null }
          };
        }
      }
    }
  }
  // 赛前:fotmob 一般不暴露官方 xG;尝试 preMatchData 上的 average xG
  const preHome = Number(detail?.content?.preMatchData?.home?.averageXg
    ?? detail?.content?.preMatchData?.homeAverageXg
    ?? detail?.content?.matchFacts?.preMatch?.homeXgAverage);
  const preAway = Number(detail?.content?.preMatchData?.away?.averageXg
    ?? detail?.content?.preMatchData?.awayAverageXg
    ?? detail?.content?.matchFacts?.preMatch?.awayXgAverage);
  if (Number.isFinite(preHome) || Number.isFinite(preAway)) {
    return {
      preMatch: true,
      home: { team: fixture.homeTeam, xg: Number.isFinite(preHome) ? round3(preHome) : null, source: "fotmob preMatchData averageXg" },
      away: { team: fixture.awayTeam, xg: Number.isFinite(preAway) ? round3(preAway) : null, source: "fotmob preMatchData averageXg" }
    };
  }
  return null;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// ───── 缓存 ─────

function cacheDir() {
  return getDataSubdir("public-cache");
}

function readCache(key, ttlMinutes) {
  const path = join(cacheDir(), `${key}.json`);
  if (!existsSync(path)) return null;
  const ageMinutes = (Date.now() - statSync(path).mtimeMs) / 60000;
  if (ageMinutes >= ttlMinutes) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeCache(key, payload) {
  if (payload == null) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), `${key}.json`), `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    // best-effort,缓存写不上不阻断
  }
}

// ───── HTTP ─────

async function fetchJson(fetchImpl, url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 140)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

// ───── 公共工具 ─────

function emptyLayer(warning) {
  return { ok: false, source: "Fotmob public matchDetails", count: 0, fixtureData: {}, warning };
}

// Test hook: 允许测试清空内存缓存
export function __resetFotmobCacheForTests() {
  memoryCache.dayIndex = { date: null, payload: null };
  memoryCache.matchDetails.clear();
}
