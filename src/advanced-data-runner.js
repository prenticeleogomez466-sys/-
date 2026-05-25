import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { getExportDir } from "./paths.js";
import { loadFixtures } from "./fixture-store.js";
import { saveAdvancedData } from "./advanced-data-store.js";
import { findMarketSnapshot, loadMarketSnapshots } from "./market-data-store.js";
import { fetchAuthorizedFixtureLayer } from "./authorized-source-fetcher.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

const FOOTBALL_DATA_LEAGUES = "E0,E1,E2,E3,EC,SC0,SC1,N1,D1,D2,I1,I2,SP1,SP2,F1,F2,P1,B1,T1,G1";

export async function syncAdvancedFootballData(date, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const fixtureSet = loadFixtures(date);
  const result = {
    date,
    layers: {},
    fixtures: fixtureSet.fixtures.map((fixture) => ({ fixtureId: fixture.id, sequence: fixture.sequence, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam, data: {} }))
  };

  result.layers.form = await syncFootballDataCoUkForm(date, fixtureSet.fixtures, fetchImpl, env);
  result.layers.elo = await syncEloRatings(fixtureSet.fixtures, fetchImpl, env);
  const apiFootballFixtures = await syncApiFootballFixtureIndex(date, fixtureSet.fixtures, fetchImpl, env);
  result.layers.injuries = await syncInjuries(date, fixtureSet.fixtures, fetchImpl, env, apiFootballFixtures);
  result.layers.lineups = await syncLineups(date, fixtureSet.fixtures, fetchImpl, env, apiFootballFixtures);
  result.layers.xg = await syncXg(date, fixtureSet.fixtures, fetchImpl, env, apiFootballFixtures, result.layers.form);
  result.layers.weather = await syncOpenMeteoWeather(date, fixtureSet.fixtures, fetchImpl, env);
  result.layers.news = await syncGdeltNews(date, fixtureSet.fixtures, fetchImpl, env);

  applyDerivedAdvancedFallbacks(result, fixtureSet.fixtures);
  applyLayerData(result.fixtures, result.layers);
  const saved = saveAdvancedData(date, result);
  writeAdvancedSyncExport(date, result, saved.path);
  return { ...result, path: saved.path };
}

async function syncFootballDataCoUkForm(date, fixtures, fetchImpl, env) {
  const enabled = env.FOOTBALL_DATA_CO_UK_ENABLED !== "0";
  if (!enabled) return skipped("football-data.co.uk form", "FOOTBALL_DATA_CO_UK_ENABLED 未启用");
  const leagues = String(env.FOOTBALL_DATA_CO_UK_LEAGUES || FOOTBALL_DATA_LEAGUES).split(",").map((item) => item.trim()).filter(Boolean);
  const season = env.FOOTBALL_DATA_CO_UK_SEASON || footballDataSeason(date);
  const allRows = [];
  await Promise.all(leagues.map(async (league) => {
    const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
    try {
      const text = await fetchText(fetchImpl, url);
      allRows.push(...parseFootballDataCsv(text, league));
    } catch {
      // League file may not exist for this season.
    }
  }));
  const fixtureData = {};
  for (const fixture of fixtures) {
    const home = teamAliases(normalizeName(fixture.homeTeam));
    const away = teamAliases(normalizeName(fixture.awayTeam));
    fixtureData[fixture.id] = {
      home: buildTeamForm(allRows, home, date),
      away: buildTeamForm(allRows, away, date)
    };
  }
  const count = Object.values(fixtureData).filter((row) => row.home.matches || row.away.matches).length;
  return { ok: count > 0, source: "football-data.co.uk CSV", count, fixtureData, warning: count ? null : "当前赛程球队未匹配到公开 CSV 历史记录" };
}

async function syncEloRatings(fixtures, fetchImpl, env) {
  if (env.TEAM_ELO_SOURCE_URL) return syncGenericFixtureLayer("elo", "TEAM_ELO_SOURCE_URL", "", fixtures, fetchImpl, env);
  if (env.CLUBELO_ENABLED === "0") return skipped("ClubElo", "CLUBELO_ENABLED=0");
  const fixtureData = {};
  let count = 0;
  const slugs = [...new Set(fixtures.flatMap((fixture) => [clubEloSlug(fixture.homeTeam), clubEloSlug(fixture.awayTeam)]).filter(Boolean))];
  const ratings = new Map();
  for (const slug of slugs) ratings.set(slug, await fetchClubEloSlug(fetchImpl, slug));
  for (const fixture of fixtures) {
    const home = ratings.get(clubEloSlug(fixture.homeTeam)) ?? null;
    const away = ratings.get(clubEloSlug(fixture.awayTeam)) ?? null;
    fixtureData[fixture.id] = { home, away };
    if (home || away) count += 1;
  }
  return { ok: count > 0, source: "ClubElo public API", count, fixtureData, warning: count ? null : "ClubElo 未返回可匹配球队；可配置 TEAM_ELO_SOURCE_URL" };
}

async function syncGenericFixtureLayer(layerKey, envKey, date, fixtures, fetchImpl, env) {
  // 委托给 authorized-source-fetcher,获得:
  //   - URL 模板支持({date}/{fixtureId}/{homeTeam}/{awayTeam}/{homeTeamAlias}/{awayTeamAlias})
  //   - 共享 team-aliases 做 bulk URL 匹配,提高 hit rate
  //   - 本地缓存(TTL 由 AUTHORIZED_SOURCE_TTL_MINUTES 控制,默认 6 小时)
  //   - <ENVKEY>_AUTH_HEADER 可注入 Authorization: Bearer xxx 之类的 header
  // 旧调用方仍然只看到 { ok, source, count, fixtureData, warning, error } 的形状。
  return fetchAuthorizedFixtureLayer({ layerKey, envKey, date, fixtures, fetchImpl, env });
}

async function syncApiFootballFixtureIndex(date, fixtures, fetchImpl, env) {
  if (!env.API_FOOTBALL_KEY) return { ok: false, fixtureData: {}, warning: "缺 API_FOOTBALL_KEY" };
  try {
    const url = new URL("https://v3.football.api-sports.io/fixtures");
    url.searchParams.set("date", date);
    url.searchParams.set("timezone", "Asia/Shanghai");
    const payload = await fetchJson(fetchImpl, url, { "x-apisports-key": env.API_FOOTBALL_KEY });
    const rows = Array.isArray(payload.response) ? payload.response : [];
    const fixtureData = {};
    for (const fixture of fixtures) {
      const matched = rows.find((row) => sameFixture({ homeTeam: row.teams?.home?.name, awayTeam: row.teams?.away?.name }, fixture));
      if (matched?.fixture?.id) fixtureData[fixture.id] = matched;
    }
    return { ok: Object.keys(fixtureData).length > 0, source: "API-Football fixtures", fixtureData };
  } catch (error) {
    return { ok: false, fixtureData: {}, error: error.message };
  }
}

async function syncInjuries(date, fixtures, fetchImpl, env, apiFootballFixtures) {
  const generic = await syncGenericFixtureLayer("injuries", "INJURY_SOURCE_URL", date, fixtures, fetchImpl, env);
  if (generic.ok || !env.API_FOOTBALL_KEY) return generic;
  const fixtureData = {};
  let count = 0;
  await Promise.all(fixtures.map(async (fixture) => {
    const apiFixtureId = apiFootballFixtures.fixtureData?.[fixture.id]?.fixture?.id;
    if (!apiFixtureId) return;
    try {
      const payload = await fetchApiFootballPath(fetchImpl, "injuries", env.API_FOOTBALL_KEY, { fixture: apiFixtureId });
      const rows = Array.isArray(payload.response) ? payload.response : [];
      fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, injuries: rows };
      count += 1;
    } catch (error) {
      fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, error: error.message };
    }
  }));
  return { ok: count > 0, source: "API-Football injuries", count, fixtureData, warning: count ? null : generic.warning ?? "API-Football 未匹配伤停" };
}

async function syncLineups(date, fixtures, fetchImpl, env, apiFootballFixtures) {
  const generic = await syncGenericFixtureLayer("lineups", "LINEUP_SOURCE_URL", date, fixtures, fetchImpl, env);
  if (generic.ok || !env.API_FOOTBALL_KEY) return generic;
  const fixtureData = {};
  let count = 0;
  await Promise.all(fixtures.map(async (fixture) => {
    const apiFixtureId = apiFootballFixtures.fixtureData?.[fixture.id]?.fixture?.id;
    if (!apiFixtureId) return;
    try {
      const payload = await fetchApiFootballPath(fetchImpl, "fixtures/lineups", env.API_FOOTBALL_KEY, { fixture: apiFixtureId });
      const rows = Array.isArray(payload.response) ? payload.response : [];
      fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, lineups: rows };
      if (rows.length) count += 1;
    } catch (error) {
      fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, error: error.message };
    }
  }));
  return { ok: count > 0, source: "API-Football lineups", count, fixtureData, warning: count ? null : generic.warning ?? "API-Football 未返回预计/确认首发" };
}

async function syncXg(date, fixtures, fetchImpl, env, apiFootballFixtures, formLayer = null) {
  const generic = await syncGenericFixtureLayer("xg", "XG_SOURCE_URL", date, fixtures, fetchImpl, env);
  if (generic.ok) return generic;
  if (!env.API_FOOTBALL_KEY) return buildShotQualityXgLayer(fixtures, formLayer, generic);
  const fixtureData = {};
  let count = 0;
  await Promise.all(fixtures.map(async (fixture) => {
    const apiFixtureId = apiFootballFixtures.fixtureData?.[fixture.id]?.fixture?.id;
    if (!apiFixtureId) return;
    try {
      const payload = await fetchApiFootballPath(fetchImpl, "fixtures/statistics", env.API_FOOTBALL_KEY, { fixture: apiFixtureId });
      const parsed = parseApiFootballXg(payload.response, fixture);
      if (parsed) {
        fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, ...parsed };
        count += 1;
      }
    } catch (error) {
      fixtureData[fixture.id] = { providerFixtureId: apiFixtureId, error: error.message };
    }
  }));
  if (count === 0) return buildShotQualityXgLayer(fixtures, formLayer, generic);
  return { ok: count > 0, source: "API-Football fixture statistics xG", count, fixtureData, warning: count ? null : generic.warning ?? "API-Football 统计未包含 xG；请配置 XG_SOURCE_URL" };
}

async function fetchApiFootballPath(fetchImpl, path, apiKey, params = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return await fetchJson(fetchImpl, url, { "x-apisports-key": apiKey });
}

function buildShotQualityXgLayer(fixtures, formLayer, fallback = {}) {
  const fixtureData = {};
  for (const fixture of fixtures) {
    const form = formLayer?.fixtureData?.[fixture.id];
    const home = shotQualityExpectedGoals(form?.home);
    const away = shotQualityExpectedGoals(form?.away);
    if (home === null || away === null) continue;
    fixtureData[fixture.id] = {
      proxy: true,
      confidence: "historical-shot-quality",
      home: { team: fixture.homeTeam, xg: home, source: "football-data.co.uk shots/SOT proxy" },
      away: { team: fixture.awayTeam, xg: away, source: "football-data.co.uk shots/SOT proxy" }
    };
  }
  const count = Object.keys(fixtureData).length;
  return {
    ok: count > 0,
    source: "football-data.co.uk shots/SOT proxy",
    count,
    fixtureData,
    warning: count ? "xG 为免费历史射门质量代理，不等同于官方实时 xG" : fallback.warning ?? "football-data.co.uk 射门质量代理未覆盖今日球队"
  };
}

function shotQualityExpectedGoals(teamForm) {
  if (!teamForm || (teamForm.matches ?? 0) < 4) return null;
  const shots = Number(teamForm.shotsForPerMatch);
  const shotsOnTarget = Number(teamForm.shotsOnTargetForPerMatch);
  const goals = Number(teamForm.goalDiff) / Number(teamForm.matches) + 1.25;
  const components = [
    Number.isFinite(shots) ? shots * 0.055 : null,
    Number.isFinite(shotsOnTarget) ? shotsOnTarget * 0.18 : null,
    Number.isFinite(goals) ? goals : null
  ].filter(Number.isFinite);
  if (!components.length) return null;
  return round(Math.max(0.25, Math.min(3.6, components.reduce((sum, value) => sum + value, 0) / components.length)));
}

function parseApiFootballXg(rows, fixture) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const mapped = {};
  for (const row of rows) {
    const side = sameTeam(row.team?.name, fixture.homeTeam) ? "home" : sameTeam(row.team?.name, fixture.awayTeam) ? "away" : "";
    if (!side) continue;
    const expectedGoals = (row.statistics ?? []).find((item) => normalizeName(item.type).includes("expectedgoals"));
    const xg = Number(String(expectedGoals?.value ?? "").replace("%", ""));
    if (Number.isFinite(xg)) mapped[side] = { team: row.team?.name, xg };
  }
  return mapped.home || mapped.away ? mapped : null;
}

async function syncGdeltNews(date, fixtures, fetchImpl, env) {
  if (env.NEWS_SOURCE_URL) return syncGenericFixtureLayer("news", "NEWS_SOURCE_URL", date, fixtures, fetchImpl, env);
  if (env.GDELT_NEWS_ENABLED === "0") return skipped("GDELT news", "GDELT_NEWS_ENABLED=0");
  const fixtureData = {};
  let count = 0;
  await Promise.all(fixtures.map(async (fixture) => {
    const home = searchName(fixture.homeTeam);
    const away = searchName(fixture.awayTeam);
    const query = encodeURIComponent(`("${home}" OR "${away}") football`);
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&format=json&maxrecords=5`;
    try {
      const payload = await fetchJson(fetchImpl, url);
      const articles = payload.articles ?? [];
      fixtureData[fixture.id] = { articles };
      if (articles.length) count += 1;
    } catch {
      fixtureData[fixture.id] = { articles: [] };
    }
  }));
  return { ok: count > 0, source: "GDELT DOC 2.1", count, fixtureData, warning: count ? null : "GDELT 未匹配到新闻" };
}

async function syncOpenMeteoWeather(date, fixtures, fetchImpl, env) {
  if (env.WEATHER_SOURCE_URL) return syncGenericFixtureLayer("weather", "WEATHER_SOURCE_URL", date, fixtures, fetchImpl, env);
  if (env.OPEN_METEO_ENABLED === "0") return skipped("Open-Meteo weather", "OPEN_METEO_ENABLED=0");
  const fixtureData = {};
  const geoCache = new Map();
  let count = 0;
  await Promise.all(fixtures.map(async (fixture) => {
    const place = weatherPlace(fixture.homeTeam);
    try {
      const geo = await geocodePlace(fetchImpl, place, geoCache);
      if (!geo) {
        fixtureData[fixture.id] = { place, warning: "geocode-not-found" };
        return;
      }
      const forecast = await fetchJson(fetchImpl, `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=7&timezone=auto`);
      fixtureData[fixture.id] = {
        place,
        latitude: geo.latitude,
        longitude: geo.longitude,
        country: geo.country,
        timezone: forecast.timezone,
        hourly: sliceWeatherAroundKickoff(forecast.hourly, fixture.kickoff)
      };
      count += 1;
    } catch (error) {
      fixtureData[fixture.id] = { place, error: error.message };
    }
  }));
  return { ok: count > 0, source: "Open-Meteo geocoding+forecast", count, fixtureData, warning: count ? null : "Open-Meteo 未匹配到天气" };
}

async function geocodePlace(fetchImpl, place, cache) {
  const key = normalizeName(place);
  if (cache.has(key)) return cache.get(key);
  const payload = await fetchJson(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
  const result = payload.results?.[0] ?? null;
  cache.set(key, result);
  return result;
}

function sliceWeatherAroundKickoff(hourly, kickoff) {
  const times = hourly?.time ?? [];
  if (!times.length) return {};
  const kickoffDay = String(kickoff ?? "").slice(0, 10);
  const indexes = times.map((time, index) => ({ time, index })).filter((item) => String(item.time).startsWith(kickoffDay)).slice(0, 24);
  if (!indexes.length) return {};
  const values = (key) => indexes.map((item) => hourly?.[key]?.[item.index]).filter((value) => value !== undefined && value !== null);
  return {
    date: kickoffDay,
    temperature2m: summarizeNumbers(values("temperature_2m")),
    precipitation: summarizeNumbers(values("precipitation")),
    windSpeed10m: summarizeNumbers(values("wind_speed_10m"))
  };
}

function summarizeNumbers(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return null;
  return {
    min: round(Math.min(...numeric)),
    max: round(Math.max(...numeric)),
    avg: round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length)
  };
}

function applyLayerData(fixtures, layers) {
  for (const layerKey of Object.keys(layers)) {
    const fixtureData = layers[layerKey].fixtureData ?? {};
    for (const fixture of fixtures) {
      if (fixtureData[fixture.fixtureId]) fixture.data[layerKey] = fixtureData[fixture.fixtureId];
    }
  }
}

function applyDerivedAdvancedFallbacks(result, fixtures) {
  const marketSnapshots = loadMarketSnapshots(result.date).snapshots ?? [];
  const fallbackBuilders = {
    elo: derivedEloLayer,
    form: derivedFormLayer,
    injuries: derivedInjuryAwarenessLayer,
    lineups: derivedLineupAwarenessLayer,
    xg: derivedXgLayer,
    news: derivedMotivationLayer
  };
  for (const [layerKey, builder] of Object.entries(fallbackBuilders)) {
    const layer = result.layers[layerKey] ?? skipped(layerKey, "missing-layer");
    const fixtureData = { ...(layer.fixtureData ?? {}) };
    let derivedCount = 0;
    for (const fixture of fixtures) {
      if (fixtureData[fixture.id] && Object.keys(fixtureData[fixture.id]).length) continue;
      const snapshot = findMarketSnapshot(fixture, marketSnapshots);
      const derived = builder(fixture, snapshot);
      if (!derived) continue;
      fixtureData[fixture.id] = derived;
      derivedCount += 1;
    }
    const realCount = Number(layer.count ?? 0);
    const count = Object.keys(fixtureData).length;
    result.layers[layerKey] = {
      ...layer,
      ok: count > 0,
      count,
      realCount,
      derivedCount,
      derived: derivedCount > 0,
      source: realCount > 0 ? `${layer.source}; model-derived fallback` : "model-derived fallback",
      fixtureData,
      warning: derivedCount > 0 ? `包含 ${derivedCount} 场模型派生代理特征，不等同于真实外部情报` : layer.warning ?? null
    };
  }
}

function derivedEloLayer(fixture, snapshot) {
  const probabilities = impliedProbabilitiesFromSnapshot(snapshot);
  if (!probabilities) return null;
  const edge = (probabilities.home - probabilities.away) * 420;
  return {
    modelDerived: true,
    confidence: "proxy",
    home: { team: fixture.homeTeam, Elo: Math.round(1500 + edge / 2), source: "market-implied-strength" },
    away: { team: fixture.awayTeam, Elo: Math.round(1500 - edge / 2), source: "market-implied-strength" }
  };
}

function derivedFormLayer(fixture, snapshot) {
  const probabilities = impliedProbabilitiesFromSnapshot(snapshot);
  if (!probabilities) return null;
  const homeEdge = probabilities.home - probabilities.away;
  return {
    modelDerived: true,
    confidence: "proxy",
    home: {
      matches: 8,
      pointsPerMatch: round(1.35 + homeEdge * 1.8),
      goalDiff: Math.round(homeEdge * 12),
      source: "market-implied-form-proxy"
    },
    away: {
      matches: 8,
      pointsPerMatch: round(1.35 - homeEdge * 1.8),
      goalDiff: Math.round(-homeEdge * 12),
      source: "market-implied-form-proxy"
    }
  };
}

function derivedInjuryAwarenessLayer() {
  return {
    modelDerived: true,
    confidence: "unknown",
    injuries: [],
    status: "no-free-confirmed-injury-source; treated as neutral with manual review required"
  };
}

function derivedLineupAwarenessLayer() {
  return {
    modelDerived: true,
    confidence: "unknown",
    status: "no-confirmed-lineup-source; model uses neutral lineup assumption and requires pre-match review"
  };
}

function derivedXgLayer(fixture, snapshot) {
  const probabilities = impliedProbabilitiesFromSnapshot(snapshot);
  if (!probabilities) return null;
  const drawPressure = probabilities.draw;
  const homeEdge = probabilities.home - probabilities.away;
  const totalGoals = Math.max(1.7, Math.min(3.6, 2.65 - Math.max(0, drawPressure - 0.25) * 1.2 + Math.abs(homeEdge) * 0.55));
  const homeShare = Math.max(0.28, Math.min(0.72, 0.5 + homeEdge * 0.55));
  return {
    modelDerived: true,
    confidence: "proxy",
    home: { team: fixture.homeTeam, xg: round(totalGoals * homeShare), source: "market-implied-xg-proxy" },
    away: { team: fixture.awayTeam, xg: round(totalGoals * (1 - homeShare)), source: "market-implied-xg-proxy" }
  };
}

function derivedMotivationLayer(fixture) {
  return {
    modelDerived: true,
    confidence: "heuristic",
    motivation: {
      summary: motivationHeuristic(fixture),
      note: "由赛事类型/赛季阶段推断，非官方积分榜确认"
    }
  };
}

function motivationHeuristic(fixture) {
  const competition = String(fixture.competition ?? "");
  if (/英冠|荷乙|瑞超|芬超|西甲|意甲|德甲/.test(competition)) return "联赛阶段：默认纳入争冠、升级、保级与欧战席位战意风险";
  if (/杯|欧冠|欧罗巴|解放者/.test(competition)) return "杯赛阶段：默认纳入轮换、赛程密度与晋级优先级风险";
  return "常规赛事：战意未获外部源确认，按中性处理";
}

function impliedProbabilitiesFromSnapshot(snapshot) {
  const odds = snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final;
  if (!odds || !Number.isFinite(Number(odds.home)) || !Number.isFinite(Number(odds.draw)) || !Number.isFinite(Number(odds.away))) return null;
  const raw = { home: 1 / Number(odds.home), draw: 1 / Number(odds.draw), away: 1 / Number(odds.away) };
  const total = raw.home + raw.draw + raw.away;
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

async function fetchClubElo(fetchImpl, team) {
  const slug = clubEloSlug(team);
  if (!slug) return null;
  return fetchClubEloSlug(fetchImpl, slug);
}

async function fetchClubEloSlug(fetchImpl, slug) {
  try {
    const text = await fetchText(fetchImpl, `http://api.clubelo.com/${encodeURIComponent(slug)}`, 10000);
    const rows = parseCsv(text);
    return rows.at(-1) ?? null;
  } catch {
    return null;
  }
}

function buildTeamForm(rows, team, date) {
  const aliases = Array.isArray(team) ? team : [team];
  const played = rows
    .filter((row) => aliases.includes(normalizeName(row.HomeTeam)) || aliases.includes(normalizeName(row.AwayTeam)))
    .filter((row) => normalizeFootballDataDate(row.Date) < date && Number.isFinite(Number(row.FTHG)) && Number.isFinite(Number(row.FTAG)))
    .sort((left, right) => normalizeFootballDataDate(right.Date).localeCompare(normalizeFootballDataDate(left.Date)))
    .slice(0, 8);
  const points = played.map((row) => {
    const isHome = aliases.includes(normalizeName(row.HomeTeam));
    const goalsFor = Number(isHome ? row.FTHG : row.FTAG);
    const goalsAgainst = Number(isHome ? row.FTAG : row.FTHG);
    return goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
  });
  return {
    matches: played.length,
    points: points.reduce((sum, value) => sum + value, 0),
    pointsPerMatch: played.length ? round(points.reduce((sum, value) => sum + value, 0) / played.length) : null,
    goalDiff: played.reduce((sum, row) => {
      const isHome = aliases.includes(normalizeName(row.HomeTeam));
      return sum + Number(isHome ? row.FTHG : row.FTAG) - Number(isHome ? row.FTAG : row.FTHG);
    }, 0),
    shotsForPerMatch: averageTeamColumn(played, aliases, "HS", "AS"),
    shotsAgainstPerMatch: averageTeamColumn(played, aliases, "AS", "HS"),
    shotsOnTargetForPerMatch: averageTeamColumn(played, aliases, "HST", "AST"),
    shotsOnTargetAgainstPerMatch: averageTeamColumn(played, aliases, "AST", "HST")
  };
}

function averageTeamColumn(rows, aliases, homeColumn, awayColumn) {
  const values = rows
    .map((row) => {
      const isHome = aliases.includes(normalizeName(row.HomeTeam));
      return Number(isHome ? row[homeColumn] : row[awayColumn]);
    })
    .filter(Number.isFinite);
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function parseFootballDataCsv(text, league) {
  return parseCsv(text).map((row) => ({ ...row, league }));
}

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() ?? "");
  return lines.map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\"" && line[index + 1] === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const text = await fetchText(fetchImpl, url, 15000, headers);
  return JSON.parse(text);
}

async function fetchText(fetchImpl, url, timeoutMs = 15000, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "football-ai-copilot/advanced-data", ...headers } });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function writeAdvancedSyncExport(date, result, path) {
  mkdirSync(exportDir, { recursive: true });
  const exportPath = join(exportDir, `advanced-data-sync-${date}.json`);
  writeFileSync(exportPath, `${JSON.stringify({ ...result, path }, null, 2)}\n`, "utf8");
}

function skipped(source, reason) {
  return { ok: false, source, count: 0, fixtureData: {}, skipped: true, warning: reason };
}

function expandDateUrl(url, date) {
  return String(url).replaceAll("{date}", date);
}

function footballDataSeason(date) {
  const [yearText, monthText] = String(date).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const start = month >= 7 ? year : year - 1;
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
}

function normalizeFootballDataDate(value) {
  const match = String(value ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function sameFixture(row, fixture) {
  const home = row.homeTeam ?? row.home ?? row.HomeTeam;
  const away = row.awayTeam ?? row.away ?? row.AwayTeam;
  return sameTeam(home, fixture.homeTeam) && sameTeam(away, fixture.awayTeam);
}

function sameTeam(left, right) {
  const leftName = normalizeName(left);
  const rightAliases = teamAliases(normalizeName(right));
  return leftName === normalizeName(right) || rightAliases.includes(leftName) || rightAliases.some((alias) => leftName.includes(alias) || alias.includes(leftName));
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function teamAliases(value) {
  const aliases = {
    "拉赫蒂": ["lahti", "fclahti"],
    "瓦萨": ["vaasa", "vps"],
    "佐加顿斯": ["djurgarden", "djurgardens", "djurgardensif"],
    "天狼星": ["sirius", "ik sirius", "iksirius"],
    "厄格里特": ["orgryte", "orgryteis"],
    "厄尔格里特": ["orgryte", "orgryteis"],
    "哥德堡": ["goteborg", "ifkgoteborg", "ifkgothenburg"],
    "ifk哥德堡": ["goteborg", "ifkgoteborg", "ifkgothenburg"],
    "哥德堡盖斯": ["gais", "goteborggais"],
    "哈马比": ["hammarby"],
    "斯达": ["start", "ikstart"],
    "博德闪耀": ["bodoglimt", "bodo/glimt"],
    "利勒斯特罗姆": ["lillestrom"],
    "克里斯蒂安松": ["kristiansund"],
    "奥勒松": ["aalesund", "alesund"],
    "布兰": ["brann"],
    "坦佩雷山猫": ["ilves", "tampereenilves"],
    "国际图尔库": ["interturku", "fcinter"],
    "库奥皮奥": ["kups", "kuopionpalloseura"],
    "雅罗": ["jaro", "ffjaro"],
    "弗赖堡": ["freiburg"],
    "阿斯顿维拉": ["astonvilla", "aston villa"],
    "阿森纳": ["arsenal"],
    "伯恩利": ["burnley"],
    "伯恩茅斯": ["bournemouth"],
    "曼城": ["mancity", "manchestercity"],
    "曼彻斯特城": ["mancity", "manchestercity"],
    "切尔西": ["chelsea"],
    "热刺": ["tottenham", "tottenhamhotspur"],
    "托特纳姆热刺": ["tottenham", "tottenhamhotspur"],
    "弗鲁米嫩塞": ["fluminense"],
    "玻利瓦尔": ["bolivar"],
    "坦山猫": ["ilves", "tampereenilves"],
    "国际图尔": ["interturku", "fcinter"],
    "利勒斯特": ["lillestrom"],
    "克里斯蒂": ["kristiansund"],
    "赛哈海湾": ["alkhaleej", "al khaleej"],
    "吉达国民": ["alahli", "al ahli", "alahli saudi"],
    "维拉": ["astonvilla", "aston villa"],
    "弗拉门戈": ["flamengo"],
    "拉普大学": ["estudiantes", "estudianteslp", "estudiantesdelaplata"],
    "帕梅拉斯": ["palmeiras"],
    "波特诺": ["cerroporteno", "cerro porteno"],
    "威廉二世": ["willemii", "willem ii"],
    "福伦丹": ["volendam"],
    "托林斯": ["torreense"],
    "卡萨皮亚": ["casapia", "casa pia"],
    "水晶宫": ["crystalpalace", "crystal palace"],
    "巴列卡诺": ["rayovallecano", "rayo vallecano"],
    "帕德博恩": ["paderborn"],
    "沃尔夫斯堡": ["wolfsburg"],
    "菲尔特": ["greutherfurth", "furth"],
    "埃森": ["rotweissessen", "essen"],
    "圣埃蒂安": ["saintetienne", "stetienne"],
    "尼斯": ["nice"],
    "埃尔夫斯堡": ["elfsborg"],
    "赫根": ["hacken"],
    "奥斯陆KFUM": ["kfumoslo", "kfum oslo"],
    "罗森博格": ["rosenborg"],
    "萨尔普斯堡": ["sarpsborg"],
    "莫尔德": ["molde"],
    "特罗姆瑟": ["tromso"],
    "汉坎": ["hamkam"],
    "桑纳菲尤尔": ["sandefjord"],
    "腓特烈斯塔": ["fredrikstad"],
    "拉努斯": ["lanus"],
    "米拉索尔": ["mirassol"],
    "库斯科": ["cusco"],
    "德尔瓦耶独立": ["independientedelvalle", "independiente del valle"],
    "罗萨里奥中央": ["rosariocentral", "rosario central"],
    "科林蒂安": ["corinthians"],
    "普拉滕斯": ["platense"]
  };
  return (aliases[value] ?? [value]).map(normalizeName);
}

function clubEloSlug(team) {
  const aliases = {
    "拉赫蒂": "Lahti",
    "瓦萨": "VPS",
    "佐加顿斯": "Djurgarden",
    "天狼星": "Sirius",
    "厄格里特": "Orgryte",
    "厄尔格里特": "Orgryte",
    "哥德堡": "Goteborg",
    "ifk哥德堡": "Goteborg",
    "哥德堡盖斯": "GAIS",
    "哈马比": "Hammarby",
    "斯达": "Start",
    "博德闪耀": "BodoGlimt",
    "利勒斯特罗姆": "Lillestrom",
    "克里斯蒂安松": "Kristiansund",
    "奥勒松": "Aalesund",
    "布兰": "Brann",
    "坦佩雷山猫": "Ilves",
    "国际图尔库": "InterTurku",
    "库奥皮奥": "KuPS",
    "雅罗": "Jaro",
    "弗赖堡": "Freiburg",
    "阿斯顿维拉": "AstonVilla",
    "阿森纳": "Arsenal",
    "伯恩利": "Burnley",
    "伯恩茅斯": "Bournemouth",
    "曼城": "ManCity",
    "曼彻斯特城": "ManCity",
    "切尔西": "Chelsea",
    "热刺": "Tottenham",
    "托特纳姆热刺": "Tottenham",
    "坦山猫": "Ilves",
    "国际图尔": "InterTurku",
    "利勒斯特": "Lillestrom",
    "克里斯蒂": "Kristiansund",
    "维拉": "AstonVilla",
    "弗拉门戈": "Flamengo",
    "拉普大学": "Estudiantes",
    "帕梅拉斯": "Palmeiras",
    "波特诺": "CerroPorteno",
    "威廉二世": "WillemII",
    "福伦丹": "Volendam",
    "水晶宫": "CrystalPalace",
    "巴列卡诺": "RayoVallecano",
    "帕德博恩": "Paderborn",
    "沃尔夫斯堡": "Wolfsburg",
    "菲尔特": "GreutherFurth",
    "圣埃蒂安": "SaintEtienne",
    "尼斯": "Nice",
    "埃尔夫斯堡": "Elfsborg",
    "赫根": "Hacken",
    "奥斯陆KFUM": "KFUMOslo",
    "罗森博格": "Rosenborg",
    "萨尔普斯堡": "Sarpsborg",
    "莫尔德": "Molde",
    "特罗姆瑟": "Tromso",
    "汉坎": "HamKam",
    "桑纳菲尤尔": "Sandefjord",
    "腓特烈斯塔": "Fredrikstad",
    "拉努斯": "Lanus",
    "科林蒂安": "Corinthians"
  };
  return aliases[normalizeName(team)] ?? "";
}

function searchName(team) {
  const aliases = {
    "拉赫蒂": "Lahti",
    "瓦萨": "VPS",
    "佐加顿斯": "Djurgarden",
    "天狼星": "Sirius",
    "厄格里特": "Orgryte",
    "厄尔格里特": "Orgryte",
    "哥德堡": "IFK Goteborg",
    "ifk哥德堡": "IFK Goteborg",
    "哥德堡盖斯": "GAIS",
    "哈马比": "Hammarby",
    "斯达": "IK Start",
    "博德闪耀": "Bodo Glimt",
    "利勒斯特罗姆": "Lillestrom",
    "克里斯蒂安松": "Kristiansund",
    "奥勒松": "Aalesund",
    "布兰": "Brann",
    "坦佩雷山猫": "Ilves",
    "国际图尔库": "Inter Turku",
    "库奥皮奥": "KuPS",
    "雅罗": "Jaro",
    "弗赖堡": "Freiburg",
    "阿斯顿维拉": "Aston Villa",
    "阿森纳": "Arsenal",
    "伯恩利": "Burnley",
    "伯恩茅斯": "Bournemouth",
    "曼城": "Manchester City",
    "曼彻斯特城": "Manchester City",
    "切尔西": "Chelsea",
    "热刺": "Tottenham",
    "托特纳姆热刺": "Tottenham",
    "弗鲁米嫩塞": "Fluminense",
    "玻利瓦尔": "Bolivar",
    "坦山猫": "Ilves",
    "国际图尔": "Inter Turku",
    "利勒斯特": "Lillestrom",
    "克里斯蒂": "Kristiansund",
    "赛哈海湾": "Al Khaleej",
    "吉达国民": "Al Ahli Saudi",
    "维拉": "Aston Villa",
    "弗拉门戈": "Flamengo",
    "拉普大学": "Estudiantes de La Plata",
    "帕梅拉斯": "Palmeiras",
    "波特诺": "Cerro Porteno",
    "威廉二世": "Willem II",
    "福伦丹": "Volendam",
    "托林斯": "Torreense",
    "卡萨皮亚": "Casa Pia",
    "水晶宫": "Crystal Palace",
    "巴列卡诺": "Rayo Vallecano",
    "帕德博恩": "Paderborn",
    "沃尔夫斯堡": "Wolfsburg",
    "菲尔特": "Greuther Furth",
    "埃森": "Rot-Weiss Essen",
    "圣埃蒂安": "Saint Etienne",
    "尼斯": "Nice",
    "埃尔夫斯堡": "Elfsborg",
    "赫根": "Hacken",
    "奥斯陆KFUM": "KFUM Oslo",
    "罗森博格": "Rosenborg",
    "萨尔普斯堡": "Sarpsborg",
    "莫尔德": "Molde",
    "特罗姆瑟": "Tromso",
    "汉坎": "HamKam",
    "桑纳菲尤尔": "Sandefjord",
    "腓特烈斯塔": "Fredrikstad",
    "拉努斯": "Lanus",
    "米拉索尔": "Mirassol",
    "库斯科": "Cusco",
    "德尔瓦耶独立": "Independiente del Valle",
    "罗萨里奥中央": "Rosario Central",
    "科林蒂安": "Corinthians",
    "普拉滕斯": "Platense"
  };
  return aliases[normalizeName(team)] ?? String(team ?? "");
}

function weatherPlace(team) {
  const aliases = {
    "拉赫蒂": "Lahti",
    "瓦萨": "Vaasa",
    "佐加顿斯": "Stockholm",
    "天狼星": "Uppsala",
    "厄格里特": "Gothenburg",
    "厄尔格里特": "Gothenburg",
    "哥德堡": "Gothenburg",
    "ifk哥德堡": "Gothenburg",
    "哥德堡盖斯": "Gothenburg",
    "哈马比": "Stockholm",
    "斯达": "Kristiansand",
    "博德闪耀": "Bodo",
    "利勒斯特罗姆": "Lillestrom",
    "克里斯蒂安松": "Kristiansund",
    "奥勒松": "Alesund",
    "布兰": "Bergen",
    "坦佩雷山猫": "Tampere",
    "国际图尔库": "Turku",
    "库奥皮奥": "Kuopio",
    "雅罗": "Jakobstad",
    "弗赖堡": "Freiburg im Breisgau",
    "阿斯顿维拉": "Birmingham",
    "阿森纳": "London",
    "伯恩利": "Burnley",
    "伯恩茅斯": "Bournemouth",
    "曼城": "Manchester",
    "曼彻斯特城": "Manchester",
    "切尔西": "London",
    "热刺": "London",
    "托特纳姆热刺": "London",
    "弗鲁米嫩塞": "Rio de Janeiro",
    "玻利瓦尔": "La Paz",
    "坦山猫": "Tampere",
    "国际图尔": "Turku",
    "利勒斯特": "Lillestrom",
    "克里斯蒂": "Kristiansund",
    "赛哈海湾": "Saihat",
    "吉达国民": "Jeddah",
    "维拉": "Birmingham",
    "弗拉门戈": "Rio de Janeiro",
    "拉普大学": "La Plata",
    "帕梅拉斯": "Sao Paulo",
    "波特诺": "Asuncion",
    "威廉二世": "Tilburg",
    "福伦丹": "Volendam",
    "托林斯": "Torres Vedras",
    "卡萨皮亚": "Lisbon",
    "水晶宫": "London",
    "巴列卡诺": "Madrid",
    "帕德博恩": "Paderborn",
    "沃尔夫斯堡": "Wolfsburg",
    "菲尔特": "Furth",
    "埃森": "Essen",
    "圣埃蒂安": "Saint-Etienne",
    "尼斯": "Nice",
    "埃尔夫斯堡": "Boras",
    "赫根": "Gothenburg",
    "奥斯陆KFUM": "Oslo",
    "罗森博格": "Trondheim",
    "萨尔普斯堡": "Sarpsborg",
    "莫尔德": "Molde",
    "特罗姆瑟": "Tromso",
    "汉坎": "Hamar",
    "桑纳菲尤尔": "Sandefjord",
    "腓特烈斯塔": "Fredrikstad",
    "拉努斯": "Lanus",
    "米拉索尔": "Mirassol",
    "库斯科": "Cusco",
    "德尔瓦耶独立": "Quito",
    "罗萨里奥中央": "Rosario",
    "科林蒂安": "Sao Paulo",
    "普拉滕斯": "Vicente Lopez"
  };
  return aliases[normalizeName(team)] ?? String(team ?? "");
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function readArg(name) {
  const args = process.argv.slice(2);
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const date = readArg("--date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const result = await syncAdvancedFootballData(date);
  console.log(JSON.stringify({
    ok: Object.values(result.layers).some((layer) => layer.ok),
    path: result.path,
    layers: Object.fromEntries(Object.entries(result.layers).map(([key, value]) => [key, { ok: value.ok, count: value.count, warning: value.warning ?? null, error: value.error ?? null }]))
  }, null, 2));
}
