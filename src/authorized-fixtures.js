import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { loadFixtures, saveFixtures } from "./fixture-store.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = join(rootDir, "data", "exports");
const SETTLED_API_FOOTBALL = new Set(["FT", "AET", "PEN"]);
const SETTLED_FOOTBALL_DATA = new Set(["FINISHED", "AWARDED"]);

export async function syncAuthorizedFixturesAndResults(date, options = {}) {
  const env = options.env ?? process.env;
  const providers = buildAuthorizedProviders(env, options);
  if (!providers.length) {
    if (options.strict) throw new Error("缺少赛程/赛果授权源：请配置 API_FOOTBALL_KEY、FOOTBALL_DATA_ORG_TOKEN 或 SPORTMONKS_API_TOKEN");
    const result = emptySyncResult(date, "未配置授权赛程/赛果源，已跳过");
    if (options.writeLog !== false) writeSyncLog(result);
    return result;
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch，无法同步授权赛程/赛果源");
  const fetched = [];
  const sources = [];
  for (const provider of providers) {
    try {
      const fixtures = await provider.fetch(date, fetchImpl);
      fetched.push(...fixtures);
      sources.push({ name: provider.name, ok: true, fetched: fixtures.length, error: null });
    } catch (error) {
      sources.push({ name: provider.name, ok: false, fetched: 0, error: error.message });
      if (options.strict) throw error;
    }
  }
  const fixtureSet = loadFixtures(date);
  const merged = mergeAuthorizedFixtures(fixtureSet.fixtures, fetched, { addNew: options.addNew });
  let saved = null;
  if (options.save !== false && (merged.updated > 0 || merged.added > 0)) {
    saved = saveFixtures(date, merged.fixtures, { source: mergeSource(fixtureSet.source, sources.filter((source) => source.ok).map((source) => source.name).join("+")) });
  }
  const result = { date, sources, existing: fixtureSet.fixtures.length, fetched: fetched.length, matched: merged.matched, updated: merged.updated, added: merged.added, saved: Boolean(saved), path: saved ? join(rootDir, "data", "fixtures", `${date}.json`) : null, skipped: null };
  if (options.writeLog !== false) writeSyncLog(result);
  return result;
}

export function buildAuthorizedProviders(env = process.env, options = {}) {
  const providers = [];
  if (env.API_FOOTBALL_KEY) providers.push({ name: "API-Football", fetch: (date, fetchImpl) => fetchApiFootballFixtures(date, fetchImpl, env.API_FOOTBALL_KEY, options) });
  if (env.FOOTBALL_DATA_ORG_TOKEN) providers.push({ name: "football-data.org", fetch: (date, fetchImpl) => fetchFootballDataOrgMatches(date, fetchImpl, env.FOOTBALL_DATA_ORG_TOKEN) });
  return providers;
}

export async function fetchApiFootballFixtures(date, fetchImpl, apiKey, options = {}) {
  const url = new URL("https://v3.football.api-sports.io/fixtures");
  url.searchParams.set("date", date);
  url.searchParams.set("timezone", options.timezone ?? "Asia/Shanghai");
  const payload = await fetchJson(fetchImpl, url, { "x-apisports-key": apiKey });
  return (Array.isArray(payload.response) ? payload.response : []).map((row, index) => mapApiFootballFixture(row, date, index)).filter(Boolean);
}

export async function fetchFootballDataOrgMatches(date, fetchImpl, token) {
  const url = new URL("https://api.football-data.org/v4/matches");
  url.searchParams.set("dateFrom", date);
  url.searchParams.set("dateTo", date);
  const payload = await fetchJson(fetchImpl, url, { "X-Auth-Token": token });
  return (Array.isArray(payload.matches) ? payload.matches : []).map((row, index) => mapFootballDataOrgMatch(row, date, index)).filter(Boolean);
}

export function mergeAuthorizedFixtures(existingFixtures, authorizedFixtures, options = {}) {
  const next = existingFixtures.map((fixture) => ({ ...fixture }));
  let matched = 0;
  let updated = 0;
  for (const authorized of authorizedFixtures) {
    const index = next.findIndex((fixture) => sameFixture(fixture, authorized));
    if (index < 0) continue;
    matched += 1;
    const merged = { ...next[index], kickoff: next[index].kickoff || authorized.kickoff, competition: next[index].competition || authorized.competition, round: next[index].round || authorized.round, source: mergeSource(next[index].source, authorized.source), officialStatus: authorized.officialStatus, officialFixtureId: authorized.officialFixtureId, result: authorized.result ?? next[index].result ?? null };
    if (JSON.stringify(merged) !== JSON.stringify(next[index])) updated += 1;
    next[index] = merged;
  }
  let added = 0;
  if (options.addNew) {
    for (const authorized of authorizedFixtures) {
      if (next.some((fixture) => sameFixture(fixture, authorized))) continue;
      next.push({ ...authorized, marketType: "authorized-fixture" });
      added += 1;
    }
  }
  return { fixtures: next, matched, updated, added };
}

function mapApiFootballFixture(row, date, index) {
  const homeTeam = row.teams?.home?.name;
  const awayTeam = row.teams?.away?.name;
  if (!homeTeam || !awayTeam) return null;
  const status = row.fixture?.status?.short ?? "";
  return { id: `api-football-${row.fixture?.id ?? index + 1}`, date, kickoff: kickoffTime(row.fixture?.date), competition: row.league?.name ?? "Unknown", homeTeam, awayTeam, round: row.league?.round ?? "", sequence: index + 1, source: `api-football:${row.fixture?.id ?? ""}`, officialStatus: status, officialFixtureId: row.fixture?.id ?? null, result: SETTLED_API_FOOTBALL.has(status) ? normalizeResult(row.goals, row.score?.halftime) : null };
}

function mapFootballDataOrgMatch(row, date, index) {
  const homeTeam = row.homeTeam?.name;
  const awayTeam = row.awayTeam?.name;
  if (!homeTeam || !awayTeam) return null;
  return { id: `football-data-org-${row.id ?? index + 1}`, date, kickoff: kickoffTime(row.utcDate), competition: row.competition?.name ?? "Unknown", homeTeam, awayTeam, round: row.matchday ? `第${row.matchday}轮` : "", sequence: index + 1, source: `football-data-org:${row.id ?? ""}`, officialStatus: row.status ?? "", officialFixtureId: row.id ?? null, result: SETTLED_FOOTBALL_DATA.has(row.status) ? normalizeResult(row.score?.fullTime, row.score?.halfTime) : null };
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const response = await fetchImpl(String(url), { headers: { "User-Agent": "football-ai-copilot/authorized-fixtures", ...headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text);
}

function normalizeResult(fullTime = {}, halfTime = {}) {
  const home = Number(fullTime.home);
  const away = Number(fullTime.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  const halfHome = Number(halfTime?.home);
  const halfAway = Number(halfTime?.away);
  return { home, away, halfHome: Number.isFinite(halfHome) ? halfHome : null, halfAway: Number.isFinite(halfAway) ? halfAway : null };
}

function sameFixture(left, right) {
  if (left.officialFixtureId && right.officialFixtureId && String(left.officialFixtureId) === String(right.officialFixtureId)) return true;
  return normalizeName(left.homeTeam) === normalizeName(right.homeTeam) && normalizeName(left.awayTeam) === normalizeName(right.awayTeam);
}

function kickoffTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function mergeSource(left, right) {
  return [...new Set([left, right].flatMap((item) => String(item || "").split("+")).filter(Boolean))].join("+");
}

function emptySyncResult(date, skipped) {
  return { date, sources: [], existing: loadFixtures(date).fixtures.length, fetched: 0, matched: 0, updated: 0, added: 0, saved: false, path: null, skipped };
}

function writeSyncLog(result) {
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, `authorized-fixtures-results-${result.date}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
