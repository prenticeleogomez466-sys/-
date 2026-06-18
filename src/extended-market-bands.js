/**
 * 扩展玩法·历史合理区间 + 异动判读(2026-06-18 用户:让球胜负平/主客进球数大小/半场胜负平/半场进球数
 *   也要合理区间+异动统计)。
 *
 * 数据=football-data.co.uk 12458场五大联赛7季【真实赛果频次】(✅,scripts/backtest-extended-market-bands.mjs
 *   生成,此处嵌入快照;刷新跑该脚本)。本场 live 实测/🔶矩阵派生值 vs 同强度档历史频次 → 偏离pp=异动。
 *
 * 诚实:历史频次="该强度档过去真实发生的比例"(✅真实赛果),给"什么算正常"的锚;偏离大=本场该玩法
 *   被市场定价/模型派生得与历史常态不同,值得多看一眼,非下注 edge(公开盘打不过收盘线)。
 */

// ① 让球胜负平:竞彩整数让球线(主队视角 H,负=主让)→ 让球主胜/平/负 真实频次%(12458场)。
const HANDICAP_RESULT = {
  "-3": { homeWin: 27.9, draw: 19.3, awayWin: 52.9, n: 140 },
  "-2": { homeWin: 29.9, draw: 20.3, awayWin: 49.8, n: 1079 },
  "-1": { homeWin: 31.4, draw: 25.6, awayWin: 42.9, n: 4033 },
  "0":  { homeWin: 35.8, draw: 29.7, awayWin: 34.5, n: 4787 },
  "1":  { homeWin: 42.1, draw: 26.7, awayWin: 31.2, n: 2078 },
  "2":  { homeWin: 47.6, draw: 21.6, awayWin: 30.8, n: 328 },
};
// 强度档(亚盘让球线深度,热门视角)分箱标签。
const DEPTH_ORDER = ["0", "0.5", "1", "1.5", "2+"];
const DEPTH_LABEL = { "0": "平手档", "0.5": "半球档", "1": "一球档", "1.5": "球半档", "2+": "两球+档" };
// ② 半场胜负平:强度档 → 半场 热门胜/平/负 真实频次%(HTHG/HTAG)。
const HT_RESULT = {
  "0":   { favWin: 29.7, draw: 45.8, favLoss: 24.5, n: 1407 },
  "0.5": { favWin: 35.0, draw: 42.5, favLoss: 22.4, n: 5630 },
  "1":   { favWin: 44.3, draw: 38.9, favLoss: 16.8, n: 2980 },
  "1.5": { favWin: 52.3, draw: 34.5, favLoss: 13.2, n: 1554 },
  "2+":  { favWin: 61.4, draw: 27.8, favLoss: 10.7, n: 887 },
};
// ③ 主/客(热门/非热门)进球数大小:强度档 → 进球 over0.5/1.5/2.5 真实频次%。
const TEAM_GOALS = {
  "0":   { favOver05: 75.1, favOver15: 40.1, favOver25: 15.6, dogOver05: 71.7, dogOver15: 34.5, n: 1407 },
  "0.5": { favOver05: 79.5, favOver15: 44.5, favOver25: 19.3, dogOver05: 68.4, dogOver15: 30.5, n: 5630 },
  "1":   { favOver05: 86.8, favOver15: 57.7, favOver25: 28.9, dogOver05: 62.6, dogOver15: 25.7, n: 2980 },
  "1.5": { favOver05: 91.3, favOver15: 67.2, favOver25: 37.9, dogOver05: 55.3, dogOver15: 20.7, n: 1554 },
  "2+":  { favOver05: 94.5, favOver15: 77.9, favOver25: 52.2, dogOver05: 55.2, dogOver15: 20.1, n: 887 },
};
// ④ 半场进球数:强度档 → 半场总进球 over0.5/1.5 真实频次%。
const HT_GOALS = {
  "0":   { over05: 67.4, over15: 32.6, n: 1407 },
  "0.5": { over05: 69.5, over15: 32.8, n: 5630 },
  "1":   { over05: 72.9, over15: 36.4, n: 2980 },
  "1.5": { over05: 75.9, over15: 39.8, n: 1554 },
  "2+":  { over05: 81.3, over15: 47.6, n: 887 },
};

/** 让球线深度(绝对值)→ 强度档 key。缺线→null。 */
export function depthBin(ahLine) {
  const d = Math.abs(Number(ahLine));
  if (!Number.isFinite(d)) return null;
  if (d < 0.25) return "0";
  if (d < 0.625) return "0.5";
  if (d < 1.125) return "1";
  if (d < 1.625) return "1.5";
  return "2+";
}
export function depthLabel(bin) { return bin ? (DEPTH_LABEL[bin] ?? bin) : "—"; }

/** 让球胜负平历史频次(按竞彩整数线·主队视角)。缺该线样本→null,不硬套。 */
export function handicapResultBand(jcLine) {
  const k = String(Math.sign(Number(jcLine)) * Math.round(Math.abs(Number(jcLine))));
  return HANDICAP_RESULT[k] ?? null;
}
export function htResultBand(ahLine) { const b = depthBin(ahLine); return b ? { ...HT_RESULT[b], bin: b } : null; }
export function teamGoalsBand(ahLine) { const b = depthBin(ahLine); return b ? { ...TEAM_GOALS[b], bin: b } : null; }
export function htGoalsBand(ahLine) { const b = depthBin(ahLine); return b ? { ...HT_GOALS[b], bin: b } : null; }

/**
 * 异动判读:本场值(%) vs 历史频次(%)。偏离阈值默认 8pp(经验:市场对历史定价误差通常<8pp,
 *   超出=该玩法被定价/派生得明显偏离常态)。
 * @returns {{ deltaPp, tag, text }}
 */
export function anomalyVs(liveP, histP, { thresh = 8, label = "" } = {}) {
  if (!Number.isFinite(liveP) || !Number.isFinite(histP)) return { deltaPp: null, tag: "—", text: "缺值不判" };
  const d = Math.round((liveP - histP) * 10) / 10;
  const ad = Math.abs(d);
  const tag = ad >= thresh ? "🟠异动" : ad >= thresh / 2 ? "🟡偏离" : "🟢常态";
  const dir = d > 0 ? "高于" : d < 0 ? "低于" : "持平";
  return { deltaPp: d, tag, text: `本场${liveP}% ${dir}历史${histP}%${d ? `(${d > 0 ? "+" : ""}${d}pp)` : ""}${label ? "·" + label : ""}` };
}

/** 参照表行:让球胜负平历史频次(全量线)。 */
export function handicapResultReferenceRows() {
  const rows = [["竞彩让球线", "让球主胜%", "让球平%", "让球客胜%", "样本N", "口径"]];
  for (const k of Object.keys(HANDICAP_RESULT).map(Number).sort((a, b) => a - b)) {
    const v = HANDICAP_RESULT[String(k)];
    rows.push([k === 0 ? "平手(让0)" : k < 0 ? `主让${-k}球` : `主受让${k}球`, v.homeWin, v.draw, v.awayWin, v.n, "✅真实赛果频次"]);
  }
  return rows;
}
/** 参照表行:半场胜负平/半场进球/分队进球(按强度档·7列与主体同宽)。 */
export function extendedDepthReferenceRows() {
  const rows = [["强度档(让球线)", "半场热门胜/平/负%", "半场≥1球/≥2球%", "热门进≥1/≥2球%", "非热门进≥1/≥2球%", "样本N", "口径"]];
  for (const b of DEPTH_ORDER) {
    const h = HT_RESULT[b], g = HT_GOALS[b], t = TEAM_GOALS[b];
    if (!h) continue;
    rows.push([DEPTH_LABEL[b], `${h.favWin}/${h.draw}/${h.favLoss}`, `${g.over05}/${g.over15}`, `${t.favOver05}/${t.favOver15}`, `${t.dogOver05}/${t.dogOver15}`, h.n, "✅真实赛果频次"]);
  }
  return rows;
}

export { HANDICAP_RESULT, HT_RESULT, TEAM_GOALS, HT_GOALS };
