/**
 * 彩票构造优化器回测(2026-05-31)—— 验证"优化覆盖"在同注数预算下整票全中率更高。
 * 用 football-data 真实赛果造 9 腿一票(市场隐含概率为腿概率,真实结果为答案),对比三策略:
 *   ① 全单选(成本1)        —— 最省、命中最低
 *   ② 朴素覆盖(双最弱腿到预算)—— 常见手法
 *   ③ 优化覆盖(optimizeTicket)—— 按 Δlogp/Δlogcost 贪心分配
 * 指标:整票"9腿全中"率 + 平均注数。判读:同预算下 ③ 全中率应 ≥ ②(把保险加在边际收益最高的腿)。
 * 用法:node scripts/run-ticket-optimizer-backtest.mjs
 */
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { optimizeTicket } from "../src/ticket-optimizer.js";

const BUDGET = 64;             // 注数预算
const ROUND = 9;               // 任选9
const actual = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
const CODES = ["home", "draw", "away"];

const L = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const all = L.matches.filter((m) => m.homeGoals != null && m.odds && m.date)
  .sort((a, b) => a.date.localeCompare(b.date));

// 造票:每 ROUND 场连续比赛一票(贴近真实"一期"混合多联赛)
const tickets = [];
for (let i = 0; i + ROUND <= all.length; i += ROUND) {
  tickets.push(all.slice(i, i + ROUND));
}
console.log(`${all.length} 场 → ${tickets.length} 张 ${ROUND} 腿票,预算 ${BUDGET} 注\n`);

const legsOf = (t) => t.map((m) => ({
  probs: CODES.map((c) => m.odds[c]),
  codes: CODES,
  outcome: actual(m.homeGoals, m.awayGoals),
}));

// 策略命中:每腿覆盖集合是否含真实结果,全腿都含 → 整票命中
function coverHitAll(legs, coverCodesPerLeg) {
  return legs.every((leg, i) => coverCodesPerLeg[i].includes(leg.outcome));
}

// ① 全单选
function singleStrategy(legs) {
  return legs.map((leg) => {
    const top = CODES.map((c, j) => ({ c, p: leg.probs[j] })).sort((a, b) => b.p - a.p)[0].c;
    return [top];
  });
}
// ② 朴素:从最弱腿(top 概率最低)起依次双选,直到注数到预算
function naiveStrategy(legs) {
  const order = legs.map((leg, i) => ({ i, top: Math.max(...leg.probs) })).sort((a, b) => a.top - b.top);
  const cover = legs.map((leg) => {
    const top = CODES.map((c, j) => ({ c, p: leg.probs[j] })).sort((a, b) => b.p - a.p)[0].c;
    return [top];
  });
  let cost = 1;
  for (const { i } of order) {
    if (cost * 2 > BUDGET) break;
    const sorted = CODES.map((c, j) => ({ c, p: legs[i].probs[j] })).sort((a, b) => b.p - a.p);
    cover[i] = [sorted[0].c, sorted[1].c];
    cost *= 2;
  }
  return cover;
}
// ③ 优化
function optStrategy(legs) {
  const r = optimizeTicket(legs.map((l) => ({ probs: l.probs, codes: l.codes })), { budget: BUDGET });
  return r.legs.map((l) => l.codes);
}

const stat = { single: { hit: 0, cost: 0 }, naive: { hit: 0, cost: 0 }, opt: { hit: 0, cost: 0 } };
const costOf = (cover) => cover.reduce((m, c) => m * c.length, 1);
for (const t of tickets) {
  const legs = legsOf(t);
  for (const [name, fn] of [["single", singleStrategy], ["naive", naiveStrategy], ["opt", optStrategy]]) {
    const cover = fn(legs);
    stat[name].hit += coverHitAll(legs, cover) ? 1 : 0;
    stat[name].cost += costOf(cover);
  }
}
const N = tickets.length;
console.log("策略            整票全中率    平均注数");
for (const [name, label] of [["single", "① 全单选"], ["naive", "② 朴素双弱腿"], ["opt", "③ 优化覆盖"]]) {
  const s = stat[name];
  console.log(label.padEnd(14), (s.hit / N * 100).toFixed(2).padStart(6) + "%", (s.cost / N).toFixed(1).padStart(8));
}
const lift = (stat.opt.hit - stat.naive.hit) / Math.max(1, stat.naive.hit) * 100;
console.log(`\n优化 vs 朴素(同预算):全中率 ${stat.naive.hit}→${stat.opt.hit}(${lift >= 0 ? "+" : ""}${lift.toFixed(1)}%),平均注数 ${(stat.naive.cost / N).toFixed(1)}→${(stat.opt.cost / N).toFixed(1)}`);
console.log("判读:同预算下 ③ 全中率 > ② 即证明优化把保险加在边际收益最高的腿、更省更准。");
