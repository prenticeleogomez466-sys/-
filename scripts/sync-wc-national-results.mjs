#!/usr/bin/env node
/**
 * 世界杯 48 队【国家队近况语料】抓取缓存(2026-06-11)——为逐场"近5战 + H2H"决定因素列供数据。
 * ════════════════════════════════════════════════════════════════════════════════
 * 免费源(铁律:只免费/只真实):ESPN 隐藏 JSON API 跨【国际赛】league 合并——
 *   fifa.friendly(友谊赛)+ uefa.nations(欧国联)+ fifa.worldq.{uefa,conmebol,concacaf,afc,caf,ofc}(世预赛)。
 *   实测均返回真实完赛赛果(2025-26 窗口 friendly 492 / worldq.uefa 204 …)。fifa.world/各洲杯本窗口空,跳过。
 * 队名归一:ESPN displayName → 本模型 48 队规范英文名(world-cup-priors teamPrior.en);归一不到的保留原名(只标缺,不臆造)。
 * 产物:wc-national-results.json = { fetchedAt, window, matches:[{date,league,home,away,homeGoals,awayGoals,homeEn,awayEn}] }。
 * 用法: node scripts/sync-wc-national-results.mjs [--from 2024-06-01] [--to 2026-06-11]
 */
import "../src/env.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDataSubdir } from "../src/paths.js";
import { fetchEspnResults } from "../src/espn-results-source.js";
import { teamPrior } from "../src/world-cup-priors.js";

const OUT = join(getDataSubdir("world-cup"), "2026", "wc-national-results.json");
const INTL_LEAGUES = ["fifa.friendly", "uefa.nations",
  "fifa.worldq.uefa", "fifa.worldq.conmebol", "fifa.worldq.concacaf", "fifa.worldq.afc", "fifa.worldq.caf", "fifa.worldq.ofc"];

// ESPN displayName(小写)→ 本模型 48 队规范英文名。复用 refresh 脚本的 4 队补丁 + 国家队额外差异。
const ESPN_ALIAS = {
  "south korea": "Korea Republic", "korea republic": "Korea Republic",
  "bosnia-herzegovina": "Bosnia and Herzegovina", "bosnia & herzegovina": "Bosnia and Herzegovina", "bosnia and herzegovina": "Bosnia and Herzegovina",
  "cote d'ivoire": "Ivory Coast", "côte d'ivoire": "Ivory Coast", "cote d’ivoire": "Ivory Coast", "côte d’ivoire": "Ivory Coast",
  "cabo verde": "Cape Verde", "cape verde": "Cape Verde",
  "czech republic": "Czechia", "czechia": "Czechia",
  "usa": "United States", "united states": "United States",
  "turkey": "Turkiye", "türkiye": "Turkiye", "turkiye": "Turkiye",
  "dr congo": "DR Congo", "congo dr": "DR Congo", "congo democratic republic": "DR Congo", "democratic republic of the congo": "DR Congo"
};

// 48 队规范名集合(用于精确归一回退)。
const WC48 = new Set(["Mexico", "South Africa", "Korea Republic", "Czechia", "Canada", "Bosnia and Herzegovina", "United States",
  "Paraguay", "Qatar", "Switzerland", "Brazil", "Morocco", "Haiti", "Scotland", "Australia", "Turkiye", "Netherlands", "Japan",
  "Ivory Coast", "Ecuador", "Sweden", "Tunisia", "Spain", "Cape Verde", "Belgium", "Egypt", "Saudi Arabia", "Uruguay", "Germany",
  "Curacao", "Iran", "New Zealand", "France", "Senegal", "Iraq", "Norway", "Argentina", "Algeria", "Austria", "Jordan", "Portugal",
  "DR Congo", "England", "Croatia", "Ghana", "Panama", "Uzbekistan", "Colombia"]);

/** ESPN 队名 → 48 队规范名(归一不到返回 null)。 */
export function toWcEn(name) {
  if (!name) return null;
  const low = String(name).trim().toLowerCase();
  if (ESPN_ALIAS[low]) return ESPN_ALIAS[low];
  const hit = [...WC48].find((e) => e.toLowerCase() === low);
  return hit || null;
}

async function runMain() {
  const args = process.argv.slice(2);
  const from = args[args.indexOf("--from") + 1] && args.includes("--from") ? args[args.indexOf("--from") + 1] : "2024-06-01";
  const to = args.includes("--to") ? args[args.indexOf("--to") + 1] : "2026-06-11";
  console.log(`抓 ESPN 国际赛赛果 ${from} → ${to}(${INTL_LEAGUES.length} 个 league)…`);

  const seen = new Set();
  const matches = [];
  for (const lg of INTL_LEAGUES) {
    try {
      const r = await fetchEspnResults(lg, { from, to });
      if (!r.ok) { console.log(`  ${lg.padEnd(22)} —空`); continue; }
      let added = 0;
      for (const m of r.matches) {
        const key = `${m.date}|${m.home}|${m.away}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ date: m.date, league: lg, home: m.home, away: m.away, homeGoals: m.homeGoals, awayGoals: m.awayGoals, homeEn: toWcEn(m.home), awayEn: toWcEn(m.away) });
        added++;
      }
      console.log(`  ${lg.padEnd(22)} ✅ ${added} 场`);
    } catch (e) { console.log(`  ${lg.padEnd(22)} ERR ${e.message}`); }
  }
  matches.sort((a, b) => a.date.localeCompare(b.date));
  // 用最新真实赛果时刻作 fetchedAt(可追溯;不靠不可追溯的 Date.now 臆造)。
  const fetchedAt = matches.length ? matches[matches.length - 1].date : null;
  const wcInvolved = matches.filter((m) => m.homeEn || m.awayEn).length;
  writeFileSync(OUT, JSON.stringify({ fetchedAt, window: { from, to }, leagues: INTL_LEAGUES, total: matches.length, wc48Involved: wcInvolved, matches }, null, 1));
  console.log(`\n✅ 写 ${OUT}:${matches.length} 场(含 WC48 队 ${wcInvolved} 场),最新赛果日 ${fetchedAt}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runMain();
