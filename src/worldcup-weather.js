/**
 * 世界杯真实天气(Open-Meteo,免费无key)——2026-06-04。
 * ────────────────────────────────────────────────────────────
 * 缺口:世界杯 venue λ 乘子此前只用 venues.json 的【静态气候均温】june_july_avg_high_c 算高温折损,
 *   不是某场比赛当天的真实预报。本模块用 Open-Meteo 按承办球场经纬度拉【真实日预报】(开赛前~16天内),
 *   把那一天的真实最高温喂给 venueLambdaMultiplier,替换静态均温(超出预报窗口的场次回退气候均温)。
 * 诚实边界:Open-Meteo 预报窗 ~16 天,世界杯多数场次在窗外→用气候均温(honest fallback);
 *   仅小组赛早段(6/11 起 ~两周内)能拿到真实预报。天气只精修【已有的、有界的】高温→λ 机制,
 *   不新增概率信号、不动 wld 方向(遵命中率闭环硬规则:动概率需回测,这里只用真实观测替换静态假设)。
 *
 * 数据文件:<data>/world-cup/2026/worldcup-weather.json,由 scripts/sync-worldcup-weather.mjs 写。
 *   形状:{ updatedAt, byCity: { "<city>": { "<YYYY-MM-DD>": {highTempC,avgTempC,windMaxKmh,precipMm} } } }
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "./paths.js";

let _cache = null;
function weatherPath() {
  return join(getDataSubdir("world-cup"), "2026", "worldcup-weather.json");
}

export function loadWorldCupWeather() {
  if (_cache !== null) return _cache;
  const p = weatherPath();
  _cache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { updatedAt: null, byCity: {} };
  return _cache;
}


/**
 * 查某承办城市某天的真实预报最高温(℃)。无缓存/超出预报窗 → null(调用方回退气候均温)。
 * cityKey 用 venues.json 的英文 city 字段(与 sync 写入口径一致)。
 */
export function realHighTempForCityDate(cityKey, isoDate) {
  if (!cityKey || !isoDate) return null;
  const doc = loadWorldCupWeather();
  const day = doc?.byCity?.[cityKey]?.[String(isoDate).slice(0, 10)];
  return day && Number.isFinite(Number(day.highTempC)) ? Number(day.highTempC) : null;
}
