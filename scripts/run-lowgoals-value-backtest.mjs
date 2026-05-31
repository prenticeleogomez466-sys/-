#!/usr/bin/env node
/**
 * 低分/大小球市场 value 检测回测(2026-05-31)——顶级精髓里"books 在低分市场定价最弱"那一刀。
 * 模型 P(大球2.5) **独立于盘口大小球**(DC 队伍强度 λ → 真泊松矩阵,不喂 O/U 线,防循环),
 * 与盘口隐含 P(大球) 比;在分歧处看**实际大球率是否真偏向模型那边**(= 真 edge / 正 CLV)。
 * leak-safe 月度重拟合。用法:node scripts/run-lowgoals-value-backtest.mjs
 *
 * 诚实预期:盘口大概率有效,模型 λ 来自同样公开赛果,未必赢得过盘口 → 大概率小/无 edge。
 * 但 DC-τ 专修低分,盘口简单 O/U 未必吃透 → 验证有没有局部 edge。变好才留。
 */
import "../src/env.js";
import { loadFootballDataMatches, ALL_LEAGUES } from "../src/footballdata-loader.js";
import { fitFromMatches, predictFromFitted } from "../src/dixon-coles-engine.js";

const { matches } = await loadFootballDataMatches({ leagues: ALL_LEAGUES });
const M = matches
  .filter((m) => m.homeGoals != null && (m.overProbClose ?? m.overProb) != null)
  .map((m) => ({ ...m, _bookOver: Number(m.overProbClose ?? m.overProb) }))
  .filter((m) => Number.isFinite(m._bookOver) && m._bookOver > 0.05 && m._bookOver < 0.95)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const monthOf = (d) => String(d).slice(0, 7);
const clip = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const ll = (p, y) => -(y * Math.log(clip(p)) + (1 - y) * Math.log(clip(1 - p)));

let fit = null, fitMonth = null;
const rows = [];
for (let i = 0; i < M.length; i++) {
  const m = M[i];
  const mo = monthOf(m.date);
  if (mo !== fitMonth) {
    const train = M.slice(0, i);
    if (train.length >= 400) { try { fit = fitFromMatches(train, { goalSignal: "actual" }); } catch { fit = null; } }
    fitMonth = mo;
  }
  if (!fit) continue;
  let pred; try { pred = predictFromFitted(fit, { homeTeam: m.home, awayTeam: m.away }); } catch { pred = null; }
  const modelOver = pred?.overUnder?.over;
  if (!Number.isFinite(modelOver)) continue;
  rows.push({ modelOver, bookOver: m._bookOver, actualOver: (m.homeGoals + m.awayGoals) >= 3 ? 1 : 0 });
}

const n = rows.length;
const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / n;
const actualRate = mean((r) => r.actualOver);
const llBook = mean((r) => ll(r.bookOver, r.actualOver));
const llModel = mean((r) => ll(r.modelOver, r.actualOver));
const llBlend = mean((r) => ll(0.5 * r.bookOver + 0.5 * r.modelOver, r.actualOver));

console.log("═".repeat(64));
console.log("低分/大小球(O/U 2.5)value 检测回测");
console.log("═".repeat(64));
console.log(`样本 ${n} 场,实际大球率 ${(actualRate * 100).toFixed(1)}%`);
console.log(`\n① 校准(LogLoss,越低越好):`);
console.log(`   盘口     ${llBook.toFixed(4)}`);
console.log(`   模型独立 ${llModel.toFixed(4)}  (${llModel < llBook ? "✅优于盘口" : "❌劣于盘口"})`);
console.log(`   50/50混  ${llBlend.toFixed(4)}  (${llBlend < llBook ? "✅混合优于盘口=模型含盘口未消化信息" : "❌混合不优于盘口"})`);

console.log(`\n② value 下注(|模型−盘口|>阈值 → 押模型方向,看实际命中 vs 盘口隐含=边际edge):`);
for (const margin of [0.04, 0.06, 0.08, 0.10]) {
  let bet = 0, win = 0, sumBookImplied = 0;
  for (const r of rows) {
    const div = r.modelOver - r.bookOver;
    if (Math.abs(div) <= margin) continue;
    bet++;
    const betOver = div > 0;
    const won = betOver ? r.actualOver === 1 : r.actualOver === 0;
    if (won) win++;
    sumBookImplied += betOver ? r.bookOver : (1 - r.bookOver);
  }
  if (bet < 30) { console.log(`   阈值${margin}: 样本${bet}不足`); continue; }
  const hit = win / bet;
  const bookImplied = sumBookImplied / bet;          // 盘口对这些下注side的平均隐含命中
  const edge = hit - bookImplied;                     // >0 = 实际命中超过盘口隐含 = 正edge(≈公平赔率ROI)
  console.log(`   阈值${margin}: 下注${bet}场(${(bet / n * 100).toFixed(0)}%) 实际命中${(hit * 100).toFixed(1)}% vs 盘口隐含${(bookImplied * 100).toFixed(1)}% → edge ${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(2)}pp`);
}
console.log("═".repeat(64));
console.log("裁决:edge 显著>0 且多阈值稳健才算真 edge,可接 value 标注;否则诚实不上线。");
