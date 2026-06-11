#!/usr/bin/env node
/**
 * 同步世界杯承办城市真实天气(Open-Meteo,免费无key)——2026-06-04。
 * 对 venues.json 16 个承办球场逐个拉 Open-Meteo 日预报(最高温/最大风/降水),写
 * <data>/world-cup/2026/worldcup-weather.json。预报窗 ~16 天,世界杯早段小组赛(6/11起)可覆盖。
 * 供 src/worldcup-weather.js 查询、venueLambdaMultiplier 用真实温度替换静态气候均温。
 * 用法:node scripts/sync-worldcup-weather.mjs   (无 key,直接跑;OPEN_METEO_ENABLED=0 跳过)
 */
import "../src/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";

if (process.env.OPEN_METEO_ENABLED === "0") { console.log("OPEN_METEO_ENABLED=0,跳过。"); process.exit(0); }

const dir = join(getDataSubdir("world-cup"), "2026");
const venues = JSON.parse(readFileSync(join(dir, "venues.json"), "utf8")).venues;

async function fetchCity(v) {
  if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return { city: v.city, error: "无坐标" };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${v.latitude}&longitude=${v.longitude}`
    + `&daily=temperature_2m_max,temperature_2m_mean,wind_speed_10m_max,precipitation_sum`
    + `&forecast_days=16&timezone=${encodeURIComponent(v.timezone || "auto")}`;
  const r = await fetch(url);
  if (!r.ok) return { city: v.city, error: `HTTP ${r.status}` };
  const j = await r.json();
  const d = j.daily || {};
  const days = {};
  (d.time || []).forEach((date, i) => {
    days[date] = {
      highTempC: num(d.temperature_2m_max?.[i]),
      avgTempC: num(d.temperature_2m_mean?.[i]),
      windMaxKmh: num(d.wind_speed_10m_max?.[i]),
      precipMm: num(d.precipitation_sum?.[i]),
      source: "open-meteo-forecast",
    };
  });
  return { city: v.city, days, indoor: !!v.indoor_climate_controlled };
}
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; };

// 0611修:①每城最多3试(连发16城偶发限流,此前每跑必随机掉一城)②失败城保留上次真实预报
//   (旧档是真数据只是旧,丢掉=场馆温度λ静默回退静态均温;如实标注staleFrom,绝不编造)
const path = join(dir, "worldcup-weather.json");
let prev = { byCity: {}, updatedAt: null };
try { prev = JSON.parse(readFileSync(path, "utf8")); } catch { /* 首跑无旧档 */ }

const byCity = {};
const staleCities = {};
let okCities = 0, totalDays = 0;
for (const v of venues) {
  let res = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetchCity(v).catch((e) => ({ city: v.city, error: e.message }));
    if (res.days && Object.keys(res.days).length) break;
    if (attempt < 3) await new Promise((s) => setTimeout(s, 1500 * attempt));
  }
  if (res.days && Object.keys(res.days).length) {
    byCity[res.city] = res.days;
    okCities++; totalDays += Object.keys(res.days).length;
    const sample = Object.entries(res.days)[0];
    console.log(`${res.city.padEnd(22)} ${Object.keys(res.days).length}天 首日${sample[0]} 高温${sample[1].highTempC}℃${res.indoor ? " [室内恒温]" : ""}`);
  } else if (prev.byCity?.[v.city]) {
    byCity[v.city] = prev.byCity[v.city];
    staleCities[v.city] = prev.updatedAt;
    console.log(`${v.city.padEnd(22)} ⚠️ 3试均败(${res.error || "无数据"})→保留上次真实预报(${prev.updatedAt})`);
  } else {
    console.log(`${v.city.padEnd(22)} ❌ 3试均败且无旧档(${res.error || "无数据"})——该城预报缺,如实留空`);
  }
  await new Promise((s) => setTimeout(s, 300)); // 轻限速,Open-Meteo 免费
}

const out = { updatedAt: new Date().toISOString(), forecastDays: 16, byCity, ...(Object.keys(staleCities).length ? { staleCities } : {}) };
writeFileSync(path, JSON.stringify(out, null, 2), "utf8");
console.log(`\n✅ 实时${okCities}/16 城市${Object.keys(staleCities).length ? `+保留旧档${Object.keys(staleCities).length}城(${Object.keys(staleCities).join(",")})` : ""},共 ${totalDays} 天 → ${path}`);
console.log("用途:venueLambdaMultiplier 对预报窗内(~16天)的世界杯场次用真实最高温替换静态气候均温;窗外回退均温。");
