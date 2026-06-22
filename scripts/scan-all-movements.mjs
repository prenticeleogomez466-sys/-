/**
 * scan-all-movements.mjs —— 系统回测「全市场初盘→终盘变化」对方向/大小球的预测力(2026-06-22 用户令:全部考虑、回测后才加)。
 * ════════════════════════════════════════════════════════════════════════════
 * 数据底座:collectHistoricalMatches 的 marketHistorical(89062 场带初+终):
 *   ① 1X2:openProbs→closeProbs(热门加注/退烧)  ② 大小球:overProb→overProbClose(大球盘加注/退烧)
 *   ③ 亚盘:line→lineClose(让球线加深/减浅)+ homeWater/awayWater→Close(水位移向主/客)
 * 注:比分/半全场/竞彩专属盘 football-data 无初→终历史 → 本脚本无法回测(诚实标缺,另由"结果条件分布"补)。
 *
 * 方法(leak-safe):按日期时序 70/30 切,TRAIN 找方向、TEST 验;只报 TRAIN&TEST 同号且样本足(≥120)。
 * 诚实铁律(reference_signal_backtest_findings):多数 movement 是噪声、打不过收盘线;本脚本就是要把"真有方向预示"
 *   的那几条从噪声里筛出来——过测的才有资格进引擎,过不了如实判噪声不加。命中≠盈利(收盘已定价)。
 */
import { collectHistoricalMatches } from "../src/ratings-bootstrap.js";

const all = collectHistoricalMatches(4000)
  .filter((m) => m.marketHistorical && m.homeGoals != null && m.awayGoals != null && m.date)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

function feat(m) {
  const mh = m.marketHistorical;
  const o = mh.openProbs, c = mh.closeProbs;
  if (!o || !c || !(o.home > 0 && o.away > 0)) return null;
  const favKey = c.home >= c.away ? "home" : "away";          // 收盘热门侧
  const fav1x2Drift = c[favKey] - o[favKey];                  // >0 热门被加注 <0 退烧
  const ouDrift = (mh.overProbClose != null && mh.overProb != null) ? mh.overProbClose - mh.overProb : null; // 大球盘加注/退烧
  const a = mh.asian || {};
  const lineMove = (a.lineClose != null && a.line != null) ? Math.abs(a.lineClose) - Math.abs(a.line) : null; // >0 让球线加深
  const waterMove = (a.homeWaterClose != null && a.homeWater != null && a.awayWaterClose != null && a.awayWater != null)
    ? (a.homeWaterClose - a.homeWater) - (a.awayWaterClose - a.awayWater) : null; // <0 主水降(钱压主队过盘) >0 客侧
  const outcome = m.homeGoals > m.awayGoals ? "home" : m.homeGoals < m.awayGoals ? "away" : "draw";
  const over = (m.homeGoals + m.awayGoals) > 2.5 ? 1 : 0;
  return { favKey, fav1x2Drift, ouDrift, lineMove, waterMove, outcome, over, favHit: outcome === favKey ? 1 : 0 };
}

const rows = all.map(feat).filter(Boolean);
const cut = Math.floor(rows.length * 0.7);
const TR = rows.slice(0, cut), TE = rows.slice(cut);
console.log(`样本 ${rows.length}(带完整初终)| TRAIN ${TR.length} / TEST ${TE.length}`);
const baseFav = (set) => set.reduce((s, r) => s + r.favHit, 0) / set.length;
const baseOver = (set) => set.reduce((s, r) => s + r.over, 0) / set.length;
console.log(`基线:热门命中 TR ${(baseFav(TR) * 100).toFixed(1)}% / TE ${(baseFav(TE) * 100).toFixed(1)}% ｜ 大球率 TR ${(baseOver(TR) * 100).toFixed(1)}% / TE ${(baseOver(TE) * 100).toFixed(1)}%`);

// 通用:给一个子集筛选器 + 目标(favHit/over),报 TRAIN/TEST 命中 + 超基线
function evalRule(name, filt, target) {
  const trS = TR.filter(filt), teS = TE.filter(filt);
  if (trS.length < 120 || teS.length < 60) return null;
  const rate = (set) => set.reduce((s, r) => s + r[target], 0) / set.length;
  const base = target === "favHit" ? baseFav : baseOver;
  const trR = rate(trS), teR = rate(teS), trB = base(TR), teB = base(TE);
  const trLift = trR - trB, teLift = teR - teB;
  const stable = Math.sign(trLift) === Math.sign(teLift) && Math.abs(teLift) >= 0.02; // 同号+TEST超基线≥2pp
  return { name, target, trN: trS.length, teN: teS.length, trR, teR, trLift, teLift, stable };
}

const pc = (x) => (x * 100).toFixed(1) + "%";
const sp = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "pp";

// ── ① 单信号:每个 movement 的方向 ──
const tests = [
  // 1X2 热门走势 → 热门命中
  ["1X2热门加注(收盘≥初+3%)→热门", (r) => r.fav1x2Drift >= 0.03, "favHit"],
  ["1X2热门退烧(收盘≤初-3%)→热门", (r) => r.fav1x2Drift <= -0.03, "favHit"],
  // 大小球走势 → 大球
  ["大球盘加注(over收≥初+3%)→大球", (r) => r.ouDrift != null && r.ouDrift >= 0.03, "over"],
  ["大球盘退烧(over收≤初-3%)→大球", (r) => r.ouDrift != null && r.ouDrift <= -0.03, "over"],
  // 亚盘让球线移动 → 热门命中
  ["让球线加深(收盘比初盘深≥0.25)→热门", (r) => r.lineMove != null && r.lineMove >= 0.25, "favHit"],
  ["让球线减浅(收盘比初盘浅≥0.25)→热门", (r) => r.lineMove != null && r.lineMove <= -0.25, "favHit"],
  // 亚盘水位移动(钱压主/客过盘) → 热门命中
  ["亚盘水位移向主队(主水降)→热门", (r) => r.waterMove != null && r.waterMove <= -0.06, "favHit"],
  ["亚盘水位移向客队(客水降)→热门", (r) => r.waterMove != null && r.waterMove >= 0.06, "favHit"],
];

console.log("\n══ ① 单信号(movement→方向)══");
console.log("信号".padEnd(34), "目标", "TR_N", "TE_N", "TR命中", "TE命中", "TR超基", "TE超基", "稳定?");
const singleResults = [];
for (const [name, filt, target] of tests) {
  const r = evalRule(name, filt, target);
  if (!r) { console.log(name.padEnd(34), "样本不足"); continue; }
  singleResults.push(r);
  console.log(name.padEnd(34), r.target.padEnd(6), r.trN, r.teN, pc(r.trR), pc(r.teR), sp(r.trLift), sp(r.teLift), r.stable ? "🟢稳定" : "—噪声");
}

// ── ② 两两交叉(只在两个单信号都"看起来有方向"时才组合,看是否叠加) ──
console.log("\n══ ② 关键交叉组合(同向叠加是否增强)══");
const crosses = [
  ["1X2加注 + 大球盘加注 → 大球", (r) => r.fav1x2Drift >= 0.03 && r.ouDrift != null && r.ouDrift >= 0.03, "over"],
  ["1X2加注 + 让球线加深 → 热门", (r) => r.fav1x2Drift >= 0.03 && r.lineMove != null && r.lineMove >= 0.25, "favHit"],
  ["1X2加注 + 水位移向热门 → 热门", (r) => r.fav1x2Drift >= 0.03 && r.waterMove != null && ((r.favKey === "home" && r.waterMove <= -0.06) || (r.favKey === "away" && r.waterMove >= 0.06)), "favHit"],
  ["1X2退烧 + 大球盘退烧 → 小球(看over低)", (r) => r.fav1x2Drift <= -0.03 && r.ouDrift != null && r.ouDrift <= -0.03, "over"],
  ["让球线加深 + 大球盘加注 → 大球", (r) => r.lineMove != null && r.lineMove >= 0.25 && r.ouDrift != null && r.ouDrift >= 0.03, "over"],
];
for (const [name, filt, target] of crosses) {
  const r = evalRule(name, filt, target);
  if (!r) { console.log(name.padEnd(40), "样本不足(交叉太稀)"); continue; }
  singleResults.push(r);
  console.log(name.padEnd(40), r.target.padEnd(6), r.trN, r.teN, "TE命中", pc(r.teR), "超基", sp(r.teLift), r.stable ? "🟢稳定" : "—噪声");
}

// ── 裁决 ──
console.log("\n══ 裁决:过测(TRAIN&TEST同号+TEST超基线≥2pp+样本足)的信号 ══");
const passed = singleResults.filter((r) => r.stable);
if (!passed.length) console.log("  无新 movement 信号过测(全噪声)→ 不加进引擎(守诚实铁律)。");
for (const r of passed) console.log(`  🟢 ${r.name}｜TEST ${pc(r.teR)}(超基${sp(r.teLift)}·n=${r.teN})`);
console.log("\n诚实:命中≠盈利(收盘已定价);过测=有方向预示力可作选择性出手/避坑,非稳赚。比分/半全场/竞彩专属盘无初终历史→本轮回测不了(标缺)。");
