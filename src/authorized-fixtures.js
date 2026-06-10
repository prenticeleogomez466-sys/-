import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getDataSubdir, getExportDir } from "./paths.js";
import { loadFixtures, saveFixtures } from "./fixture-store.js";
import { canonicalTeamName } from "./team-aliases.js";
import { loadEspnResults, ESPN_LEAGUES } from "./espn-results-source.js";
import { withinDays, hasKickedOff } from "./kickoff-time.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();
const SETTLED_API_FOOTBALL = new Set(["FT", "AET", "PEN"]);
const SETTLED_FOOTBALL_DATA = new Set(["FINISHED", "AWARDED"]);

export async function syncAuthorizedFixturesAndResults(date, options = {}) {
  const env = options.env ?? process.env;
  const queryDate = options.resultDate ?? date;
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
      const fixtures = await provider.fetch(queryDate, fetchImpl);
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
  const result = { date, queryDate, sources, existing: fixtureSet.fixtures.length, fetched: fetched.length, matched: merged.matched, updated: merged.updated, added: merged.added, saved: Boolean(saved), path: saved ? join(getDataSubdir("fixtures"), `${date}.json`) : null, skipped: null };
  if (options.writeLog !== false) writeSyncLog(result);
  return result;
}

export function buildAuthorizedProviders(env = process.env, options = {}) {
  const providers = [];
  if (env.OPENLIGADB_ENABLED !== "0") providers.push({ name: "OpenLigaDB", fetch: (date, fetchImpl) => fetchOpenLigaDbMatches(date, fetchImpl, options) });
  // ESPN 赛果(免费、无 key,覆盖日职/瑞超/巴甲/美职/沙特/挪超等竞彩常见联赛)——补 OpenLigaDB(仅德甲)的盲区,
  // 让复盘真正拿到赛果(2026-05-31 修:此前赛果只有德甲专用源、每天抓 0 条 → 283 预测仅 2 条结算)。
  if (env.ESPN_RESULTS_ENABLED !== "0") providers.push({ name: "ESPN", fetch: (date, fetchImpl) => fetchEspnResultsForDate(date, fetchImpl) });
  if (env.API_FOOTBALL_KEY) providers.push({ name: "API-Football", fetch: (date, fetchImpl) => fetchApiFootballFixtures(date, fetchImpl, env.API_FOOTBALL_KEY, options) });
  if (env.FOOTBALL_DATA_ORG_TOKEN) providers.push({ name: "football-data.org", fetch: (date, fetchImpl) => fetchFootballDataOrgMatches(date, fetchImpl, env.FOOTBALL_DATA_ORG_TOKEN) });
  return providers;
}

// ESPN 当日赛果 → 授权 fixture shape(带 result),供 mergeAuthorizedFixtures 按队名匹配回填到预测。
export async function fetchEspnResultsForDate(date, fetchImpl) {
  const loaded = await loadEspnResults({ leagues: Object.keys(ESPN_LEAGUES), from: date, to: date, fetch: fetchImpl });
  if (!loaded?.ok && !(loaded?.matches?.length)) return [];
  return (loaded.matches ?? [])
    .filter((m) => m.date === date && Number.isFinite(Number(m.homeGoals)) && Number.isFinite(Number(m.awayGoals)) && m.home && m.away)
    .map((m, index) => ({
      id: `espn-${date}-${index + 1}`,
      date,
      kickoff: m.kickoff ?? "",
      competition: m.league ?? "ESPN",
      homeTeam: m.home,
      awayTeam: m.away,
      round: "",
      sequence: index + 1,
      source: `espn:${m.league ?? ""}`,
      officialStatus: "espn-final",
      officialFixtureId: null,
      result: { home: Number(m.homeGoals), away: Number(m.awayGoals), halfHome: m.halfHome ?? null, halfAway: m.halfAway ?? null },
    }));
}

export async function fetchOpenLigaDbMatches(date, fetchImpl, options = {}) {
  const season = options.openLigaSeason ?? openLigaSeason(date);
  const shortcuts = String(options.openLigaShortcuts ?? process.env.OPENLIGADB_SHORTCUTS ?? "dfb,bl1,bl2").split(",").map((item) => item.trim()).filter(Boolean);
  const rows = [];
  for (const shortcut of shortcuts) {
    const url = `https://api.openligadb.de/getmatchdata/${encodeURIComponent(shortcut)}/${encodeURIComponent(season)}`;
    const payload = await fetchJson(fetchImpl, url);
    const matches = Array.isArray(payload) ? payload : [];
    rows.push(...matches.filter((row) => localDate(row.matchDateTimeUTC ?? row.matchDateTime) === date).map((row, index) => mapOpenLigaDbMatch(row, date, index)).filter(Boolean));
  }
  return rows;
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
  const now = options.now ?? Date.now();
  const next = existingFixtures.map((fixture) => ({ ...fixture }));
  let matched = 0;
  let updated = 0;
  for (const authorized of authorizedFixtures) {
    const index = next.findIndex((fixture) => sameFixture(fixture, authorized));
    if (index < 0) continue;
    matched += 1;
    const base = next[index];
    const mergedKickoff = base.kickoff || authorized.kickoff;
    // 开赛闸(2026-06-10 审计缺陷):store"开赛前无赛果"不变量必须由 merge 路径自身保证——
    //   此前只有 backfill/detox 单方面清洗,detox 清完 1-2 分钟即被本路径重写复活
    //   (实测 06-09 #2203 阿根廷vs冰岛 kickoff=date-only 未到 23:59,api-football FT 赛果照写)。
    //   未开赛的场即便 authorized.result 存在(可能是日期约束内错配的同对阵另一场)也绝不写入;
    //   闸口径与结算/backfill/detox 同源 hasKickedOff(date-only 取 23:59 宁晚判),
    //   真赛果开赛后由下一轮 sync / backfill 自然回填,绝不提前。
    const kicked = hasKickedOff({ ...base, kickoff: mergedKickoff }, now);
    const merged = { ...base, kickoff: mergedKickoff, competition: base.competition || authorized.competition, round: base.round || authorized.round, source: mergeSource(base.source, authorized.source), officialStatus: authorized.officialStatus, officialFixtureId: authorized.officialFixtureId, result: kicked ? (authorized.result ?? base.result ?? null) : (base.result ?? null) };
    if (JSON.stringify(merged) !== JSON.stringify(base)) updated += 1;
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

function mapOpenLigaDbMatch(row, date, index) {
  const homeTeam = row.team1?.teamName;
  const awayTeam = row.team2?.teamName;
  if (!homeTeam || !awayTeam) return null;
  const fullTime = pickOpenLigaResult(row.matchResults, 2) ?? pickOpenLigaResult(row.matchResults);
  const halfTime = pickOpenLigaResult(row.matchResults, 1);
  return {
    id: `openligadb-${row.matchID ?? index + 1}`,
    date,
    kickoff: kickoffTime(row.matchDateTimeUTC ?? row.matchDateTime),
    competition: row.leagueName ?? "OpenLigaDB",
    homeTeam,
    awayTeam,
    round: row.group?.groupName ?? "",
    sequence: index + 1,
    source: `openligadb:${row.matchID ?? ""}`,
    officialStatus: row.matchIsFinished ? "FINISHED" : "SCHEDULED",
    officialFixtureId: row.matchID ?? null,
    result: row.matchIsFinished && fullTime ? normalizeResult({ home: fullTime.pointsTeam1, away: fullTime.pointsTeam2 }, { home: halfTime?.pointsTeam1, away: halfTime?.pointsTeam2 }) : null
  };
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
  // 2026-05-31:改用全量别名表 canonicalTeamName(中英互通),让 ESPN 英文赛果能匹配中文预测名。
  //   旧 normalizeName 只硬编码拜仁/斯图加特两条别名 → 跨语言赛果匹配恒失败 → 复盘拿不到赛果。
  const cn = (x) => canonicalTeamName(x) || normalizeName(x);
  if (cn(left.homeTeam) !== cn(right.homeTeam) || cn(left.awayTeam) !== cn(right.awayTeam)) return false;
  // ±1 天日期约束(2026-06-10 缺陷#2 立约 ≤2,同日审计收紧为 ≤1):仅队名匹配会把
  //   "同对阵不同日期"的两场当同一场——06-09 墨西哥vs南非热身赛赛果曾被写进 kickoff=06-12
  //   的世界杯小组赛 fixture。跨源同场比赛日最大合法漂移=时区差 1 天(欧美晚场=北京次日凌晨),
  //   ≤2 会放行"恰差 2 天的同对阵热身赛 vs 正赛"错配 → 收紧为 ≤1;改期 ≥2 天的场宁 pending 勿错配。
  //   任一方无日期则不收紧(防误杀)。
  return withinDays(left, right, 1);
}

function kickoffTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function normalizeName(value) {
  const normalized = String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  const aliases = [
    [/^(fc)?bayern|bayernmunchen|拜仁|拜仁慕尼黑|鎷滀粊|鎷滀粊鎱曞凹榛?/, "bayernmunich"],
    [/vfbstuttgart|stuttgart|斯图加特|鏂浘鍔犵壒/, "stuttgart"]
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1] ?? normalized;
}

function pickOpenLigaResult(results = [], resultTypeId = null) {
  const rows = Array.isArray(results) ? results : [];
  if (resultTypeId !== null) return rows.find((row) => Number(row.resultTypeID) === resultTypeId) ?? null;
  return rows.slice().sort((left, right) => Number(right.resultOrderID ?? 0) - Number(left.resultOrderID ?? 0))[0] ?? null;
}

function openLigaSeason(date) {
  const [year, month] = String(date).split("-").map(Number);
  return month >= 7 ? year : year - 1;
}

function localDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${mapped.year}-${mapped.month}-${mapped.day}`;
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
