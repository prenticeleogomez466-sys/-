/**
 * Weather-Adjusted xG
 * ──────────────────────────────────────────────────
 * 基于现有 Open-Meteo 天气数据(advanced-data-runner 已接),
 * 把 xG / λ 按天气折扣.
 *
 * 经验:
 *   - 暴雨(precipitation > 5mm/h):-20% 进球率(滑、控球差)
 *   - 中雨(2-5mm/h):-10%
 *   - 大风(>30 km/h):-10%(传球准度下降)
 *   - 极冷(<-5°C):-8%
 *   - 极热(>30°C):-5%
 *   - 正常:无折扣
 *
 * 加性:多个不利条件叠加(但 cap 在 -40%).
 */

const PRECIPITATION_THRESHOLDS = [
  { mmh: 5,   multiplier: 0.80, name: "暴雨" },
  { mmh: 2,   multiplier: 0.90, name: "中雨" },
  { mmh: 0.5, multiplier: 0.97, name: "小雨" }
];

const WIND_THRESHOLDS = [
  { kmh: 50, multiplier: 0.85, name: "暴风" },
  { kmh: 30, multiplier: 0.90, name: "大风" },
  { kmh: 15, multiplier: 0.97, name: "中等风" }
];

/**
 * 根据 weather snapshot 算总 xG 折扣系数.
 *
 * @param {Object} weather { temperature2m, precipitation, windSpeed10m }
 * @returns {{ multiplier, factors, narrative }}
 */
export function weatherXgMultiplier(weather) {
  if (!weather) return { multiplier: 1.0, factors: [], narrative: "缺天气数据" };
  const factors = [];

  // Precipitation(取 avg 或 max)
  const precip = Number(weather.precipitation?.avg ?? weather.precipitation ?? 0);
  for (const p of PRECIPITATION_THRESHOLDS) {
    if (precip >= p.mmh) {
      factors.push({ type: "precipitation", value: precip, multiplier: p.multiplier, name: p.name });
      break;
    }
  }

  // Wind
  const wind = Number(weather.windSpeed10m?.avg ?? weather.wind ?? 0);
  for (const w of WIND_THRESHOLDS) {
    if (wind >= w.kmh) {
      factors.push({ type: "wind", value: wind, multiplier: w.multiplier, name: w.name });
      break;
    }
  }

  // Temperature
  const temp = Number(weather.temperature2m?.avg ?? weather.temperature ?? 15);
  if (temp < -5) factors.push({ type: "cold", value: temp, multiplier: 0.92, name: "极冷" });
  else if (temp < 0) factors.push({ type: "cold", value: temp, multiplier: 0.97, name: "寒冷" });
  else if (temp > 32) factors.push({ type: "heat", value: temp, multiplier: 0.95, name: "极热" });
  else if (temp > 28) factors.push({ type: "heat", value: temp, multiplier: 0.98, name: "炎热" });

  // 复合(连乘)
  let total = 1.0;
  for (const f of factors) total *= f.multiplier;
  // Cap
  total = Math.max(0.6, total);

  const narrative = factors.length === 0
    ? "天气适宜,无 xG 折扣"
    : `天气影响: ${factors.map((f) => f.name).join(" + ")} → xG ${(total*100).toFixed(0)}%`;

  return { multiplier: round(total), factors, narrative };
}

/**
 * 调整 xG 对.
 */
export function applyWeatherToXG(xg, weather) {
  const { multiplier } = weatherXgMultiplier(weather);
  if (multiplier >= 1.0) return xg;
  return {
    home: round(Number(xg.home ?? xg.lambdaHome ?? 0) * multiplier),
    away: round(Number(xg.away ?? xg.lambdaAway ?? 0) * multiplier),
    weatherMultiplier: multiplier
  };
}

/**
 * 调整 over/under 概率:坏天气进球率下降,under 概率上升.
 */
export function applyWeatherToOverUnder(overProb, weather) {
  const { multiplier } = weatherXgMultiplier(weather);
  if (multiplier >= 1.0) return overProb;
  // 进球率 -20% → over 概率 -8pp
  const shift = (multiplier - 1) * 0.4;
  return round(Math.max(0.05, Math.min(0.95, overProb + shift)));
}

function round(v) {
  return Math.round(v * 10000) / 10000;
}
