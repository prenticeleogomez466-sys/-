#!/usr/bin/env node
/**
 * ESPN 世界杯正赛 fixtures 播种器(2026-06-22)。
 * 根因:500.com Node直连被反爬(fetch failed),无人值守抓不到→今日WC场进不了store→wc:predict没场可预测。
 * 方案:ESPN fifa.world scoreboard(Node fetch 实测可靠)→ 把今日+未来WC场(中文队名)播进 fixture-store,
 *       让 wc:predict / today 能取到。只补"该日无WC场"的日期(不覆盖500兜底的带赔率场)。
 * 铁律 no-fallback:只播真实ESPN赛程;队名英→中走 groups.json team_name_zh,匹配不到的场跳过(不编)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { loadFixtures, saveFixtures, mergeFixtureLists } from "../src/fixture-store.js";

const gdoc = JSON.parse(readFileSync(join(getDataSubdir("world-cup"), "2026", "groups.json"), "utf8"));
const ZH = gdoc.team_name_zh || {};
const ALIAS = { "South Korea": "Korea Republic", "Bosnia-Herzegovina": "Bosnia and Herzegovina", "Türkiye": "Turkiye", "Curaçao": "Curacao", "Congo DR": "DR Congo", "Cape Verde": "Cabo Verde", "Ivory Coast": "Côte d'Ivoire", USA: "United States" };
const flat = Object.values(gdoc.groups).flat();
const toZh = (en) => { if (ZH[en]) return ZH[en]; const c = ALIAS[en]; if (c && ZH[c]) return ZH[c]; const hit = flat.find((t) => t.toLowerCase().replace(/[^a-z]/g, "") === en.toLowerCase().replace(/[^a-z]/g, "")); return hit ? (ZH[hit] || hit) : null; };

const todayUtc = new Date().toISOString().slice(0, 10);
const dates = [];
{ const base = new Date(todayUtc + "T00:00:00Z"); for (let i = -1; i <= 13; i++) { const d = new Date(base.getTime() + i * 86400000); dates.push(d.toISOString().slice(0, 10).replace(/-/g, "")); } }

// 清理旧的 espn-seed(防错位日期残留+幂等)——范围内每个北京日期文件去掉本源
import { listFixtureDates } from "../src/fixture-store.js";
for (const date of listFixtureDates()) {
  if (date < "2026-06-20" || date > "2026-07-20") continue;
  let ex; try { ex = loadFixtures(date).fixtures || []; } catch { continue; }
  const kept = ex.filter((f) => f.source !== "espn-fifa.world-seed");
  if (kept.length !== ex.length) saveFixtures(date, kept, { source: "espn-seed-cleanup", allowEmpty: true });
}

const byDate = {};
const globalSeen = new Set(); // 全局去重(ESPN相邻日期查询会重复返回临界场)
let fetched = 0;
for (const d of dates) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${d}`);
    if (!r.ok) continue;
    const j = await r.json();
    for (const e of (j.events || [])) {
      const comp = e.competitions && e.competitions[0]; if (!comp) continue;
      const cs = comp.competitors || [];
      const home = cs.find((c) => c.homeAway === "home") || cs[0], away = cs.find((c) => c.homeAway === "away") || cs[1];
      if (!home || !away) continue;
      const hZh = toZh(home.team.displayName), aZh = toZh(away.team.displayName);
      if (!hZh || !aZh) continue; // 匹配不到不编
      const iso = e.date ? new Date(e.date) : null; // ESPN UTC
      if (!iso) continue;
      const bj = new Date(iso.getTime() + 8 * 3600000); // 北京时间
      const ko = bj.toISOString().slice(0, 16).replace("T", " ");
      const dateStr = bj.toISOString().slice(0, 10); // ★按北京日期归档(系统业务日口径)
      const gkey = `${hZh}|${aZh}|${dateStr}`;
      if (globalSeen.has(gkey)) continue; // 全局去重
      globalSeen.add(gkey);
      const st = e.status && e.status.type;
      const fx = {
        id: `espnwc-${dateStr}-${hZh}-${aZh}`, date: dateStr, kickoff: ko || `${dateStr} 00:00`,
        competition: "世界杯", homeTeam: hZh, awayTeam: aZh, round: "", marketType: "shengfucai",
        tags: ["worldcup", "espn-seed"], source: "espn-fifa.world-seed", officialStatus: "",
      };
      if (st && st.completed && home.score != null && away.score != null) fx.result = { home: Number(home.score), away: Number(away.score), halfHome: null, halfAway: null };
      (byDate[dateStr] ||= []).push(fx);
      fetched++;
    }
  } catch { /* 跳过该日 */ }
}

let seededDates = 0, seededFx = 0;
for (const [date, seeds] of Object.entries(byDate)) {
  let existing = [];
  try { existing = loadFixtures(date).fixtures || []; } catch { existing = []; }
  // 已有同对阵(中文名,任意源/含500带赔率)→不重复播种,保留已有(优先带赔率的500场)
  const haveKey = new Set(existing.map((f) => `${f.homeTeam}|${f.awayTeam}`));
  const fresh = seeds.filter((s) => !haveKey.has(`${s.homeTeam}|${s.awayTeam}`) && !haveKey.has(`${s.awayTeam}|${s.homeTeam}`));
  if (!fresh.length) continue;
  const merged = mergeFixtureLists(existing, fresh);
  saveFixtures(date, merged, { source: "espn-wc-seed", seededAt: new Date().toISOString() });
  seededDates++; seededFx += fresh.length;
}
console.log(`✅ ESPN世界杯播种:扫${dates.length}天·抓${fetched}场·新播${seededFx}场到${seededDates}个日期(已有对阵不覆盖)`);
