/**
 * 盘口合理性检查器(2026-06-16 用户:让一球正常胜负平区间是多少·这场过深过浅·超临界值多少=异常)。
 *
 * 标准带=8907场五大联赛真实历史统计(scripts/build-odds-reference-bands.mjs 生成,此处嵌入快照,
 *   刷新跑该脚本)。每条让球线 → 历史上"正常"的 1X2 热门隐含胜率分位 P5/P25/P50/P75/P95。
 *   本场热门隐含落 P5..P95 内=合理;< P5 = 盘口过深(让太多·热门被高估·受让方有值/爆冷信号);
 *   > P95 = 盘口过浅(让太少·热门实际更强·受让方过盘易)。临界值=P5/P95(双侧5%)。
 *
 * 诚实:这是"盘口 vs 历史同线常态"的偏离读数(✅历史频次),供用户自行判断,不是下注 edge
 *   (公开盘口打不过收盘线已证)。偏离大=该盘历史罕见,值得多看一眼,非"必爆/必赢"。
 */

// 让球线深度 |line| → 1X2 热门隐含胜率分位(分数;8907场实测,N见注)。
// 8907→12458场(7季×五大联赛2019-2026)实测;2026-06-16 用户"抓一万场五大联赛设合理区间"已达成。
const LINE_FAV_BANDS = {
  0:    { p5: 0.344, p25: 0.358, p50: 0.368, p75: 0.377, p95: 0.390, n: 1407 },
  0.25: { p5: 0.383, p25: 0.401, p50: 0.420, p75: 0.440, p95: 0.457, n: 3380 },
  0.5:  { p5: 0.461, p25: 0.474, p50: 0.491, p75: 0.508, p95: 0.523, n: 2250 },
  0.75: { p5: 0.527, p25: 0.540, p50: 0.555, p75: 0.570, p95: 0.585, n: 1721 },
  1:    { p5: 0.584, p25: 0.598, p50: 0.613, p75: 0.629, p95: 0.646, n: 1259 },
  1.25: { p5: 0.639, p25: 0.654, p50: 0.667, p75: 0.681, p95: 0.699, n: 881 },
  1.5:  { p5: 0.688, p25: 0.703, p50: 0.716, p75: 0.728, p95: 0.750, n: 673 },
  1.75: { p5: 0.735, p25: 0.748, p50: 0.758, p75: 0.769, p95: 0.787, n: 363 },
  2:    { p5: 0.766, p25: 0.782, p50: 0.793, p75: 0.804, p95: 0.820, n: 246 },
  2.25: { p5: 0.802, p25: 0.815, p50: 0.826, p75: 0.836, p95: 0.852, n: 125 },
  2.5:  { p5: 0.832, p25: 0.844, p50: 0.854, p75: 0.861, p95: 0.879, n: 88 },
};
const KEYS = Object.keys(LINE_FAV_BANDS).map(Number).sort((a, b) => a - b);
function nearestLineKey(depth) {
  let best = KEYS[0], bd = Infinity;
  for (const k of KEYS) { const d = Math.abs(k - depth); if (d < bd) { bd = d; best = k; } }
  return bd <= 0.13 ? best : null; // 距最近标准档>0.13(无对应线)→不硬套
}

/**
 * @param {Object} a
 *   ahLine    {number} 亚盘让球线(热门视角;正负不限,取绝对值)
 *   p1x2Fav   {number} 本场热门 1X2 隐含胜率(de-vig,0~1)
 * @returns {null | { line, favProb, depth, band:{p5,p25,p50,p75,p95,n}|null,
 *   verdict:"合理"|"过深"|"过浅"|"无该线历史样本", gapPp, exceeded }}
 */
export function handicapSanity({ ahLine, p1x2Fav } = {}) {
  const line = Number(ahLine), p = Number(p1x2Fav);
  if (!Number.isFinite(line) || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const depth = Math.abs(line);
  const key = nearestLineKey(depth);
  const band = key == null ? null : LINE_FAV_BANDS[key];
  if (!band) return { line, favProb: round(p), depth, band: null, verdict: "无该线历史样本", gapPp: null, exceeded: false };
  let verdict = "合理", gapPp = 0, exceeded = false;
  if (p < band.p5) { verdict = "过深"; gapPp = round1((band.p5 - p) * 100); exceeded = true; }
  else if (p > band.p95) { verdict = "过浅"; gapPp = round1((p - band.p95) * 100); exceeded = true; }
  return { line, favProb: round(p), depth, refLine: key, band, verdict, gapPp, exceeded };
}

/** 人读一行:本场值 vs 区间 + 超临界多少。 */
export function handicapSanityText(s) {
  if (!s) return "⚠️无法判定(缺让球线或1X2隐含)";
  if (!s.band) return `让${s.line}·热门隐含${pct(s.favProb)}：${s.verdict}(无该线≥30样本历史带)`;
  const b = s.band;
  const range = `正常${pct(b.p5)}~${pct(b.p95)}(中位${pct(b.p50)})`;
  if (s.verdict === "合理") return `让${s.line}·热门隐含${pct(s.favProb)} 在区间内=合理｜${range}`;
  const dir = s.verdict === "过深" ? `低于下限P5 ${s.gapPp}pp(让太多·热门被高估·受让方有值)` : `高于上限P95 ${s.gapPp}pp(让太少·热门实际更强·受让方过盘易)`;
  return `让${s.line}·热门隐含${pct(s.favProb)} 🔴${s.verdict}·${dir}｜${range}`;
}

function round(x) { return Math.round(x * 1000) / 1000; }
function round1(x) { return Math.round(x * 10) / 10; }
function pct(x) { return `${(x * 100).toFixed(1)}%`; }
export { LINE_FAV_BANDS };
