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
// 让球线 → 欧赔 胜/平/客 十进制赔率正常区间 [P5,中位,P95](12458场7季实测·收盘)。
//   配 LINE_FAV_BANDS(热门胜率隐含)给完整"什么区间合理"参照。本场赔率落区外=过深/过浅。
const LINE_DECIMAL_BANDS = {
  0:    { win: [2.45, 2.59, 2.77], draw: [2.88, 3.25, 3.68], dog: [2.64, 2.83, 3.05], n: 1407 },
  0.25: { win: [2.09, 2.27, 2.49], draw: [2.96, 3.33, 3.73], dog: [2.89, 3.26, 3.78], n: 3380 },
  0.5:  { win: [1.82, 1.95, 2.07], draw: [3.17, 3.54, 3.95], dog: [3.48, 3.99, 4.74], n: 2250 },
  0.75: { win: [1.63, 1.72, 1.81], draw: [3.48, 3.85, 4.27], dog: [4.18, 4.88, 5.84], n: 1721 },
  1:    { win: [1.48, 1.56, 1.64], draw: [3.87, 4.26, 4.65], dog: [4.94, 5.91, 7.36], n: 1259 },
  1.25: { win: [1.37, 1.43, 1.50], draw: [4.42, 4.78, 5.16], dog: [5.93, 7.21, 9.21], n: 881 },
  1.5:  { win: [1.28, 1.34, 1.39], draw: [5.03, 5.46, 5.97], dog: [7.11, 8.90, 11.21], n: 673 },
  1.75: { win: [1.21, 1.26, 1.30], draw: [5.82, 6.25, 6.82], dog: [8.84, 10.76, 14.39], n: 363 },
  2:    { win: [1.17, 1.21, 1.24], draw: [6.61, 7.17, 7.96], dog: [10.41, 13.0, 17.06], n: 246 },
  2.25: { win: [1.13, 1.16, 1.19], draw: [7.62, 8.36, 9.38], dog: [12.8, 16.09, 21.8], n: 125 },
  2.5:  { win: [1.09, 1.12, 1.15], draw: [8.85, 9.72, 11.32], dog: [15.71, 20.12, 26.43], n: 88 },
};
// 让球线 |line| → 历史"热门(让球方)不胜率"(被逼平或被翻盘的真实频次;12458场7季真实赛果实测)。
//   = 历史同档爆冷率:过去在该让球线上,给球热门最终没赢的比例。越高=该档历史越易冷(让得越少越易冷)。
//   ✅真实赛果频次(scripts/build-odds-reference-bands 同源,favorite=给球方,line=0用收盘概率定向)。
const LINE_UPSET_RATE = {
  0: 0.608, 0.25: 0.568, 0.5: 0.514, 0.75: 0.425, 1: 0.360,
  1.25: 0.301, 1.5: 0.251, 1.75: 0.242, 2: 0.203, 2.25: 0.200, 2.5: 0.114,
};
// 大小球:收盘大球隐含分档 → over/under 十进制 [P5,中,P95] / under中位(12458场实测)。
const OU_DECIMAL_BANDS = [
  { lo: 0.35, hi: 0.45, over: [2.13, 2.28, 2.64], underMid: 1.63, n: 2521 },
  { lo: 0.45, hi: 0.55, over: [1.75, 1.91, 2.09], underMid: 1.91, n: 4665 },
  { lo: 0.55, hi: 0.65, over: [1.48, 1.61, 1.72], underMid: 2.32, n: 3600 },
  { lo: 0.65, hi: 0.78, over: [1.25, 1.38, 1.45], underMid: 3.03, n: 1292 },
];

/** 完整"什么区间合理"参照表行(供盘口合理性 sheet 全量列出)。每条让球线:热门胜率区间+胜/平/客赔区间。 */
export function handicapReferenceRows() {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const rg = (a) => `${a[0]}–${a[2]}(中${a[1]})`;
  const rows = [["让球线", "热门胜率正常区间(下限–上限·中)", "热门胜赔", "平赔", "客(冷)赔", "历史不胜率(爆冷)", "样本N"]];
  for (const k of Object.keys(LINE_DECIMAL_BANDS).map(Number).sort((a, b) => a - b)) {
    const d = LINE_DECIMAL_BANDS[k], f = LINE_FAV_BANDS[k];
    const ur = LINE_UPSET_RATE[k];
    rows.push([k === 0 ? "平手" : "让" + k, f ? `${pct(f.p5)}–${pct(f.p95)}(中${pct(f.p50)})` : "—", rg(d.win), rg(d.draw), rg(d.dog), ur != null ? pct(ur) : "—", d.n]);
  }
  return rows;
}
/** 大小球正常区间参照行。 */
export function ouReferenceRows() {
  const rg = (a) => `${a[0]}–${a[2]}(中${a[1]})`;
  const rows = [["收盘大球隐含档", "over赔正常区间", "under赔中位", "样本N"]];
  for (const b of OU_DECIMAL_BANDS) rows.push([`${(b.lo * 100) | 0}–${(b.hi * 100) | 0}%`, rg(b.over), b.underMid, b.n]);
  return rows;
}

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

/** 欧赔(胜负平/直胜)正常区间:按让球线锚定强度档 → 热门胜/平/客(冷)十进制 [P5,中,P95]。无对应档→null,不硬套。 */
export function europeanBand(ahLine) {
  if (ahLine == null || ahLine === "") return null;   // Number(null)===0 会误套让0档,显式拦
  const line = Number(ahLine);
  if (!Number.isFinite(line)) return null;
  const key = nearestLineKey(Math.abs(line));
  if (key == null) return null;
  const b = LINE_DECIMAL_BANDS[key];
  return b ? { refLine: key, win: b.win, draw: b.draw, dog: b.dog, n: b.n } : null;
}

/** 大小球正常区间:按本场大球隐含%落入历史档 → {over:[P5,中,P95], underMid, lo, hi, n}。无→null,不编。 */
export function ouBand(overImplied) {
  const p = Number(overImplied);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  for (const b of OU_DECIMAL_BANDS) if (p >= b.lo && p < b.hi) return b;
  const first = OU_DECIMAL_BANDS[0], last = OU_DECIMAL_BANDS[OU_DECIMAL_BANDS.length - 1];
  if (p < first.lo) return first;       // 低于最低档→用最低档参照
  if (p >= last.hi) return last;        // 高于最高档→用最高档参照
  return null;
}

// 亚盘水位历史区间(12393场实测·decimal):水位近乎与让球线无关(强度被让球线吸收·全档中位≈1.92),
//   故用单一聚合带而非按线分档(避免假精度)。深=被重注(赔付低)、高=冷清(赔付高)、失衡=钱压一侧过盘。
const WATER_BAND = { p5: 1.77, mid: 1.92, p95: 2.10, n: 12393 };
/**
 * 亚盘水位合理性 + 失衡判读。实盘水位多为 HK 盘口(0.98=1.98 decimal),自动换算后对历史带。
 * @returns {null | { homeDec, awayDec, band, homeVerdict, awayVerdict, lean, gap }}
 */
export function waterSanity(homeWater, awayWater) {
  const toDec = (w) => { const x = Number(w); if (!Number.isFinite(x) || x <= 0) return null; return x < 1.5 ? round2(x + 1) : round2(x); }; // HK→decimal
  const h = toDec(homeWater), a = toDec(awayWater);
  if (h == null && a == null) return null;
  const judge = (d) => d == null ? null : d < WATER_BAND.p5 ? "深(被重注·赔付低)" : d > WATER_BAND.p95 ? "高(冷清·赔付高)" : "正常";
  let lean = "均衡", gap = null;
  if (h != null && a != null) {
    gap = round2(h - a);
    if (gap <= -0.08) lean = "钱压主队过盘(主水更低)";
    else if (gap >= 0.08) lean = "钱压客队过盘(客水更低)";
  }
  return { homeDec: h, awayDec: a, band: WATER_BAND, homeVerdict: judge(h), awayVerdict: judge(a), lean, gap };
}
function round2(x) { return Math.round(x * 100) / 100; }

/** 历史同档爆冷率:给球热门在该让球线上的真实"不胜"频次(12458场实测)。无该档样本→null,不编。 */
export function histUpsetRate(ahLine) {
  const line = Number(ahLine);
  if (!Number.isFinite(line)) return null;
  const key = nearestLineKey(Math.abs(line));
  return key == null ? null : (LINE_UPSET_RATE[key] ?? null);
}

/**
 * 深浅裁决分级标签(诚实:仅差<1.5pp=擦边接近常态,标🟡临界而非🔴,避免夸大;≥1.5pp才🔴)。
 * @returns {{ tag:string, marginal:boolean, severe:boolean }}
 */
export function sanityVerdictLabel(s) {
  if (!s || !s.band) return { tag: "—", marginal: false, severe: false };
  if (!s.exceeded) return { tag: "🟢合理", marginal: false, severe: false };
  const marginal = s.gapPp < 1.5;
  return {
    tag: marginal ? `🟡临界${s.verdict}(仅差${s.gapPp}pp·接近常态)` : `🔴${s.verdict}${s.gapPp}pp`,
    marginal, severe: !marginal,
  };
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
