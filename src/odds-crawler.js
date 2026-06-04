import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import { loadFixtures } from "./fixture-store.js";
import { findMarketSnapshot, loadMarketSnapshots, normalizeMarketSnapshot, saveMarketSnapshots } from "./market-data-store.js";
import { backfillFromStabilityCache, updateStabilityCache } from "./odds-stability-cache.js";
import { crawlEspnScoreboardOdds } from "./espn-odds-source.js";
import { getDataSubdir, getExportDir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportDir = getExportDir();

export async function crawlMarketData(date, options = {}) {
  if (options.requireApiKey && !hasAnyFreeOddsSource()) throw new Error("缺少免费赔率源：请配置 ODDS_API_KEY、ODDS_API_IO_KEY、API_FOOTBALL_KEY 或 ODDS_JSON_URL/ODDS_CSV_URL");
  const fixtureSet = loadFixtures(date);
  const previous = loadMarketSnapshots(date).snapshots;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const candidates = [];
  const sources = [];
  if (process.env.ODDS_API_KEY) {
    const rows = await crawlTheOddsApi(date, fetchImpl);
    candidates.push(...rows);
    sources.push({ name: "The Odds API", fetched: rows.length, ok: true });
  } else {
    sources.push({ name: "The Odds API", fetched: 0, ok: false, error: "缺少 ODDS_API_KEY" });
  }
  if (process.env.ODDS_API_IO_KEY) {
    try {
      const rows = await crawlOddsApiIo(date, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "Odds-API.io", fetched: rows.length, ok: true });
    } catch (error) {
      sources.push({ name: "Odds-API.io", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.API_FOOTBALL_KEY) {
    try {
      const rows = await crawlApiFootballOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "API-Football Odds", fetched: rows.length, ok: true });
    } catch (error) {
      sources.push({ name: "API-Football Odds", fetched: 0, ok: false, error: error.message });
    }
  }
  for (const item of [{ name: "授权 JSON 源", url: process.env.ODDS_JSON_URL, type: "json" }, { name: "授权 CSV 源", url: process.env.ODDS_CSV_URL, type: "csv" }]) {
    if (!item.url) continue;
    try {
      const rows = item.type === "json" ? await crawlJsonUrl(item.url, date, fetchImpl) : await crawlCsvUrl(item.url, date, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: item.name, fetched: rows.length, ok: true });
    } catch (error) {
      sources.push({ name: item.name, fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.ODDS1X2_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlOdds1x2Odds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "Odds1x2 public odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching Odds1x2 pages" });
    } catch (error) {
      sources.push({ name: "Odds1x2 public odds", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.SGODDS_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlSgOddsMapped(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "SGOdds public odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no mapped SGOdds pages" });
    } catch (error) {
      sources.push({ name: "SGOdds public odds", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.BETEXPLORER_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlBetExplorerMapped(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "BetExplorer public odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no mapped BetExplorer pages" });
    } catch (error) {
      sources.push({ name: "BetExplorer public odds", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.LIAOGOU_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlLiaogouMappedOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "料狗公开赛前盘口", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no mapped Liaogou pages" });
    } catch (error) {
      sources.push({ name: "料狗公开赛前盘口", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.FIVEHUNDRED_JC_ASIAN_ENABLED !== "0" && fixtureSet.fixtures.some((fixture) => fixture.marketType === "jingcai")) {
    try {
      const rows = await crawlFiveHundredJingcaiAsianOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "500.com jingcai asian odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching 500.com jingcai asian odds" });
    } catch (error) {
      sources.push({ name: "500.com jingcai asian odds", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.SINA_SFC_ODDS_ENABLED !== "0" && fixtureSet.fixtures.some((fixture) => fixture.marketType === "shengfucai")) {
    try {
      const rows = await crawlSinaShengfucaiOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "新浪胜负彩欧洲四大机构", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "未发现匹配期号的14场欧洲赔率" });
    } catch (error) {
      sources.push({ name: "新浪胜负彩欧洲四大机构", fetched: 0, ok: false, error: error.message });
    }
    try {
      const rows = await crawlSinaShengfucaiMacauOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "新浪胜负彩澳盘", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "未发现匹配期号的14场澳盘" });
    } catch (error) {
      sources.push({ name: "新浪胜负彩澳盘", fetched: 0, ok: false, error: error.message });
    }
    try {
      const rows = await crawlSinaShengfucaiEuroAsianContrast(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "Sina euro-asian contrast", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching euro-asian contrast article" });
    } catch (error) {
      sources.push({ name: "Sina euro-asian contrast", fetched: 0, ok: false, error: error.message });
    }
    if (process.env.FIVEHUNDRED_SFC_ASIAN_ENABLED !== "0") {
      try {
        const rows = await crawlFiveHundredShengfucaiEuropeanOdds(date, fixtureSet.fixtures, fetchImpl);
        candidates.push(...rows);
        sources.push({ name: "500.com shengfucai european odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching 500.com european odds" });
      } catch (error) {
        sources.push({ name: "500.com shengfucai european odds", fetched: 0, ok: false, error: error.message });
      }
      try {
        const rows = await crawlFiveHundredShengfucaiAsianOdds(date, fixtureSet.fixtures, fetchImpl);
        candidates.push(...rows);
        sources.push({ name: "500.com shengfucai asian odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching 500.com asian odds" });
      } catch (error) {
        sources.push({ name: "500.com shengfucai asian odds", fetched: 0, ok: false, error: error.message });
      }
    }
  }
  if (process.env.FOOTBALL_DATA_CO_UK_ENABLED === "1") {
    try {
      const rows = await crawlFootballDataCoUkOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "football-data.co.uk CSV", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "no matching rows for date/fixtures" });
    } catch (error) {
      sources.push({ name: "football-data.co.uk CSV", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.NOWSCORE_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlNowscoreOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "捷报比分公开赔率", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "未发现可匹配场次" });
    } catch (error) {
      sources.push({ name: "捷报比分公开赔率", fetched: 0, ok: false, error: error.message });
    }
  }
  if (process.env.CUBEGOAL_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlCubegoalOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "CubeGoal公开赔率", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "未发现可匹配场次" });
    } catch (error) {
      sources.push({ name: "CubeGoal公开赔率", fetched: 0, ok: false, error: error.message });
    }
  }
  // 2026-06-02: ESPN scoreboard 冗余欧赔源,主补国际赛/友谊赛(新浪/付费源常年抓不到)。
  if (process.env.ESPN_ODDS_ENABLED !== "0") {
    try {
      const rows = await crawlEspnScoreboardOdds(date, fixtureSet.fixtures, fetchImpl);
      candidates.push(...rows);
      sources.push({ name: "ESPN scoreboard odds", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : "无匹配国际赛事或当日无赔率" });
    } catch (error) {
      sources.push({ name: "ESPN scoreboard odds", fetched: 0, ok: false, error: error.message });
    }
  }

  let matched = alignSnapshots(candidates, fixtureSet.fixtures);
  let merged = mergeSnapshots(previous, matched);

  // 2026-05-28: 缺亚盘场次主动二轮救援。
  // 经过常规源后,如果还存在 fixture 拿不到 asianHandicap,临时启用 cubegoal API
  // (基于 date+team-name 自动查找,不需要预置 mapping) 针对这些 fixture 做最后一轮。
  // 控制开关:ODDS_INCOMPLETE_RESCUE_ENABLED="0" 可关闭(默认开)。
  if (process.env.ODDS_INCOMPLETE_RESCUE_ENABLED !== "0") {
    const stillMissingAsian = fixtureSet.fixtures.filter((fixture) => {
      const snapshot = merged.find((item) => item.fixtureId === fixture.id);
      return !snapshot || !snapshot.asianHandicap;
    });
    if (stillMissingAsian.length && process.env.CUBEGOAL_ODDS_ENABLED === "0") {
      // 仅在 cubegoal 本来禁用的情况下,临时为缺亚盘场次单独触发一次。
      try {
        const rows = await crawlCubegoalOdds(date, stillMissingAsian, fetchImpl);
        candidates.push(...rows);
        sources.push({ name: "CubeGoal二轮救援(缺亚盘)", fetched: rows.length, ok: rows.length > 0, error: rows.length ? undefined : `针对 ${stillMissingAsian.length} 场缺亚盘 fixture 未获补救` });
        if (rows.length) {
          matched = alignSnapshots(candidates, fixtureSet.fixtures);
          merged = mergeSnapshots(previous, matched);
        }
      } catch (error) {
        sources.push({ name: "CubeGoal二轮救援(缺亚盘)", fetched: 0, ok: false, error: error.message });
      }
    }
  }

  // 2026-06-02: 单调稳定缓存。先把本轮抓到的真实盘口存为 last-good,再用历史
  // last-good 回填本轮缺失/被派生 fallback 顶替的市场 —— 让同批比赛多次抓取
  // 复现最高质量数据,消除"每次效果都不一样"。纯加法,可用环境变量关闭。
  let stabilityBackfilled = 0;
  if (process.env.ODDS_STABILITY_CACHE_ENABLED !== "0") {
    try {
      updateStabilityCache(date, merged);
      const stability = backfillFromStabilityCache(date, merged, fixtureSet.fixtures);
      merged = stability.snapshots;
      stabilityBackfilled = stability.backfilled;
      matched = alignSnapshots(merged, fixtureSet.fixtures);
      sources.push({ name: "稳定缓存回填(last-good)", fetched: stabilityBackfilled, ok: stabilityBackfilled > 0, error: stabilityBackfilled ? undefined : "无需回填(实时已最优或缓存为空)" });
    } catch (error) {
      sources.push({ name: "稳定缓存回填(last-good)", fetched: 0, ok: false, error: error.message });
    }
  }

  const saved = (matched.length || stabilityBackfilled) ? saveMarketSnapshots(date, merged, { source: sources.filter((source) => source.ok).map((source) => source.name).join("+") }) : null;
  const result = { date, fixtures: fixtureSet.fixtures.length, sources, fetched: candidates.length, matched: matched.length, stabilityBackfilled, saved: Boolean(saved), path: saved?.path ?? null, snapshots: merged };
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, `odds-crawler-${date}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function hasAnyFreeOddsSource() {
  return Boolean(process.env.ODDS_API_KEY || process.env.ODDS_API_IO_KEY || process.env.API_FOOTBALL_KEY || process.env.ODDS_JSON_URL || process.env.ODDS_CSV_URL || process.env.SINA_SFC_ODDS_ENABLED !== "0" || process.env.FOOTBALL_DATA_CO_UK_ENABLED === "1");
}

async function crawlTheOddsApi(date, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const sports = String(process.env.ODDS_API_SPORTS || "soccer_epl,soccer_spain_la_liga,soccer_germany_bundesliga,soccer_italy_serie_a,soccer_france_ligue_one,soccer_portugal_primeira_liga,soccer_norway_eliteserien").split(",").map((item) => item.trim()).filter(Boolean);
  const rows = [];
  for (const sport of sports) {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds`);
    url.searchParams.set("apiKey", process.env.ODDS_API_KEY);
    // 免费档 500 credits/月,成本=regions×markets/次。默认仅 eu 区(含 Betfair 交易所/Pinnacle/1xBet/
    //   Marathonbet 等 sharp 盘,聚合成共识收盘线足够 sharp);eu,uk,us 三区会 3 倍烧额度→几天耗尽致闸门缺赔率。
    //   需更广覆盖再用 ODDS_API_REGIONS 覆盖。eu×(h2h,spreads)=2 credits/联赛/次。
    url.searchParams.set("regions", process.env.ODDS_API_REGIONS || "eu");
    url.searchParams.set("markets", "h2h,spreads");
    url.searchParams.set("oddsFormat", "decimal");
    url.searchParams.set("dateFormat", "iso");
    const events = await fetchJson(fetchImpl, url);
    if (!Array.isArray(events)) continue;
    rows.push(...events.filter((event) => String(event.commence_time || "").slice(0, 10) === date).map(oddsApiEventToSnapshot).filter(Boolean));
  }
  return rows;
}

async function crawlOddsApiIo(date, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const eventsUrl = new URL("https://api.odds-api.io/v3/events");
  eventsUrl.searchParams.set("apiKey", process.env.ODDS_API_IO_KEY);
  eventsUrl.searchParams.set("sport", "football");
  const payload = await fetchJson(fetchImpl, eventsUrl);
  const events = Array.isArray(payload) ? payload : payload.data ?? payload.events ?? [];
  const rows = [];
  for (const event of events.filter((item) => eventDate(item) === date)) {
    const eventId = event.id ?? event.eventId ?? event.event_id;
    if (!eventId) continue;
    const oddsUrl = new URL("https://api.odds-api.io/v3/odds");
    oddsUrl.searchParams.set("apiKey", process.env.ODDS_API_IO_KEY);
    oddsUrl.searchParams.set("eventId", eventId);
    const oddsPayload = await fetchJson(fetchImpl, oddsUrl);
    const snapshot = oddsApiIoToSnapshot(event, oddsPayload, date);
    if (snapshot) rows.push(snapshot);
  }
  return rows;
}

async function crawlApiFootballOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const rows = [];
  for (const fixture of fixtures.filter((item) => item.officialFixtureId)) {
    const url = new URL("https://v3.football.api-sports.io/odds");
    url.searchParams.set("fixture", fixture.officialFixtureId);
    const payload = await fetchJson(fetchImpl, url, { "x-apisports-key": process.env.API_FOOTBALL_KEY });
    const response = Array.isArray(payload.response) ? payload.response : [];
    const snapshot = apiFootballOddsToSnapshot(fixture, response, date);
    if (snapshot) rows.push(snapshot);
  }
  return rows;
}

async function crawlOdds1x2Odds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const rows = [];
  for (const fixture of fixtures.filter((item) => item.marketType === "jingcai")) {
    const slug = odds1x2Slug(fixture);
    if (!slug) continue;
    const url = `https://www.odds1x2.com/football/copa-libertadores/odds/${slug}/`;
    const winnerHtml = await fetchText(fetchImpl, url);
    const asianHtml = await postOdds1x2Market(fetchImpl, url, winnerHtml, "Asian Handicap");
    const existing = findMarketSnapshot(fixture, date);
    const europeanOdds = existing?.europeanOdds ? null : parseOdds1x2WinnerOdds(winnerHtml, fixture);
    const referenceEuropean = existing?.europeanOdds?.current ?? europeanOdds;
    const asianHandicap = parseOdds1x2AsianHandicap(asianHtml, fixture, oddsFavorite(referenceEuropean));
    if (!europeanOdds && !asianHandicap) continue;
    rows.push(normalizeMarketSnapshot({
      date,
      fixtureId: fixture.id,
      sequence: fixture.sequence,
      marketType: fixture.marketType,
      competition: fixture.competition,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      collectedAt: new Date().toISOString(),
      europeanOdds: europeanOdds ? { initial: europeanOdds, current: europeanOdds } : null,
      asianHandicap: asianHandicap ? { initial: asianHandicap, current: asianHandicap } : null,
      source: `Odds1x2 public odds ${url}`
    }, date));
  }
  return rows;
}

async function postOdds1x2Market(fetchImpl, url, html, market) {
  const body = new URLSearchParams();
  for (const name of ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]) {
    const value = String(html).match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1];
    if (value) body.set(name, value);
  }
  body.set("ctl00$width", "1920");
  body.set("ctl00$height", "1080");
  body.set("ctl00$ContentPlaceHolder1$mrkID", market);
  const response = await fetchWithRetry(fetchImpl, url, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 football-ai-copilot/odds-crawler",
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: url
    },
    body
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return text;
}

function odds1x2Slug(fixture) {
  const key = normalizeName(`${fixture.homeTeam}-${fixture.awayTeam}`);
  const map = {
    [normalizeName("弗鲁米嫩-玻利瓦尔")]: "fluminense-vs-bolivar",
    [normalizeName("罗萨里奥-中央大学")]: "rosario-central-vs-ucv-fc",
    [normalizeName("时刻准备-米拉索尔")]: "club-always-ready-vs-mirassol"
  };
  return map[key] ?? "";
}

function parseOdds1x2WinnerOdds(html, fixture) {
  const rows = parseOdds1x2Rows(html);
  const home = averageOdds1x2Price(rows.find((row) => sameOdds1x2Team(row.label, fixture.homeTeam))?.prices ?? []);
  const draw = averageOdds1x2Price(rows.find((row) => normalizeName(row.label) === "draw")?.prices ?? []);
  const away = averageOdds1x2Price(rows.find((row) => sameOdds1x2Team(row.label, fixture.awayTeam))?.prices ?? []);
  return [home, draw, away].every((value) => value > 1) ? { home, draw, away } : null;
}

function parseOdds1x2AsianHandicap(html, fixture, favorite = "") {
  const rows = parseOdds1x2Rows(html);
  const pairs = [];
  for (let index = 0; index < rows.length - 1; index++) {
    const home = rows[index];
    const away = rows[index + 1];
    const homeLine = odds1x2Line(home.label, fixture.homeTeam);
    const awayLine = odds1x2Line(away.label, fixture.awayTeam);
    if (!homeLine || !awayLine || Math.abs(homeLine.line + awayLine.line) > 0.001) continue;
    const homeWater = averageOdds1x2Price(home.prices);
    const awayWater = averageOdds1x2Price(away.prices);
    if (homeWater > 1 && awayWater > 1) pairs.push({ line: homeLine.line, homeWater, awayWater });
  }
  if (!pairs.length) return null;
  if (favorite === "home") return pairs.find((pair) => pair.line < 0) ?? pairs[0];
  if (favorite === "away") return pairs.find((pair) => pair.line > 0) ?? pairs[0];
  return pairs[0];
}

function parseOdds1x2Rows(html) {
  const tbody = String(html).match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
      const label = cleanHtmlText(cells[0] ?? "");
      const prices = cells.slice(1).map((cell) => Number(cleanHtmlText(cell))).filter((value) => value > 1);
      return { label, prices };
    })
    .filter((row) => row.label && row.prices.length);
}

function odds1x2Line(label, team) {
  const text = String(label ?? "");
  if (!sameOdds1x2Team(text.replace(/[+-]?\d+(?:\.\d+)?\s*$/, ""), team)) return null;
  const line = Number(text.match(/([+-]\d+(?:\.\d+)?)\s*$/)?.[1]);
  return Number.isFinite(line) ? { line } : null;
}

function sameOdds1x2Team(left, right) {
  const leftName = normalizeName(left);
  const rightName = normalizeName(right);
  const aliases = {
    [normalizeName("弗鲁米嫩")]: ["fluminense"],
    [normalizeName("玻利瓦尔")]: ["bolivar"],
    [normalizeName("罗萨里奥")]: ["rosariocentral", "rosario"],
    [normalizeName("中央大学")]: ["ucvfc", "ucv"],
    [normalizeName("时刻准备")]: ["clubalwaysready", "alwaysready"],
    [normalizeName("米拉索尔")]: ["mirassol"]
  };
  return leftName === rightName || (aliases[rightName] ?? []).includes(leftName);
}

function averageOdds1x2Price(values) {
  const valid = values.map(Number).filter((value) => value > 1);
  return valid.length ? avg(valid) : Number.NaN;
}

function oddsFavorite(odds) {
  if (!odds) return "";
  if (Number(odds.home) > 1 && Number(odds.away) > 1) return Number(odds.home) <= Number(odds.away) ? "home" : "away";
  return "";
}

async function crawlJsonUrl(url, date, fetchImpl) {
  const payload = await fetchJson(fetchImpl, url);
  const snapshots = Array.isArray(payload) ? payload : payload.snapshots ?? payload.data ?? [];
  return snapshots.map((snapshot, index) => normalizeMarketSnapshot(snapshot, date, index));
}

async function crawlCsvUrl(url, date, fetchImpl) {
  const response = await fetchImpl(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  const rows = text.split(/\r?\n/).filter(Boolean);
  const headers = rows.shift().split(",").map((item) => item.trim());
  return rows.map((row, index) => normalizeMarketSnapshot(Object.fromEntries(row.split(",").map((value, column) => [headers[column], value])), date, index));
}

async function crawlFootballDataCoUkOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const leagues = String(process.env.FOOTBALL_DATA_CO_UK_LEAGUES || "E0,E1,E2,E3,EC,SC0,SC1,N1,D1,D2,I1,I2,SP1,SP2,F1,F2,P1,B1,T1,G1").split(",").map((item) => item.trim()).filter(Boolean);
  const season = process.env.FOOTBALL_DATA_CO_UK_SEASON || footballDataCoUkSeason(date);
  const rows = [];
  for (const league of leagues) {
    const url = `https://www.football-data.co.uk/mmz4281/${season}/${league}.csv`;
    try {
      const text = await fetchText(fetchImpl, url);
      rows.push(...parseFootballDataCoUkCsv(text, date, url));
    } catch {
      // Some league/season files are not published; skip silently and continue other free files.
    }
  }
  return rows.filter((snapshot) => fixtures.some((fixture) => sameFixtureName(fixture, snapshot)));
}

async function crawlNowscoreOdds(date, fixtures, fetchImpl) {
  const rows = [];
  const idMap = readNowscoreFixtureIdMap();
  for (const fixture of fixtures) {
    const nowscoreId = idMap[fixture.id] ?? idMap[`${fixture.homeTeam}-${fixture.awayTeam}`];
    if (!nowscoreId) continue;
    const matchOddsUrl = `https://live.nowscore.com/odds/match/${nowscoreId}.htm`;
    const matchOddsHtml = await fetchText(fetchImpl, matchOddsUrl, { Referer: `https://live.nowscore.com/analysis/${nowscoreId}cn.html` });
    const snapshot = parseNowscoreMatchOddsHtml(matchOddsHtml, fixture, date, matchOddsUrl) ?? await crawlLegacyNowscoreOdds(fetchImpl, fixture, date, nowscoreId);
    if (snapshot) rows.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.NOWSCORE_CRAWL_DELAY_MS ?? 1000)));
  }
  return rows;
}

async function crawlLegacyNowscoreOdds(fetchImpl, fixture, date, nowscoreId) {
  const url = `https://live.nowscore.com/analysis/odds/${nowscoreId}.htm`;
  const html = await fetchText(fetchImpl, url);
  return parseNowscoreOddsHtml(html, fixture, date, url);
}

async function crawlCubegoalOdds(date, fixtures, fetchImpl) {
  const rows = [];
  rows.push(...await crawlCubegoalApiOdds(date, fixtures, fetchImpl));
  const idMap = readCubegoalFixtureIdMap();
  for (const fixture of fixtures) {
    if (rows.some((row) => row.fixtureId === fixture.id)) continue;
    const cubegoalId = idMap[fixture.id] ?? idMap[`${fixture.homeTeam}-${fixture.awayTeam}`];
    if (!cubegoalId) continue;
    const url = `https://www.cubegoal.com/odds/${cubegoalId}.html`;
    const html = await fetchText(fetchImpl, url);
    const snapshot = parseCubegoalOddsHtml(html, fixture, date, url);
    if (snapshot) rows.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.CUBEGOAL_CRAWL_DELAY_MS ?? 1000)));
  }
  return rows;
}

async function crawlCubegoalApiOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const fixtureDates = [...new Set(fixtures.map((fixture) => fixtureKickoffDate(fixture) ?? date).filter(Boolean))];
  const rows = [];
  const maxPages = Number(process.env.CUBEGOAL_MAX_PAGES ?? 8);
  for (const fixtureDate of fixtureDates) {
    for (let page = 1; page <= maxPages; page++) {
      const payload = await fetchCubegoalMatchFilter(fetchImpl, fixtureDate, page);
      const matches = Array.isArray(payload.data) ? payload.data : [];
      if (!matches.length) break;
      for (const match of matches) {
        const fixture = fixtures.find((item) => cubegoalSameFixture(item, match));
        if (!fixture || rows.some((row) => row.fixtureId === fixture.id)) continue;
        const snapshot = cubegoalApiMatchToSnapshot(match, fixture, date);
        if (snapshot) rows.push(snapshot);
      }
    }
  }
  return rows;
}

async function fetchCubegoalMatchFilter(fetchImpl, date, page) {
  const response = await fetchWithRetry(fetchImpl, "https://www.cubegoal.com/api/matches/filter", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 football-ai-copilot/odds-crawler",
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://www.cubegoal.com",
      Referer: `https://www.cubegoal.com/live/zuqiu`
    },
    body: JSON.stringify({ sport_prefix: "zuqiu", date, page })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

function cubegoalApiMatchToSnapshot(match, fixture, date) {
  const homeTeam = match.home_team?.name ?? match.home_team_name ?? "";
  const awayTeam = match.away_team?.name ?? match.away_team_name ?? "";
  const europeanOdds = cubegoalOutcome(match);
  const asianHandicap = cubegoalAsian(match);
  if (!europeanOdds && !asianHandicap) return null;
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam || homeTeam,
    awayTeam: fixture.awayTeam || awayTeam,
    collectedAt: new Date().toISOString(),
    europeanOdds: europeanOdds ? { initial: europeanOdds, current: europeanOdds } : null,
    asianHandicap: asianHandicap ? { initial: asianHandicap, current: asianHandicap } : null,
    source: `CubeGoal public match filter API https://www.cubegoal.com/odds/${match.id}.html`
  }, date);
}

function cubegoalOutcome(match) {
  const home = Number(match.euro_odds_home);
  const draw = Number(match.euro_odds_draw);
  const away = Number(match.euro_odds_away);
  return [home, draw, away].every((value) => value > 1) ? { home, draw, away } : null;
}

function cubegoalAsian(match) {
  const homeWater = Number(match.asian_handicap_home);
  const line = Number(match.asian_handicap_line);
  const awayWater = Number(match.asian_handicap_away);
  return Number.isFinite(line) && homeWater > 1 && awayWater > 1 ? { line, homeWater, awayWater } : null;
}

function cubegoalSameFixture(fixture, match) {
  const homeTeam = match.home_team?.name ?? match.home_team_name ?? "";
  const awayTeam = match.away_team?.name ?? match.away_team_name ?? "";
  const home = cubegoalTeamKey(homeTeam);
  const away = cubegoalTeamKey(awayTeam);
  const fixtureHome = cubegoalTeamKey(fixture.homeTeam);
  const fixtureAway = cubegoalTeamKey(fixture.awayTeam);
  if (home === fixtureHome && away === fixtureAway) return true;
  if (home === fixtureAway && away === fixtureHome) return true;
  return false;
}

function cubegoalTeamKey(value) {
  const key = normalizeName(value);
  const aliases = {
    [normalizeName("\u57c3\u592b\u65af\u5821")]: normalizeName("\u57c3\u5c14\u592b\u65af\u5821"),
    [normalizeName("\u57c3\u5c14\u592b\u65af\u5821")]: normalizeName("\u57c3\u5c14\u592b\u65af\u5821"),
    [normalizeName("\u6c83\u592b\u65af\u5821")]: normalizeName("\u6c83\u5c14\u592b\u65af\u5821"),
    [normalizeName("\u6c83\u5c14\u592b\u65af\u5821")]: normalizeName("\u6c83\u5c14\u592b\u65af\u5821"),
    [normalizeName("京都")]: normalizeName("京都不死鸟"),
    [normalizeName("京都不死鸟")]: normalizeName("京都不死鸟"),
    [normalizeName("哈尔姆斯")]: normalizeName("哈尔姆斯塔德"),
    [normalizeName("哈尔姆斯塔德")]: normalizeName("哈尔姆斯塔德"),
    [normalizeName("厄格里特")]: normalizeName("厄尔格里特"),
    [normalizeName("厄尔格里特")]: normalizeName("厄尔格里特"),
    [normalizeName("米堡")]: normalizeName("米德尔斯堡"),
    [normalizeName("米德尔斯堡")]: normalizeName("米德尔斯堡")
  };
  return aliases[key] ?? key;
}

function fixtureKickoffDate(fixture) {
  return String(fixture?.kickoff ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

async function crawlSinaShengfucaiOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const shengfucaiFixtures = fixtures.filter((fixture) => fixture.marketType === "shengfucai");
  if (!shengfucaiFixtures.length) return [];
  const issue = shengfucaiIssue(shengfucaiFixtures);
  const articleUrl = process.env.SINA_SFC_ODDS_URL || await discoverSinaShengfucaiOddsArticle(issue, fetchImpl);
  if (!articleUrl) return [];
  const html = await fetchText(fetchImpl, articleUrl);
  return parseSinaShengfucaiOddsHtml(html, shengfucaiFixtures, date, articleUrl);
}

async function crawlSinaShengfucaiMacauOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const shengfucaiFixtures = fixtures.filter((fixture) => fixture.marketType === "shengfucai");
  if (!shengfucaiFixtures.length) return [];
  const issue = shengfucaiIssue(shengfucaiFixtures);
  const articleUrl = process.env.SINA_SFC_MACAU_ODDS_URL || await discoverSinaShengfucaiMacauArticle(issue, fetchImpl);
  if (!articleUrl) return [];
  const html = await fetchText(fetchImpl, articleUrl);
  return parseSinaShengfucaiMacauHtml(html, shengfucaiFixtures, date, articleUrl);
}

async function crawlSinaShengfucaiEuroAsianContrast(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const shengfucaiFixtures = fixtures.filter((fixture) => fixture.marketType === "shengfucai");
  if (!shengfucaiFixtures.length) return [];
  const issue = shengfucaiIssue(shengfucaiFixtures);
  const articleUrl = process.env.SINA_SFC_EURO_ASIAN_URL || await discoverSinaEuroAsianContrastArticle(issue, fetchImpl);
  if (!articleUrl) return [];
  const html = await fetchText(fetchImpl, articleUrl);
  return parseSinaEuroAsianContrastHtml(html, fixtures, date, articleUrl);
}

async function crawlFiveHundredShengfucaiEuropeanOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const shengfucaiFixtures = fixtures
    .filter((fixture) => fixture.marketType === "shengfucai")
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (!shengfucaiFixtures.length) return [];
  const issue = shengfucaiIssue(shengfucaiFixtures);
  if (!issue) return [];
  const indexUrl = `https://zx.500.com/zc/odds_sfc.php_blank?expect=${issue}`;
  const fidRows = await readFiveHundredSfcFids(fetchImpl, indexUrl, shengfucaiFixtures, date);
  const rows = [];
  for (let index = 0; index < Math.min(fidRows.length, shengfucaiFixtures.length); index++) {
    const fixture = shengfucaiFixtures[index];
    const fidRow = fidRows[index];
    if (!fidRow?.fid) continue;
    const sourceUrl = `https://odds.500.com/fenxi/ouzhi-${fidRow.fid}.shtml`;
    try {
      const html = await fetchTextWithEncoding(fetchImpl, sourceUrl, "gb18030");
      const snapshot = parseFiveHundredEuropeanOddsHtml(html, fixture, date, sourceUrl);
      if (snapshot) rows.push(snapshot);
    } catch {
      // Some public pages throttle individual requests; keep the rest of the source usable.
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIVEHUNDRED_CRAWL_DELAY_MS ?? 250)));
  }
  return rows;
}

async function crawlFiveHundredShengfucaiAsianOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 环境不支持 fetch");
  const shengfucaiFixtures = fixtures
    .filter((fixture) => fixture.marketType === "shengfucai")
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  if (!shengfucaiFixtures.length) return [];
  const issue = shengfucaiIssue(shengfucaiFixtures);
  if (!issue) return [];
  const indexUrl = `https://zx.500.com/zc/odds_sfc.php_blank?expect=${issue}`;
  const fidRows = await readFiveHundredSfcFids(fetchImpl, indexUrl, shengfucaiFixtures, date);
  const rows = [];
  for (let index = 0; index < Math.min(fidRows.length, shengfucaiFixtures.length); index++) {
    const fixture = shengfucaiFixtures[index];
    const fidRow = fidRows[index];
    if (!fidRow?.fid) continue;
    const sourceUrl = `https://odds.500.com/fenxi/yazhi-${fidRow.fid}.shtml`;
    try {
      const html = await fetchTextWithEncoding(fetchImpl, sourceUrl, "gb18030");
      const snapshot = parseFiveHundredAsianOddsHtml(html, fixture, date, sourceUrl);
      if (snapshot) rows.push(snapshot);
    } catch {
      // Some public pages throttle individual requests; keep the rest of the source usable.
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIVEHUNDRED_CRAWL_DELAY_MS ?? 250)));
  }
  return rows;
}

async function crawlFiveHundredJingcaiAsianOdds(date, fixtures, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("褰撳墠 Node 鐜涓嶆敮鎸?fetch");
  const jingcaiFixtures = fixtures
    .filter((fixture) => fixture.marketType === "jingcai")
    .sort((left, right) => jingcaiSequenceNumber(left.sequence) - jingcaiSequenceNumber(right.sequence));
  if (!jingcaiFixtures.length) return [];
  const indexUrl = process.env.FIVEHUNDRED_JC_INDEX_URL || `https://trade.500.com/jczq/?date=${date}`;
  const indexHtml = await fetchTextWithEncoding(fetchImpl, indexUrl, "gb18030");
  const fixtureIds = parseFiveHundredJingcaiFixtureIds(indexHtml);
  const rows = [];
  for (const fixture of jingcaiFixtures) {
    const fid = fixtureIds.get(String(fixture.sequence)) ?? fixtureIds.get(String(jingcaiSequenceNumber(fixture.sequence)));
    if (!fid) continue;
    const sourceUrl = `https://odds.500.com/fenxi/yazhi-${fid}.shtml`;
    try {
      const html = await fetchTextWithEncoding(fetchImpl, sourceUrl, "gb18030");
      const snapshot = parseFiveHundredAsianOddsHtml(html, fixture, date, sourceUrl);
      if (snapshot) rows.push(snapshot);
    } catch {
      // Some public pages throttle individual requests; keep the rest of the source usable.
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.FIVEHUNDRED_CRAWL_DELAY_MS ?? 250)));
  }
  return rows;
}

function parseFiveHundredJingcaiFixtureIds(html) {
  const rows = [...String(html).matchAll(/<tr\b([^>]*\bclass=["'][^"']*bet-tb-tr[^"']*["'][^>]*)>/gi)];
  const map = new Map();
  for (const row of rows) {
    const attrs = htmlAttributes(row[1]);
    const fixtureId = attrs["data-fixtureid"];
    const matchNum = attrs["data-matchnum"];
    if (!fixtureId || !matchNum) continue;
    map.set(matchNum, fixtureId);
    map.set(String(jingcaiSequenceNumber(matchNum)), fixtureId);
  }
  return map;
}

function htmlAttributes(value) {
  return Object.fromEntries([...String(value ?? "").matchAll(/\b([\w:-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1].toLowerCase(), decodeHtmlText(match[2])]));
}

function jingcaiSequenceNumber(value) {
  const number = String(value ?? "").match(/(\d{1,3})/)?.[1];
  return number ? Number(number) : Number.POSITIVE_INFINITY;
}

async function discoverSinaShengfucaiOddsArticle(issue, fetchImpl) {
  const indexUrls = ["https://lottery.sina.com.cn/", "https://sports.sina.com.cn/lottery/"];
  for (const url of indexUrls) {
    const html = await fetchText(fetchImpl, url);
    const candidates = extractAnchors(html)
      .filter((anchor) => anchor.title.includes("胜负彩") && anchor.title.includes("欧洲四大机构") && (!issue || anchor.title.includes(issue)))
      .map((anchor) => ({ ...anchor, score: (anchor.title.includes(`第${issue}期`) ? 4 : 0) + (anchor.title.includes("最新数据") ? 2 : 0) + (anchor.href.startsWith("https://sports.sina.com.cn/l/") ? 1 : 0) }))
      .sort((left, right) => right.score - left.score);
    if (candidates[0]) return new URL(candidates[0].href, url).href;
  }
  return null;
}

async function discoverSinaShengfucaiMacauArticle(issue, fetchImpl) {
  const indexUrls = ["https://lottery.sina.com.cn/", "https://sports.sina.com.cn/lottery/"];
  for (const url of indexUrls) {
    const html = await fetchText(fetchImpl, url);
    const candidates = extractAnchors(html)
      .filter((anchor) => anchor.title.includes("胜负彩") && anchor.title.includes("澳盘") && (!issue || anchor.title.includes(issue)))
      .map((anchor) => ({ ...anchor, score: (anchor.title.includes(`${issue}期`) ? 4 : 0) + (anchor.title.includes("最新赔率") ? 2 : 0) + (anchor.href.startsWith("https://sports.sina.com.cn/l/") ? 1 : 0) }))
      .sort((left, right) => right.score - left.score);
    if (candidates[0]) return new URL(candidates[0].href, url).href;
  }
  return null;
}

async function discoverSinaEuroAsianContrastArticle(issue, fetchImpl) {
  const indexUrls = ["https://lottery.sina.com.cn/", "https://sports.sina.com.cn/lottery/"];
  for (const url of indexUrls) {
    const html = await fetchText(fetchImpl, url);
    const candidates = extractAnchors(html)
      .filter((anchor) => anchor.title.includes("欧亚") && (!issue || anchor.title.includes(issue)))
      .map((anchor) => ({ ...anchor, score: (issue && anchor.title.includes(issue) ? 4 : 0) + (anchor.href.startsWith("https://sports.sina.com.cn/l/") ? 1 : 0) }))
      .sort((left, right) => right.score - left.score);
    if (candidates[0]) return new URL(candidates[0].href, url).href;
  }
  return null;
}

export function parseSinaEuroAsianContrastHtml(html, fixtures, date, sourceUrl = "") {
  const shengfucaiFixtures = fixtures
    .filter((fixture) => fixture.marketType === "shengfucai")
    .sort((left, right) => Number(left.sequence) - Number(right.sequence));
  const parsedRows = parseSinaEuroAsianRows(cleanHtmlText(html));
  const articleCollectedAt = extractSinaArticleCollectedAt(html);
  const rows = [];
  parsedRows.forEach((row, index) => {
    const matched = new Map();
    const shengfucaiFixture = shengfucaiFixtures[index];
    if (shengfucaiFixture) matched.set(shengfucaiFixture.id, shengfucaiFixture);
    for (const fixture of fixtures) {
      if (sameSinaEuroAsianTeam(fixture.homeTeam, row.homeTeam) && sameSinaEuroAsianTeam(fixture.awayTeam, row.awayTeam)) {
        matched.set(fixture.id, fixture);
      }
    }
    for (const fixture of matched.values()) {
      rows.push(normalizeMarketSnapshot({
        date,
        fixtureId: fixture.id,
        sequence: fixture.sequence,
        marketType: fixture.marketType,
        competition: fixture.competition,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        collectedAt: articleCollectedAt ?? new Date().toISOString(),
        europeanOdds: row.europeanOdds ? { initial: row.europeanOdds, current: row.europeanOdds } : null,
        asianHandicap: row.currentAsian ? { initial: row.convertedAsian ?? row.currentAsian, current: row.currentAsian } : null,
        source: sourceUrl ? `Sina euro-asian contrast ${sourceUrl}` : "Sina euro-asian contrast"
      }, date));
    }
  });
  return rows;
}

export function parseSinaShengfucaiOddsHtml(html, fixtures, date, sourceUrl = "") {
  const fixturesBySequence = new Map(fixtures.map((fixture) => [String(fixture.sequence), fixture]));
  const articleCollectedAt = extractSinaArticleCollectedAt(html);
  const parsed = [];
  let current = null;
  for (const cells of extractTableRows(html)) {
    if (/^\d+$/.test(cells[0] ?? "")) {
      if (current) parsed.push(finalizeSinaSfcOddsGroup(current, date, sourceUrl, articleCollectedAt));
      const fixture = fixturesBySequence.get(String(Number(cells[0])));
      current = fixture ? {
        fixture,
        matchLabel: cells[1],
        initialTriples: parseSinaBookmakerTriples(cells.slice(2)),
        currentTriples: parseSinaBookmakerTriples(cells.slice(2)),
        latestTimeText: ""
      } : null;
      continue;
    }
    if (!current || !/^\d{1,2}日\s*\d{1,2}:\d{2}$/.test(cells[1] ?? "")) continue;
    const updates = parseSinaBookmakerTriples(cells.slice(2));
    current.currentTriples = current.currentTriples.map((triple, index) => updates[index] ?? triple);
    current.latestTimeText = cells[1];
  }
  if (current) parsed.push(finalizeSinaSfcOddsGroup(current, date, sourceUrl, articleCollectedAt));
  return parsed.filter(Boolean);
}

export function parseSinaShengfucaiMacauHtml(html, fixtures, date, sourceUrl = "") {
  const fixturesBySequence = new Map(fixtures.map((fixture) => [String(fixture.sequence), fixture]));
  const articleCollectedAt = extractSinaArticleCollectedAt(html);
  const parsed = [];
  let current = null;
  for (const cells of extractTableRows(html)) {
    const sequence = String(cells[1] ?? "").match(/^(\d{1,2})\s+/)?.[1];
    if (sequence) {
      if (current) parsed.push(finalizeSinaMacauGroup(current, date, sourceUrl, articleCollectedAt));
      const fixture = fixturesBySequence.get(String(Number(sequence)));
      current = fixture ? {
        fixture,
        initial: parseSinaMacauPoint(cells),
        current: parseSinaMacauPoint(cells),
        latestTimeText: ""
      } : null;
      continue;
    }
    if (!current || !/^周[一二三四五六日]\d{1,2}:\d{2}$/.test(cells[1] ?? "")) continue;
    const update = parseSinaMacauPoint(cells);
    if (update) {
      current.current = update;
      current.latestTimeText = cells[1];
    }
  }
  if (current) parsed.push(finalizeSinaMacauGroup(current, date, sourceUrl, articleCollectedAt));
  return parsed.filter(Boolean);
}

function oddsApiEventToSnapshot(event) {
  const h2h = aggregateMarket(event, "h2h", event.home_team, event.away_team);
  const spread = aggregateSpread(event, event.home_team, event.away_team);
  if (!h2h && !spread) return null;
  return normalizeMarketSnapshot({ date: String(event.commence_time).slice(0, 10), homeTeam: event.home_team, awayTeam: event.away_team, competition: event.sport_title, collectedAt: latestBookmakerUpdate(event.bookmakers) ?? new Date().toISOString(), europeanOdds: h2h ? { current: h2h } : null, asianHandicap: spread ? { current: spread } : null, source: "The Odds API" }, String(event.commence_time).slice(0, 10));
}

function parseFootballDataCoUkCsv(text, date, sourceUrl) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() ?? "").map((item) => item.trim());
  return lines
    .map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])))
    .filter((row) => normalizeFootballDataCoUkDate(row.Date) === date)
    .map((row, index) => footballDataCoUkRowToSnapshot(row, date, index, sourceUrl))
    .filter(Boolean);
}

function footballDataCoUkRowToSnapshot(row, date, index, sourceUrl) {
  const homeTeam = row.HomeTeam;
  const awayTeam = row.AwayTeam;
  if (!homeTeam || !awayTeam) return null;
  const initialEuropean = outcomeFromColumns(row, ["AvgH", "B365H", "MaxH"], ["AvgD", "B365D", "MaxD"], ["AvgA", "B365A", "MaxA"]);
  const currentEuropean = outcomeFromColumns(row, ["AvgCH", "B365CH", "MaxCH", "AvgH", "B365H"], ["AvgCD", "B365CD", "MaxCD", "AvgD", "B365D"], ["AvgCA", "B365CA", "MaxCA", "AvgA", "B365A"]);
  const initialAsian = asianFromColumns(row, ["AHh"], ["AvgAHH", "B365AHH", "MaxAHH"], ["AvgAHA", "B365AHA", "MaxAHA"]);
  const currentAsian = asianFromColumns(row, ["AHCh", "AHh"], ["AvgCAHH", "B365CAHH", "MaxCAHH", "AvgAHH", "B365AHH"], ["AvgCAHA", "B365CAHA", "MaxCAHA", "AvgAHA", "B365AHA"]);
  if (!initialEuropean && !currentEuropean && !initialAsian && !currentAsian) return null;
  const kickoff = footballDataCoUkKickoffIso(row.Date, row.Time);
  return normalizeMarketSnapshot({
    date,
    id: `football-data-co-uk-${date}-${normalizeName(`${homeTeam}-${awayTeam}`)}-${index + 1}`,
    competition: row.Div ?? "",
    homeTeam,
    awayTeam,
    collectedAt: kickoff ?? new Date().toISOString(),
    europeanOdds: initialEuropean || currentEuropean ? { initial: initialEuropean ?? currentEuropean, current: currentEuropean ?? initialEuropean } : null,
    asianHandicap: initialAsian || currentAsian ? { initial: initialAsian ?? currentAsian, current: currentAsian ?? initialAsian } : null,
    source: `football-data.co.uk CSV ${sourceUrl}`
  }, date, index);
}

function footballDataCoUkSeason(date) {
  const [yearText, monthText] = String(date).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const start = month >= 7 ? year : year - 1;
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
}

function normalizeFootballDataCoUkDate(value) {
  const match = String(value ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function footballDataCoUkKickoffIso(dateText, timeText) {
  const date = normalizeFootballDataCoUkDate(dateText);
  const time = String(timeText || "12:00").match(/(\d{1,2}):(\d{2})/);
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, Number(time[1]), Number(time[2]), 0)).toISOString();
}

function outcomeFromColumns(row, homeColumns, drawColumns, awayColumns) {
  const home = firstNumber(row, homeColumns);
  const draw = firstNumber(row, drawColumns);
  const away = firstNumber(row, awayColumns);
  return [home, draw, away].every((value) => Number(value) > 1) ? { home, draw, away } : null;
}

function asianFromColumns(row, lineColumns, homeColumns, awayColumns) {
  const line = firstNumber(row, lineColumns);
  const homeWater = firstNumber(row, homeColumns);
  const awayWater = firstNumber(row, awayColumns);
  return [line, homeWater, awayWater].every(Number.isFinite) ? { line, homeWater, awayWater } : null;
}

function firstNumber(row, columns) {
  for (const column of columns) {
    const value = Number(row[column]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
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

function aggregateMarket(event, key, homeTeam, awayTeam) {
  const points = [];
  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets?.find((item) => item.key === key);
    if (!market) continue;
    const home = market.outcomes?.find((outcome) => sameTeam(outcome.name, homeTeam))?.price;
    const draw = market.outcomes?.find((outcome) => /draw|tie|平/i.test(outcome.name))?.price;
    const away = market.outcomes?.find((outcome) => sameTeam(outcome.name, awayTeam))?.price;
    if ([home, draw, away].every((value) => Number(value) > 1)) points.push({ home: Number(home), draw: Number(draw), away: Number(away) });
  }
  return averageOutcome(points);
}

function aggregateSpread(event, homeTeam, awayTeam) {
  const points = [];
  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets?.find((item) => item.key === "spreads");
    const home = market?.outcomes?.find((outcome) => sameTeam(outcome.name, homeTeam));
    const away = market?.outcomes?.find((outcome) => sameTeam(outcome.name, awayTeam));
    if (home && away) points.push({ line: Number(home.point), homeWater: Number(home.price), awayWater: Number(away.price) });
  }
  if (!points.length) return null;
  return { line: avg(points.map((item) => item.line)), homeWater: avg(points.map((item) => item.homeWater)), awayWater: avg(points.map((item) => item.awayWater)) };
}

function alignSnapshots(candidates, fixtures) {
  return candidates.map((candidate, index) => {
    const fixture = candidate.fixtureId
      ? fixtures.find((item) => item.id === candidate.fixtureId)
      : fixtures.find((item) => normalizeName(item.homeTeam) === normalizeName(candidate.homeTeam) && normalizeName(item.awayTeam) === normalizeName(candidate.awayTeam));
    if (!fixture) return null;
    return normalizeMarketSnapshot({ ...candidate, fixtureId: fixture.id, sequence: fixture.sequence, marketType: fixture.marketType, date: fixture.date, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam }, fixture.date, index);
  }).filter(Boolean);
}

function mergeSnapshots(previous, next) {
  const map = new Map(previous.map((snapshot) => [snapshot.fixtureId || `${snapshot.homeTeam}-${snapshot.awayTeam}`, snapshot]));
  for (const snapshot of next) {
    const key = snapshot.fixtureId || `${snapshot.homeTeam}-${snapshot.awayTeam}`;
    const existing = map.get(key) ?? {};
    map.set(key, {
      ...existing,
      ...snapshot,
      europeanOdds: snapshot.europeanOdds ?? existing.europeanOdds ?? null,
      asianHandicap: snapshot.asianHandicap ?? existing.asianHandicap ?? null,
      handicapOdds: snapshot.handicapOdds ?? existing.handicapOdds ?? null,
      totals: snapshot.totals ?? existing.totals ?? null,
      collectedAt: latestIso(existing.collectedAt, snapshot.collectedAt),
      source: mergeSourceNames(existing.source, snapshot.source)
    });
  }
  return [...map.values()];
}

async function crawlSgOddsMapped(date, fixtures, fetchImpl) {
  const mapPath = join(getDataSubdir("sgodds-urls.json"));
  if (!existsSync(mapPath)) return [];
  const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
  const rows = [];
  for (const fixture of fixtures) {
    const url = mapping[fixture.id] ?? mapping[`${fixture.homeTeam}-${fixture.awayTeam}`];
    if (!url) continue;
    const html = await fetchText(fetchImpl, url, { Referer: "https://sgodds.com/football/current-odds" });
    const snapshot = parseSgOddsHtml(html, fixture, date, url);
    if (snapshot) rows.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.SGODDS_CRAWL_DELAY_MS ?? 600)));
  }
  return rows;
}

function parseSgOddsHtml(html, fixture, date, sourceUrl = "") {
  const collectedAt = new Date().toISOString();
  const oneXTwoRows = parseSgOddsSectionRows(html, "1X2");
  const handicapRows = parseSgOddsSectionRows(html, "1/2 Goal");
  const europeanOdds = sgOddsEuropeanOdds(oneXTwoRows);
  const asianHandicap = sgOddsAsianHandicap(handicapRows, fixture.homeTeam);
  if (!europeanOdds && !asianHandicap) return null;
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt,
    europeanOdds: europeanOdds ? { initial: europeanOdds.initial, current: europeanOdds.current } : null,
    asianHandicap: asianHandicap ? { initial: asianHandicap.initial, current: asianHandicap.current } : null,
    source: sourceUrl ? `SGOdds public odds ${sourceUrl}` : "SGOdds public odds"
  }, date);
}

function parseSgOddsSectionRows(html, title) {
  const containers = [...String(html).matchAll(/<div class="container mt-3">([\s\S]*?)(?=<div class="container mt-3">|$)/gi)];
  const section = containers
    .map((match) => match[0])
    .find((segment) => cleanHtmlText(segment.match(/<div class="col border font-weight-bold py-1">([\s\S]*?)<\/div>/i)?.[1] ?? "").includes(title));
  if (!section) return [];
  return [...section.matchAll(/<div class="col-4[^"]*text-center">([\s\S]*?)<\/div><div class="col-2 py-1">([\d.]+)<\/div><div class="col-2 font-weight-bold py-1">([\d.]+)<\/div>/gi)]
    .map((match) => ({ label: cleanHtmlText(match[1]), initial: Number(match[2]), current: Number(match[3]) }))
    .filter((row) => row.label && row.initial > 1 && row.current > 1);
}

function sgOddsEuropeanOdds(rows) {
  const home = rows[0];
  const draw = rows.find((row) => /^draw$/i.test(row.label));
  const away = rows.find((row, index) => index > 0 && !/^draw$/i.test(row.label));
  if (!home || !draw || !away) return null;
  return {
    initial: { home: home.initial, draw: draw.initial, away: away.initial },
    current: { home: home.current, draw: draw.current, away: away.current }
  };
}

function sgOddsAsianHandicap(rows, homeTeam) {
  if (rows.length < 2) return null;
  const homeKey = normalizeName(homeTeam);
  const home = rows.find((row) => normalizeName(row.label).includes(homeKey)) ?? rows[0];
  const away = rows.find((row) => row !== home) ?? rows[1];
  const line = sgOddsLineFromLabel(home.label);
  if (!Number.isFinite(line) || !home || !away) return null;
  return {
    initial: { line, homeWater: home.initial, awayWater: away.initial },
    current: { line, homeWater: home.current, awayWater: away.current }
  };
}

function sgOddsLineFromLabel(label) {
  const match = String(label ?? "").match(/([+-]\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : Number.NaN;
}

async function crawlBetExplorerMapped(date, fixtures, fetchImpl) {
  const mapPath = join(getDataSubdir("betexplorer-urls.json"));
  if (!existsSync(mapPath)) return [];
  const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
  const rows = [];
  for (const fixture of fixtures) {
    const eventIdOrUrl = mapping[fixture.id] ?? mapping[`${fixture.homeTeam}-${fixture.awayTeam}`];
    if (!eventIdOrUrl) continue;
    const eventId = betExplorerEventId(eventIdOrUrl);
    if (!eventId) continue;
    const sourceUrl = String(eventIdOrUrl).startsWith("http") ? eventIdOrUrl : `https://www.betexplorer.com/match-odds-old/${eventId}/0/ah/0/en/`;
    const apiUrl = `https://www.betexplorer.com/match-odds-old/${eventId}/0/ah/0/en/`;
    const payload = await fetchJson(fetchImpl, apiUrl, { Accept: "application/json", Referer: sourceUrl });
    const snapshot = parseBetExplorerAsianOdds(payload.odds ?? "", fixture, date, sourceUrl);
    if (snapshot) rows.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.BETEXPLORER_CRAWL_DELAY_MS ?? 600)));
  }
  return rows;
}

function betExplorerEventId(value) {
  const text = String(value ?? "");
  return text.match(/\/([A-Za-z0-9]{8})\/?(?:asian-handicap\/?)?$/)?.[1] ?? text.match(/^[A-Za-z0-9]{8}$/)?.[0] ?? "";
}

function parseBetExplorerAsianOdds(html, fixture, date, sourceUrl = "") {
  const rows = [...String(html).matchAll(/<tr\b[^>]*data-bid=[\s\S]*?<\/tr>/gi)]
    .map((match) => parseBetExplorerAsianRow(match[0]))
    .filter(Boolean);
  if (!rows.length) return null;
  const grouped = new Map();
  for (const row of rows) {
    const group = grouped.get(row.line) ?? [];
    group.push(row);
    grouped.set(row.line, group);
  }
  const linePoints = [...grouped.entries()].map(([line, points]) => ({
    line,
    homeWater: avg(points.map((point) => point.homeWater)),
    awayWater: avg(points.map((point) => point.awayWater)),
    collectedAt: points.map((point) => point.collectedAt).filter(Boolean).sort().at(-1) ?? null,
    balanceScore: Math.abs(avg(points.map((point) => point.homeWater)) - 1.9) + Math.abs(avg(points.map((point) => point.awayWater)) - 1.9)
  })).sort((left, right) => left.balanceScore - right.balanceScore);
  const point = linePoints[0];
  if (!point) return null;
  const asianHandicap = { line: point.line, homeWater: avg([point.homeWater]), awayWater: avg([point.awayWater]) };
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: point.collectedAt ?? new Date().toISOString(),
    asianHandicap: { initial: asianHandicap, current: asianHandicap },
    source: sourceUrl ? `BetExplorer public Asian Handicap ${sourceUrl}` : "BetExplorer public Asian Handicap"
  }, date);
}

function parseBetExplorerAsianRow(rowHtml) {
  const line = Number(rowHtml.match(/<td class="table-main__doubleparameter">([+-]?\d+(?:\.\d+)?)<\/td>/i)?.[1]);
  const odds = [...rowHtml.matchAll(/\bdata-odd="([\d.]+)"/g)].map((match) => Number(match[1])).filter((value) => value > 1);
  const created = [...rowHtml.matchAll(/\bdata-created="([^"]+)"/g)].map((match) => match[1]).at(-1);
  if (!Number.isFinite(line) || odds.length < 2) return null;
  return { line, homeWater: odds[0], awayWater: odds[1], collectedAt: betExplorerCollectedAt(created) };
}

function betExplorerCollectedAt(value) {
  const match = String(value ?? "").match(/(\d{1,2}),(\d{1,2}),(\d{4}),(\d{1,2}),(\d{2})/);
  return match ? shanghaiDateTimeToIso(match[3], match[2], match[1], match[4], match[5], "00") : null;
}

async function crawlLiaogouMappedOdds(date, fixtures, fetchImpl) {
  const mapping = {
    "jc-2026-05-23-周六002-奥克兰fc-悉尼fc": "https://vip.liaogou168.com/match_detail/20260523/2518580.html?type=2",
    ...parseJsonEnv("LIAOGOU_FIXTURE_URLS")
  };
  const rows = [];
  for (const fixture of fixtures) {
    const url = mapping[fixture.id] ?? mapping[`${fixture.homeTeam}-${fixture.awayTeam}`];
    if (!url) continue;
    const html = await fetchText(fetchImpl, url);
    const snapshot = parseLiaogouMatchSummaryOdds(html, fixture, date, url);
    if (snapshot) rows.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LIAOGOU_CRAWL_DELAY_MS ?? 600)));
  }
  return rows;
}

function parseLiaogouMatchSummaryOdds(html, fixture, date, sourceUrl = "") {
  const text = cleanHtmlText(html);
  const asianMatch = text.match(/亚[:：]\s*([\d.]+)\s+([^欧大]+?)\s+([\d.]+)/);
  if (!asianMatch) return null;
  const euroMatch = text.match(/欧[:：]\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const homeWater = Number(asianMatch[1]);
  const rawLine = liaogouAsianLine(asianMatch[2]);
  const awayWater = Number(asianMatch[3]);
  const euro = euroMatch ? parseNowscoreMatchEuropean(euroMatch[1], euroMatch[2], euroMatch[3]) : null;
  const homeFavored = euro ? euro.home <= euro.away : true;
  const line = rawLine === 0 ? 0 : homeFavored ? -Math.abs(rawLine) : Math.abs(rawLine);
  if (![homeWater, line, awayWater].every(Number.isFinite)) return null;
  const asianHandicap = { line, homeWater, awayWater };
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: new Date().toISOString(),
    asianHandicap: { initial: asianHandicap, current: asianHandicap },
    europeanOdds: euro ? { initial: euro, current: euro } : null,
    source: sourceUrl ? `料狗公开赛前盘口 ${sourceUrl}` : "料狗公开赛前盘口"
  }, date);
}

function liaogouAsianLine(value) {
  const text = String(value ?? "").replace(/&nbsp;/g, " ").trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.abs(numeric);
  return Math.abs(nowscoreChineseAsianLine(text.replace(/^让|^受让|^受/, "")));
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const response = await fetchWithRetry(fetchImpl, url, { headers: { "User-Agent": "football-ai-copilot/odds-crawler", ...headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

async function fetchText(fetchImpl, url, headers = {}) {
  const response = await fetchWithRetry(fetchImpl, url, { headers: { "User-Agent": "Mozilla/5.0 football-ai-copilot/odds-crawler", ...headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return text;
}

async function fetchTextWithEncoding(fetchImpl, url, encoding = "utf-8", headers = {}) {
  const response = await fetchWithRetry(fetchImpl, url, { headers: { "User-Agent": "Mozilla/5.0 football-ai-copilot/odds-crawler", ...headers } });
  const bytes = await response.arrayBuffer();
  const text = new TextDecoder(encoding).decode(bytes);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  return text;
}

async function fetchWithRetry(fetchImpl, url, options = {}) {
  const attempts = Number(process.env.ODDS_CRAWLER_RETRY_ATTEMPTS ?? 3);
  const timeoutMs = Number(process.env.ODDS_CRAWLER_TIMEOUT_MS ?? 15000);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(String(url), { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok || attempt === attempts || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw lastError ?? new Error(`请求失败：${url}`);
}

function oddsApiIoToSnapshot(event, oddsPayload, date) {
  const oddsRows = Array.isArray(oddsPayload) ? oddsPayload : oddsPayload.data ?? oddsPayload.odds ?? oddsPayload.bookmakers ?? [];
  const homeTeam = event.homeTeam ?? event.home_team ?? event.home?.name ?? event.teams?.home?.name ?? event.home;
  const awayTeam = event.awayTeam ?? event.away_team ?? event.away?.name ?? event.teams?.away?.name ?? event.away;
  const h2h = extractOutcomeOdds(oddsRows, homeTeam, awayTeam);
  const spread = extractSpreadOdds(oddsRows, homeTeam, awayTeam);
  if (!h2h && !spread) return null;
  return normalizeMarketSnapshot({
    date,
    homeTeam,
    awayTeam,
    competition: event.league ?? event.competition ?? event.sport ?? "",
    collectedAt: new Date().toISOString(),
    europeanOdds: h2h ? { current: h2h } : null,
    asianHandicap: spread ? { current: spread } : null,
    source: "Odds-API.io"
  }, date);
}

function apiFootballOddsToSnapshot(fixture, response, date) {
  const bets = response.flatMap((row) => row.bookmakers ?? []).flatMap((bookmaker) => bookmaker.bets ?? []);
  const winnerBet = bets.find((bet) => /match winner|1x2|fulltime result/i.test(String(bet.name ?? bet.label ?? "")));
  const handicapBet = bets.find((bet) => /asian handicap|handicap/i.test(String(bet.name ?? bet.label ?? "")));
  const h2h = valuesToOutcomeOdds(winnerBet?.values, fixture.homeTeam, fixture.awayTeam);
  const spread = valuesToSpreadOdds(handicapBet?.values, fixture.homeTeam, fixture.awayTeam);
  if (!h2h && !spread) return null;
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    competition: fixture.competition,
    collectedAt: new Date().toISOString(),
    europeanOdds: h2h ? { current: h2h } : null,
    asianHandicap: spread ? { current: spread } : null,
    source: "API-Football Odds"
  }, date);
}

function extractOutcomeOdds(rows, homeTeam, awayTeam) {
  const flat = flattenOdds(rows);
  return valuesToOutcomeOdds(flat, homeTeam, awayTeam);
}

function extractSpreadOdds(rows, homeTeam, awayTeam) {
  const flat = flattenOdds(rows);
  return valuesToSpreadOdds(flat, homeTeam, awayTeam);
}

function flattenOdds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenOdds);
  if (typeof value !== "object") return [];
  const nested = [value.markets, value.outcomes, value.values, value.odds, value.bookmakers].filter(Boolean).flatMap(flattenOdds);
  return nested.length ? nested : [value];
}

function valuesToOutcomeOdds(values = [], homeTeam, awayTeam) {
  const rows = Array.isArray(values) ? values : [];
  const home = findPrice(rows, homeTeam, ["home", "1"]);
  const draw = findPrice(rows, "draw", ["draw", "x", "tie"]);
  const away = findPrice(rows, awayTeam, ["away", "2"]);
  return [home, draw, away].every((value) => Number(value) > 1) ? { home: Number(home), draw: Number(draw), away: Number(away) } : null;
}

function valuesToSpreadOdds(values = [], homeTeam, awayTeam) {
  const rows = Array.isArray(values) ? values : [];
  const home = findOutcome(rows, homeTeam, ["home", "1"]);
  const away = findOutcome(rows, awayTeam, ["away", "2"]);
  if (!home || !away) return null;
  return {
    line: Number(home.point ?? home.handicap ?? home.line ?? 0),
    homeWater: Number(home.price ?? home.odd ?? home.odds),
    awayWater: Number(away.price ?? away.odd ?? away.odds)
  };
}

function findPrice(rows, team, aliases = []) {
  const row = findOutcome(rows, team, aliases);
  return row?.price ?? row?.odd ?? row?.odds ?? row?.value;
}

function findOutcome(rows, team, aliases = []) {
  const normalizedTeam = normalizeName(team);
  return rows.find((row) => {
    const name = normalizeName(row.name ?? row.label ?? row.team ?? row.value ?? row.selection ?? row.outcome);
    return name === normalizedTeam || aliases.some((alias) => name === normalizeName(alias));
  });
}

function eventDate(event) {
  const value = event.commence_time ?? event.startTime ?? event.start_time ?? event.startsAt ?? event.date ?? event.time;
  return String(value || "").slice(0, 10);
}

function latestBookmakerUpdate(bookmakers = []) {
  return bookmakers.map((item) => item.last_update).filter(Boolean).sort().at(-1);
}

function sameTeam(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function sameFixtureName(fixture, snapshot) {
  return sameTeam(fixture.homeTeam, snapshot.homeTeam) && sameTeam(fixture.awayTeam, snapshot.awayTeam);
}

function shengfucaiIssue(fixtures) {
  return String(fixtures.find((fixture) => fixture.officialFixtureId)?.officialFixtureId ?? "").match(/(\d{5})/)?.[1] ?? "";
}

function extractAnchors(html) {
  return [...String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: decodeHtmlText(match[1]),
    title: cleanHtmlText(match[2])
  }));
}

function readNowscoreFixtureIdMap() {
  return {
    "jc-2026-05-23-周六005-国际图尔-tps图尔": "2913617",
    "jc-2026-05-23-周六008-坦山猫-赫尔火花": "2913618",
    "jc-2026-05-23-周六009-塞伊奈-ac奥卢": "2913621",
    "jc-2026-05-23-周六018-马洛卡-奥维耶多": "2804670",
    "jc-2026-05-23-周六020-皇马-毕尔巴鄂": "2804671",
    "jc-2026-05-23-周六024-巴伦西亚-巴萨": "2804672",
    "jc-2026-05-23-周六026-明尼苏达-盐湖城": "2908622",
    "jc-2026-05-23-周六027-夏洛特fc-新英格兰": "2908618",
    "jc-2026-05-23-周六028-华盛顿-蒙特利尔": "2908619",
    "jc-2026-05-23-周六030-波特兰-圣何塞": "2908626",
    "jc-2026-05-15-周五001-阿德莱德-奥克兰fc": "2983484",
    "jc-2026-05-15-周五002-达马克-迈季宽广": "2852351",
    "jc-2026-05-15-周五003-布赖合作-利雅得": "2852350",
    "jc-2026-05-15-周五005-维拉-利物浦": "2789490",
    ...parseJsonEnv("NOWSCORE_FIXTURE_IDS")
  };
}

function readCubegoalFixtureIdMap() {
  return {
    "jc-2026-05-15-周五004-圣埃蒂安-罗德兹": "84868",
    ...parseJsonEnv("CUBEGOAL_FIXTURE_IDS")
  };
}

export function parseNowscoreOddsHtml(html, fixture, date, sourceUrl = "") {
  const payload = decodeHtmlText(String(html).match(/value='([^']+)'/)?.[1] ?? "");
  const points = payload.split("^").map(parseNowscoreCompanyOdds).filter(Boolean);
  const asianPoints = points.map((point) => point.asianHandicap?.current).filter(Boolean);
  const initialAsianPoints = points.map((point) => point.asianHandicap?.initial).filter(Boolean);
  if (!asianPoints.length && !initialAsianPoints.length) return null;
  return {
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: new Date().toISOString(),
    asianHandicap: {
      initial: averageAsian(initialAsianPoints.length ? initialAsianPoints : asianPoints),
      current: averageAsian(asianPoints)
    },
    source: sourceUrl ? `捷报比分公开赔率 ${sourceUrl}` : "捷报比分公开赔率"
  };
}

export function parseNowscoreMatchOddsHtml(html, fixture, date, sourceUrl = "") {
  const rows = extractTableRows(html)
    .map((cells) => cells.map((cell) => decodeHtmlText(cell)).filter(Boolean))
    .filter((cells) => cells.length >= 13 && /^\D+\*$/.test(cells[0]) && cells.slice(1, 13).some((cell) => /\d/.test(cell)));
  const points = rows.map(parseNowscoreMatchOddsRow).filter(Boolean);
  const asianCurrent = points.map((point) => point.asianHandicap?.current).filter(Boolean);
  const asianInitial = points.map((point) => point.asianHandicap?.initial).filter(Boolean);
  const euroCurrent = points.map((point) => point.europeanOdds?.current).filter(Boolean);
  const euroInitial = points.map((point) => point.europeanOdds?.initial).filter(Boolean);
  if (!asianCurrent.length && !asianInitial.length && !euroCurrent.length && !euroInitial.length) return null;
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: new Date().toISOString(),
    asianHandicap: asianCurrent.length || asianInitial.length ? {
      initial: averageAsian(asianInitial.length ? asianInitial : asianCurrent),
      current: averageAsian(asianCurrent.length ? asianCurrent : asianInitial)
    } : null,
    europeanOdds: euroCurrent.length || euroInitial.length ? {
      initial: averageOutcome(euroInitial.length ? euroInitial : euroCurrent),
      current: averageOutcome(euroCurrent.length ? euroCurrent : euroInitial)
    } : null,
    source: sourceUrl ? `捷报比分公开指数 ${sourceUrl}` : "捷报比分公开指数"
  }, date);
}

function parseNowscoreMatchOddsRow(cells) {
  const currentAsian = parseNowscoreMatchAsian(cells[1], cells[2], cells[3]);
  const initialAsian = parseNowscoreMatchAsian(cells[4], cells[5], cells[6]);
  const currentEuro = parseNowscoreMatchEuropean(cells[7], cells[8], cells[9]);
  const initialEuro = parseNowscoreMatchEuropean(cells[10], cells[11], cells[12]);
  if (!currentAsian && !initialAsian && !currentEuro && !initialEuro) return null;
  return {
    asianHandicap: { current: currentAsian, initial: initialAsian },
    europeanOdds: { current: currentEuro, initial: initialEuro }
  };
}

function parseNowscoreMatchAsian(homeWaterText, lineText, awayWaterText) {
  const homeWater = Number(homeWaterText);
  const awayWater = Number(awayWaterText);
  const line = nowscoreChineseAsianLine(lineText);
  return [homeWater, line, awayWater].every(Number.isFinite) ? { line, homeWater, awayWater } : null;
}

function parseNowscoreMatchEuropean(homeText, drawText, awayText) {
  const home = Number(homeText);
  const draw = Number(drawText);
  const away = Number(awayText);
  return [home, draw, away].every((value) => Number.isFinite(value) && value > 1) ? { home, draw, away } : null;
}

function nowscoreChineseAsianLine(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  const receives = raw.startsWith("受") || raw.startsWith("+");
  const clean = raw.replace(/^受/, "").replace(/^[+-]/, "");
  const mapped = clean.split("/").map(nowscoreChineseAsianLinePart).reduce((sum, item, _, list) => sum + item / list.length, 0);
  if (!Number.isFinite(mapped)) return Number.NaN;
  return receives ? mapped : -mapped;
}

function nowscoreChineseAsianLinePart(value) {
  const text = String(value ?? "").trim();
  const map = {
    "平手": 0,
    "平": 0,
    "半球": 0.5,
    "半": 0.5,
    "一球": 1,
    "一": 1,
    "球半": 1.5,
    "两球": 2,
    "二球": 2,
    "两球半": 2.5,
    "二球半": 2.5,
    "三球": 3,
    "三球半": 3.5
  };
  if (text in map) return map[text];
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.abs(numeric) : Number.NaN;
}

export function parseCubegoalOddsHtml(html, fixture, date, sourceUrl = "") {
  const text = cleanHtmlText(html);
  const match = text.match(/让球\s*主队\s*限时\s*客队\s*([\d.]+)\s*(-?[\d.]+)\s*([\d.]+)/);
  if (!match) return null;
  const point = { homeWater: Number(match[1]), line: Number(match[2]), awayWater: Number(match[3]) };
  if (![point.homeWater, point.line, point.awayWater].every(Number.isFinite)) return null;
  return {
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt: new Date().toISOString(),
    asianHandicap: { initial: point, current: point },
    source: sourceUrl ? `CubeGoal公开赔率 ${sourceUrl}` : "CubeGoal公开赔率"
  };
}

function parseSinaEuroAsianRows(text) {
  const pattern = /([^\s]+)\s+vs\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(.*?)(?=\s+[^\s]+\s+vs\s+|$)/gi;
  return [...String(text).matchAll(pattern)]
    .map((match) => {
      const asianPoints = [...match[6].matchAll(/(\d+(?:\.\d+)?)\s+([^\d\s]+(?:\s*\/\s*[^\d\s]+)?)\s+(\d+(?:\.\d+)?)/g)]
        .map((point) => {
          const row = {
            homeWater: Number(point[1]),
            line: asianLineFromChinese(point[2].replace(/\s+/g, "")),
            awayWater: Number(point[3])
          };
          return [row.line, row.homeWater, row.awayWater].every(Number.isFinite) ? row : null;
        })
        .filter(Boolean);
      return {
        homeTeam: match[1].trim(),
        awayTeam: match[2].trim(),
        europeanOdds: { home: Number(match[3]), draw: Number(match[4]), away: Number(match[5]) },
        convertedAsian: asianPoints[0] ?? null,
        currentAsian: asianPoints.at(-1) ?? null
      };
    })
    .filter((row) => row.homeTeam.length < 12 && row.awayTeam.length < 12);
}

function parseFiveHundredSfcFids(html) {
  return [...String(html).matchAll(/<table\b[^>]*\bfid="(\d+)"[^>]*\bteam="([^"]+)"/gi)]
    .map((match) => ({ fid: match[1], team: decodeHtmlText(match[2]) }));
}

async function readFiveHundredSfcFids(fetchImpl, indexUrl, fixtures, date) {
  try {
    const indexHtml = await fetchTextWithEncoding(fetchImpl, indexUrl, "gb18030");
    const rows = parseFiveHundredSfcFids(indexHtml);
    if (rows.length) return rows;
  } catch (error) {
    const cachedRows = readCachedFiveHundredSfcFids(date, fixtures);
    if (cachedRows.some((row) => row?.fid)) return cachedRows;
    throw error;
  }
  return readCachedFiveHundredSfcFids(date, fixtures);
}

function readCachedFiveHundredSfcFids(date, fixtures) {
  const snapshots = loadMarketSnapshots(date).snapshots;
  return fixtures.map((fixture) => {
    const snapshot = snapshots.find((item) => item.fixtureId === fixture.id);
    const fid = String(snapshot?.source ?? "").match(/(?:yazhi|ouzhi)-(\d+)\.shtml/i)?.[1];
    return fid ? { fid, team: `${fixture.homeTeam}-${fixture.awayTeam}`, cached: true } : null;
  });
}

function parseFiveHundredEuropeanOddsHtml(html, fixture, date, sourceUrl = "") {
  const rows = parseFiveHundredEuropeanRows(html);
  const currentPoints = rows.map((row) => row.current).filter(Boolean);
  const initialPoints = rows.map((row) => row.initial).filter(Boolean);
  if (!currentPoints.length && !initialPoints.length) return null;
  const collectedAt = fiveHundredCollectedAt(rows.map((row) => row.updatedAt).filter(Boolean).sort().at(-1), date) ?? new Date().toISOString();
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt,
    europeanOdds: {
      initial: averageOutcome(initialPoints.length ? initialPoints : currentPoints),
      current: averageOutcome(currentPoints.length ? currentPoints : initialPoints)
    },
    source: sourceUrl ? `500.com shengfucai european odds ${sourceUrl}` : "500.com shengfucai european odds"
  }, date);
}

function parseFiveHundredEuropeanRows(html) {
  const tableStart = String(html).indexOf('id="datatb"');
  if (tableStart < 0) return [];
  return [...String(html).slice(tableStart).matchAll(/<tr\b([^>]*\bxls="row"[^>]*)>([\s\S]*?)(?=<tr\b[^>]*\bxls="row"|<\/table>\s*<\/div>)/gi)]
    .map((match) => {
      const attrs = match[1] ?? "";
      const segment = match[2] ?? "";
      const updatedAt = attrs.match(/\bdata-time="([^"]+)"/i)?.[1] ?? attrs.match(/\bdt="([^"]+)"/i)?.[1] ?? "";
      const table = segment.match(/<table\b[^>]*class="pl_table_data"[^>]*>([\s\S]*?)<\/table>/i)?.[1] ?? "";
      const points = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((row) => parseFiveHundredEuropeanPoint(row[1]))
        .filter(Boolean);
      const current = points[0] ?? null;
      const initial = points[1] ?? points[0] ?? null;
      return current || initial ? { updatedAt, current, initial } : null;
    })
    .filter(Boolean);
}

function parseFiveHundredEuropeanPoint(rowHtml = "") {
  const values = [...String(rowHtml).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => Number(cleanHtmlText(match[1])))
    .filter((value) => Number.isFinite(value) && value > 1);
  return values.length >= 3 ? { home: values[0], draw: values[1], away: values[2] } : null;
}

function parseFiveHundredAsianOddsHtml(html, fixture, date, sourceUrl = "") {
  const rows = parseFiveHundredAsianRows(html);
  const currentPoints = rows.map((row) => row.current).filter(Boolean);
  const initialPoints = rows.map((row) => row.initial).filter(Boolean);
  if (!currentPoints.length && !initialPoints.length) return null;
  const collectedAt = fiveHundredCollectedAt(rows.map((row) => row.updatedAt).filter(Boolean).sort().at(-1), date) ?? new Date().toISOString();
  return normalizeMarketSnapshot({
    date,
    fixtureId: fixture.id,
    sequence: fixture.sequence,
    marketType: fixture.marketType,
    competition: fixture.competition,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    collectedAt,
    asianHandicap: {
      initial: averageAsian(initialPoints.length ? initialPoints : currentPoints),
      current: averageAsian(currentPoints.length ? currentPoints : initialPoints)
    },
    source: sourceUrl ? `${fiveHundredAsianSourceName(fixture)} ${sourceUrl}` : fiveHundredAsianSourceName(fixture)
  }, date);
}

function fiveHundredAsianSourceName(fixture) {
  return fixture?.marketType === "jingcai" ? "500.com jingcai asian odds" : "500.com shengfucai asian odds";
}

function parseFiveHundredAsianRows(html) {
  const tableStart = String(html).indexOf('id="datatb"');
  if (tableStart < 0) return [];
  return [...String(html).slice(tableStart).matchAll(/<tr\b([^>]*\bxls="row"[^>]*)>([\s\S]*?)(?=<tr\b[^>]*\bxls="row"|<\/table>\s*<\/div>)/gi)]
    .map((match) => {
      const attrs = match[1] ?? "";
      const segment = match[2] ?? "";
      const updatedAt = attrs.match(/\bdt="([^"]+)"/i)?.[1] ?? "";
      const tables = [...segment.matchAll(/<table\b[^>]*class="pl_table_data"[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1]);
      const current = parseFiveHundredAsianPoint(tables[0]);
      const initial = parseFiveHundredAsianPoint(tables[1]);
      return current || initial ? { updatedAt, current, initial } : null;
    })
    .filter(Boolean);
}

function parseFiveHundredAsianPoint(tableHtml = "") {
  const cells = [...String(tableHtml).matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
    .map((match) => ({ ref: match[1]?.match(/\bref="([^"]+)"/i)?.[1] ?? "", text: cleanHtmlText(match[2]) }))
    .filter((cell) => cell.text && !cell.text.includes("更多"));
  const home = parseFloat(cells[0]?.text);
  const lineText = cells[1]?.text ?? "";
  const lineRef = Number(cells[1]?.ref);
  const away = parseFloat(cells[2]?.text);
  const line = fiveHundredAsianLine(lineText, lineRef);
  if (![home, line, away].every(Number.isFinite)) return null;
  return { line, homeWater: fiveHundredWaterToDecimal(home), awayWater: fiveHundredWaterToDecimal(away) };
}

function fiveHundredAsianLine(text, ref) {
  const raw = String(text ?? "").trim();
  const mapped = asianLineFromChinese(raw);
  if (Number.isFinite(mapped)) return mapped;
  if (!Number.isFinite(ref)) return Number.NaN;
  return raw.startsWith("\u53d7") ? Math.abs(ref) : -Math.abs(ref);
}

function fiveHundredWaterToDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return number > 1.2 ? number : Math.round((number + 1) * 1000) / 1000;
}

function fiveHundredCollectedAt(value, date) {
  const match = String(value ?? "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  return shanghaiDateTimeToIso(match[1], match[2], match[3], match[4], match[5], match[6]);
}

function sameSinaEuroAsianTeam(left, right) {
  return sinaEuroAsianAlias(normalizeName(left)) === sinaEuroAsianAlias(normalizeName(right));
}

function sinaEuroAsianAlias(value) {
  const aliases = {
    "vps瓦萨": "瓦萨",
    "奥尔格里特": "厄格里特",
    "厄尔格里特": "厄格里特",
    "古比斯": "库奥皮奥",
    "查路": "雅罗",
    "博德": "博德闪耀",
    "利勒斯": "利勒斯特罗姆",
    "克里斯蒂": "克里斯蒂安松",
    "埃尔维斯": "坦佩雷山猫"
  };
  return aliases[value] ?? value;
}

function extractTableRows(html) {
  return [...String(html).matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((row) => [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanHtmlText(cell[1])))
    .filter((cells) => cells.length);
}

function parseSinaMacauPoint(cells) {
  const homeWater = Number(cells[2]);
  const line = asianLineFromChinese(cells[3]);
  const awayWater = Number(cells[4]);
  return [homeWater, line, awayWater].every(Number.isFinite) ? { line, homeWater, awayWater } : null;
}

function parseSinaBookmakerTriples(cells) {
  const triples = [];
  for (let index = 0; index + 2 < cells.length; index += 3) {
    const home = Number(cells[index]);
    const draw = Number(cells[index + 1]);
    const away = Number(cells[index + 2]);
    triples.push([home, draw, away].every((value) => Number.isFinite(value) && value > 1) ? { home, draw, away } : null);
  }
  return triples;
}

function finalizeSinaSfcOddsGroup(group, date, sourceUrl, articleCollectedAt) {
  const initial = averageOutcome(group.initialTriples.filter(Boolean));
  const current = averageOutcome(group.currentTriples.filter(Boolean));
  if (!initial && !current) return null;
  return {
    date,
    fixtureId: group.fixture.id,
    sequence: group.fixture.sequence,
    competition: group.fixture.competition,
    homeTeam: group.fixture.homeTeam,
    awayTeam: group.fixture.awayTeam,
    collectedAt: articleCollectedAt ?? parseSinaCollectedAt(group.latestTimeText, date) ?? new Date().toISOString(),
    europeanOdds: { initial, current: current ?? initial },
    source: sourceUrl ? `新浪胜负彩欧洲四大机构 ${sourceUrl}` : "新浪胜负彩欧洲四大机构"
  };
}

function finalizeSinaMacauGroup(group, date, sourceUrl, articleCollectedAt) {
  if (!group.current && !group.initial) return null;
  return {
    date,
    fixtureId: group.fixture.id,
    sequence: group.fixture.sequence,
    marketType: group.fixture.marketType,
    competition: group.fixture.competition,
    homeTeam: group.fixture.homeTeam,
    awayTeam: group.fixture.awayTeam,
    collectedAt: articleCollectedAt ?? parseSinaWeekdayCollectedAt(group.latestTimeText, date) ?? new Date().toISOString(),
    asianHandicap: { initial: group.initial ?? group.current, current: group.current ?? group.initial },
    source: sourceUrl ? `新浪胜负彩澳盘 ${sourceUrl}` : "新浪胜负彩澳盘"
  };
}

function extractSinaArticleCollectedAt(html) {
  const jsonDate = String(html).match(/"datePublished"\s*:\s*"(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?"/);
  if (jsonDate) return shanghaiDateTimeToIso(jsonDate[1], jsonDate[2], jsonDate[3], jsonDate[4], jsonDate[5], jsonDate[6] ?? 0);
  const visibleDate = cleanHtmlText(html).match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
  if (visibleDate) return shanghaiDateTimeToIso(visibleDate[1], visibleDate[2], visibleDate[3], visibleDate[4], visibleDate[5], 0);
  return null;
}

function parseSinaCollectedAt(value, date) {
  const match = String(value ?? "").match(/(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [year, month] = String(date).split("-").map(Number);
  const day = Number(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  return shanghaiDateTimeToIso(year, month, day, hour, minute, 0);
}

function parseSinaWeekdayCollectedAt(value, date) {
  const match = String(value ?? "").match(/周[一二三四五六日](\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [year, month, day] = String(date).split("-").map(Number);
  return shanghaiDateTimeToIso(year, month, day, match[1], match[2], 0);
}

function parseNowscoreCompanyOdds(value) {
  const parts = String(value ?? "").split(";");
  if (parts.length < 4 || !parts[1]?.includes("*")) return null;
  const current = parseNowscoreOddsPoint(parts[2]);
  const initial = parseNowscoreOddsPoint(parts[3]);
  if (!current && !initial) return null;
  return { asianHandicap: { current: current?.asianHandicap ?? null, initial: initial?.asianHandicap ?? null } };
}

function parseNowscoreOddsPoint(value) {
  const cells = String(value ?? "").split(",").map((cell) => cell.trim());
  const homeWater = Number(cells[3]);
  const line = asianLineFromChinese(cells[4]);
  const awayWater = Number(cells[5]);
  if (![homeWater, line, awayWater].every(Number.isFinite)) return null;
  return { asianHandicap: { line, homeWater, awayWater } };
}

function asianLineFromChinese(value) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const receives = text.startsWith("受") || text.startsWith("*");
  const clean = text.replace(/^[受*]+/, "");
  const line = clean.split("/").map(asianLinePart).reduce((sum, item, _, list) => sum + item / list.length, 0);
  if (!Number.isFinite(line)) return Number.NaN;
  return receives ? line : -line;
}

function asianLinePart(value) {
  const text = String(value ?? "").trim();
  const map = {
    "平手": 0,
    "平": 0,
    "半球": 0.5,
    "半": 0.5,
    "一球": 1,
    "一": 1,
    "球半": 1.5,
    "两球": 2,
    "二球": 2,
    "两球半": 2.5,
    "二球半": 2.5,
    "三球": 3,
    "三球半": 3.5,
    "四球": 4,
    "四球半": 4.5
  };
  if (text in map) return map[text];
  const numeric = Number(text);
  return Number.isFinite(numeric) ? Math.abs(numeric) : Number.NaN;
}

function shanghaiDateTimeToIso(year, month, day, hour, minute, second) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))).toISOString();
}

function cleanHtmlText(value) {
  return decodeHtmlText(String(value ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlText(value) {
  const entities = { nbsp: " ", amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };
  return String(value ?? "").replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[String(entity).toLowerCase()] ?? match;
  });
}

function normalizeName(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function averageOutcome(points) {
  if (!points.length) return null;
  return { home: avg(points.map((item) => item.home)), draw: avg(points.map((item) => item.draw)), away: avg(points.map((item) => item.away)) };
}

function averageAsian(points) {
  const valid = points.filter((point) => point && [point.line, point.homeWater, point.awayWater].every(Number.isFinite));
  if (!valid.length) return null;
  return {
    line: avg(valid.map((item) => item.line)),
    homeWater: avg(valid.map((item) => item.homeWater)),
    awayWater: avg(valid.map((item) => item.awayWater))
  };
}

function avg(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return Math.round((valid.reduce((sum, value) => sum + value, 0) / Math.max(1, valid.length)) * 1000) / 1000;
}

function latestIso(left, right) {
  const candidates = [left, right].filter(Boolean).map((value) => new Date(value)).filter((value) => Number.isFinite(value.getTime()));
  if (!candidates.length) return right ?? left ?? new Date().toISOString();
  return new Date(Math.max(...candidates.map((value) => value.getTime()))).toISOString();
}

function mergeSourceNames(left, right) {
  return [...new Set([left, right].filter(Boolean).flatMap((value) => String(value).split("+")).map((value) => value.trim()).filter(Boolean))].join("+");
}

function parseJsonEnv(name) {
  if (!process.env[name]) return {};
  try {
    const value = JSON.parse(process.env[name]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
