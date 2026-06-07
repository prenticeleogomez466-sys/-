#!/usr/bin/env node
/**
 * 同步 2026 世界杯真实赛程(赛号→当地比赛日期)——2026-06-04。
 * 源:fixturedownload.com 免费 JSON feed(MatchNumber/DateUtc/Location,全104场),与 match-venues.json
 *   的 matchCity 口径一致。把 UTC 开球时刻按承办城市夏令时偏移换成【当地日期】,供 worldcup-weather
 *   按城市+当地日期查 Open-Meteo 真实预报(开球当天天气)。
 * 写 <data>/world-cup/2026/match-dates.json:{ "<赛号>": { dateUtc, localDate, city } }。
 * 用法:node scripts/sync-worldcup-schedule.mjs   (无 key;失败保留旧文件)
 */
import "../src/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";

const dir = join(getDataSubdir("world-cup"), "2026");
const matchVenues = JSON.parse(readFileSync(join(dir, "match-venues.json"), "utf8"));
const venues = JSON.parse(readFileSync(join(dir, "venues.json"), "utf8")).venues;
const offsetByCity = new Map(venues.map((v) => [v.city, Number(v.utc_offset_summer)]));

// 承办城市当地日期 = UTC 时刻 + 夏令时偏移
function localDateOf(dateUtc, city) {
  const off = offsetByCity.get(city);
  const t = Date.parse(dateUtc.replace(" ", "T").replace("Z", "Z"));
  if (!Number.isFinite(t)) return dateUtc.slice(0, 10);
  const local = new Date(t + (Number.isFinite(off) ? off : 0) * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

const feed = await (await fetch("https://fixturedownload.com/feed/json/fifa-world-cup-2026", { headers: { "User-Agent": "Mozilla/5.0" } })).json();
if (!Array.isArray(feed) || !feed.length) { console.error("赛程 feed 为空,保留旧文件"); process.exit(1); }

// feed Location → venues.json 口径城市(去 " Stadium" + cityAliases 归一)。
//   这是【该场真实对阵】的承办城市(feed 自洽:对阵+地点同一条记录),与 matchCity[赛号]
//   的 NBC/Wikipedia 编号口径不同——后者对 fixturedownload 的赛号 65/72 城市不一致(2026-06-07 核)。
function feedCityOf(m) {
  let c = String(m.Location || "").replace(/ Stadium$/i, "").trim();
  return matchVenues.cityAliases?.[c] ?? c;
}

const out = {};
let withCity = 0;
for (const m of feed) {
  const n = m.MatchNumber;
  if (!n || !m.DateUtc) continue;
  // 承办城市优先用 match-venues.matchCity(经 cityAliases 归一);兜底从 Location 去 " Stadium"
  let city = matchVenues.matchCity?.[String(n)];
  city = matchVenues.cityAliases?.[city] ?? city ?? feedCityOf(m);
  // homeTeam/awayTeam/venueCity:feed 自洽的【真实对阵 → 承办城市】,供 worldCupVenue 按对阵解析
  //   每日竞彩 fixture(只带队名+日期、无场馆字段)的场馆/海拔/天气。小组赛队名为真;淘汰赛为占位(2A/1B…)。
  out[String(n)] = {
    dateUtc: m.DateUtc,
    localDate: localDateOf(m.DateUtc, city),
    city,
    homeTeam: m.HomeTeam ?? null,
    awayTeam: m.AwayTeam ?? null,
    venueCity: feedCityOf(m),
    group: m.Group ?? null,
    round: m.RoundNumber ?? null
  };
  if (offsetByCity.has(city)) withCity++;
}

const doc = { updatedAt: new Date().toISOString(), source: "fixturedownload.com fifa-world-cup-2026 JSON feed", count: Object.keys(out).length, matchDate: out };
writeFileSync(join(dir, "match-dates.json"), JSON.stringify(doc, null, 2), "utf8");
console.log(`✅ ${doc.count} 场赛程 → match-dates.json(${withCity} 场城市对上时区)`);
console.log("样本:", JSON.stringify(out["1"]), JSON.stringify(out["2"]), JSON.stringify(out["104"]));
