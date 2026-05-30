/**
 * 赔率漂移档 · 真实留出回测(2026-05-31 学习轮 4)
 * ─────────────────────────────────────────────────────────────
 * 目的:验证学习轮 2 加进经验库的"热门走强(被加注)→ 热门兑现更高"在**样本外**是否成立,
 *       还是只是全样本聚合噪声(遵 feedback-hitrate-closed-loop:改完必回测、不盲接信号)。
 *
 * 方法(诚实留出):
 *   1. football-data big-5 × 全赛季,取**开盘+收盘双价齐全**的场(才有真漂移)。
 *   2. 按日期排序后 70/30 时间切分:train 在前、test 在后(test 是 train 看不到的未来)。
 *   3. 用同一 driftBand() 分档,只在 **test 集** 上算各漂移档「收盘热门兑现率」+ 样本量。
 *   4. 看是否 走强 ≥ 平稳 ≥ 走弱(steam 排序)在样本外独立重现。
 *
 * 用法:node scripts/run-drift-backtest.mjs
 */
import { loadFootballDataMatches, LEAGUE_LABELS } from "../src/footballdata-loader.js";
import { driftBand, frameOf } from "../src/experience-library.js";

const BIG5 = ["E0", "SP1", "I1", "D1", "F1"]; // 英超/西甲/意甲/德甲/法甲(均带开盘+收盘赔率)

// 一场 → { band, favRealized } :收盘最锐价定热门方,热门方赢=兑现。平局/无热门方跳过。
function classify(m) {
  if (!m.odds || !m.oddsClose || m.homeGoals == null || m.awayGoals == null) return null;
  const band = driftBand(m.odds, m.oddsClose);
  if (!band) return null;
  const cf = frameOf(m.oddsClose);
  if (!cf || cf.side === "draw") return null;
  const favRealized = cf.side === "home" ? m.homeGoals > m.awayGoals : m.awayGoals > m.homeGoals;
  return { band, favRealized };
}

function aggregate(matches) {
  const buckets = { 热门走强: { n: 0, hit: 0 }, 盘口平稳: { n: 0, hit: 0 }, 热门走弱: { n: 0, hit: 0 } };
  for (const m of matches) {
    const c = classify(m);
    if (!c) continue;
    buckets[c.band].n += 1;
    if (c.favRealized) buckets[c.band].hit += 1;
  }
  return buckets;
}

function rate(b) {
  return b.n ? ((b.hit / b.n) * 100).toFixed(1) + "%" : "—";
}

function ordered(buckets) {
  const strong = buckets.热门走强.n ? buckets.热门走强.hit / buckets.热门走强.n : null;
  const weak = buckets.热门走弱.n ? buckets.热门走弱.hit / buckets.热门走弱.n : null;
  if (strong == null || weak == null) return "样本不足";
  return strong > weak ? `✅ 走强(${(strong * 100).toFixed(1)}%) > 走弱(${(weak * 100).toFixed(1)}%) [+${((strong - weak) * 100).toFixed(1)}pp]` : `❌ 走强未高于走弱`;
}

const res = await loadFootballDataMatches({ leagues: BIG5 });
const withBoth = res.matches.filter((m) => m.odds && m.oddsClose && m.homeGoals != null);
console.log(`football-data big-5:总 ${res.matches.length} 场,开盘+收盘双价齐 ${withBoth.length} 场`);

// 70/30 时间留出(已按 date 升序)
const cut = Math.floor(withBoth.length * 0.7);
const train = withBoth.slice(0, cut);
const test = withBoth.slice(cut);
console.log(`时间切分:train ${train.length}(${train[0]?.date}~${train.at(-1)?.date}) / test ${test.length}(${test[0]?.date}~${test.at(-1)?.date})\n`);

const trainAgg = aggregate(train);
const testAgg = aggregate(test);

console.log("【训练集】各漂移档收盘热门兑现率:");
for (const k of ["热门走强", "盘口平稳", "热门走弱"]) console.log(`  ${k}: ${rate(trainAgg[k])} (${trainAgg[k].n}场)`);
console.log("  排序判定:", ordered(trainAgg));

console.log("\n【留出测试集(样本外)】各漂移档收盘热门兑现率:");
for (const k of ["热门走强", "盘口平稳", "热门走弱"]) console.log(`  ${k}: ${rate(testAgg[k])} (${testAgg[k].n}场)`);
console.log("  排序判定:", ordered(testAgg));

// 分联赛 test 集
console.log("\n【分联赛 · 留出测试集】走强 vs 走弱 热门兑现:");
for (const lg of BIG5) {
  const sub = test.filter((m) => m.league === lg);
  if (sub.length < 30) continue;
  const a = aggregate(sub);
  console.log(`  ${LEAGUE_LABELS[lg] ?? lg}: ${ordered(a)}  [走强${a.热门走强.n}/平稳${a.盘口平稳.n}/走弱${a.热门走弱.n}]`);
}

console.log("\n诚实结论见各档 pp 差与样本量:差值小/样本少=信号弱,只作透明读数不押注(遵既有'盘口移动超不过市场')。");
