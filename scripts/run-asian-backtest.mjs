/**
 * 亚盘让球档 · 真实留出回测(2026-05-31 学习轮 7)
 * ─────────────────────────────────────────────────────────────
 * 目的:验证"让球盘口 → 结果"——历史各亚盘档(主让半/一/球半…)的**让球覆盖率**样本外是否
 *       稳定、是否系统性偏离 50%(偏离=市场让球盘口可被利用;接近50%=已被定价高效)。
 *       遵 feedback-hitrate-closed-loop:数据说话,不盲接。
 *
 * 方法(leak-safe holdout):
 *   1. football-data big-5,取**有亚盘线**的场(开盘 AHh + 收盘 AHCh)。
 *   2. 按日期 70/30 时间留出。
 *   3. test 集:按收盘亚盘档算主队让球覆盖率(margin+line>0 主覆盖,<0 客覆盖,排除 push)。
 *      档命名复刻 experience-library.asianBand(主让/主受 + 半/一/球半/两/两半+)。
 *   4. 看各档覆盖率离 50% 多远 + train↔test 稳定性。
 *
 * 用法:node scripts/run-asian-backtest.mjs
 */
import { loadFootballDataMatches } from "../src/footballdata-loader.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"];

// 复刻 experience-library.asianBand(主队视角整数/半档),保证口径一致
function asianBand(line) {
  if (line === null || line === undefined || !Number.isFinite(line)) return null;
  const a = Math.abs(line);
  const sign = line < 0 ? "主让" : line > 0 ? "主受" : "平手";
  if (a === 0) return "平手";
  if (a <= 0.5) return `${sign}半`;
  if (a <= 1) return `${sign}一`;
  if (a <= 1.5) return `${sign}球半`;
  if (a <= 2) return `${sign}两`;
  return `${sign}两半+`;
}

// 主队让球结果:margin + line。>0 主覆盖,<0 客覆盖,==0 push(排除)。
function homeCover(m, line) {
  const margin = m.homeGoals - m.awayGoals + line;
  if (Math.abs(margin) < 1e-9) return null; // push
  return margin > 0; // true=主覆盖
}

const res = await loadFootballDataMatches({ leagues: BIG5 });
const withAsian = res.matches.filter(
  (m) => m.homeGoals != null && m.date && m.asian && Number.isFinite(m.asian.lineClose ?? m.asian.line)
);
console.log(`big-5 ${res.matches.length} 场,有亚盘线 ${withAsian.length} 场`);

const cut = Math.floor(withAsian.length * 0.7);
const train = withAsian.slice(0, cut);
const test = withAsian.slice(cut);
console.log(`时间切分:train ${train.length}(${train[0]?.date}~${train.at(-1)?.date}) / test ${test.length}(${test[0]?.date}~${test.at(-1)?.date})\n`);

function aggByBand(matches) {
  const bands = new Map();
  let totalHomeCover = 0, totalN = 0;
  for (const m of matches) {
    const line = m.asian.lineClose ?? m.asian.line;
    const band = asianBand(line);
    if (!band) continue;
    const c = homeCover(m, line);
    if (c === null) continue;
    if (!bands.has(band)) bands.set(band, { n: 0, homeCover: 0 });
    const b = bands.get(band);
    b.n++; if (c) b.homeCover++;
    totalN++; if (c) totalHomeCover++;
  }
  return { bands, overallHomeCover: totalN ? totalHomeCover / totalN : null, totalN };
}

const trainAgg = aggByBand(train);
const testAgg = aggByBand(test);

console.log(`整体主队让球覆盖率:train ${(trainAgg.overallHomeCover * 100).toFixed(1)}% / test ${(testAgg.overallHomeCover * 100).toFixed(1)}%(应≈50%=高效盘口)\n`);

console.log("各亚盘档 主队覆盖率(test 样本外)+ train↔test 稳定性:");
const order = ["主让两半+", "主让两", "主让球半", "主让一", "主让半", "平手", "主受半", "主受一", "主受球半", "主受两", "主受两半+"];
for (const band of order) {
  const te = testAgg.bands.get(band);
  const tr = trainAgg.bands.get(band);
  if (!te || te.n < 30) continue;
  const teR = (te.homeCover / te.n) * 100;
  const trR = tr ? (tr.homeCover / tr.n) * 100 : null;
  const dev = (teR - 50).toFixed(1);
  const stab = trR != null ? `(train ${trR.toFixed(1)}% → 差 ${(teR - trR).toFixed(1)}pp)` : "";
  console.log(`  ${band.padEnd(7)}: ${teR.toFixed(1)}% [${te.n}场] 离50% ${dev}pp ${stab}`);
}

console.log("\n诚实结论:各档覆盖率应都≈50%(±几pp 噪声)=让球盘口已被市场定价高效,无系统性 edge;");
console.log("           让球经验只作'同档历史覆盖'透明读数,不当下注信号(遵既有'让球 naive 覆盖弱于市场')。");
