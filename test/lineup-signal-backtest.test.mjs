import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeLineupSignal, wilsonInterval, applyLR } from "../src/lineup-signal-backtest.js";

test("wilsonInterval 合理且夹在 [0,1]", () => {
  const ci = wilsonInterval(50, 100);
  assert.ok(ci.lo > 0.39 && ci.lo < 0.5);
  assert.ok(ci.hi > 0.5 && ci.hi < 0.61);
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 0 });
});

test("applyLR 归一 + 真实信号 LR 位移温和、极端 LR 不炸概率", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const out = applyLR(prior, { home: 0.92, draw: 1.18, away: 0.92 });
  const sum = out.home + out.draw + out.away;
  assert.ok(Math.abs(sum - 1) < 1e-9, "和=1");
  assert.ok(out.draw > prior.draw, "平局应上调");
  // 真实信号 LR(温和)下,平局位移应在 ±0.12 之内(几乎不触顶)
  assert.ok(Math.abs(out.draw - prior.draw) < 0.12, "真实 LR 位移温和");
  // 极端 LR:封顶机制保证仍是合法概率分布(和=1、各项∈[0,1]),不爆
  const ext = applyLR(prior, { home: 0.01, draw: 100, away: 0.01 });
  const esum = ext.home + ext.draw + ext.away;
  assert.ok(Math.abs(esum - 1) < 1e-9 && ext.draw <= 1 && ext.home >= 0 && ext.away >= 0);
});

test("analyzeLineupSignal 检出注入的方向信号 + LogLoss 改善", () => {
  const recs = [];
  const mk = (hf, af, res, k) => { for (let i = 0; i < k; i++) recs.push({ homeFormation: hf, awayFormation: af, result: res }); };
  mk("5-4-1", "5-3-2", "draw", 66); mk("5-4-1", "5-3-2", "home", 30); mk("5-4-1", "5-3-2", "away", 24);   // 双摆防 55% 平
  mk("4-3-3", "3-4-3", "draw", 14); mk("4-3-3", "3-4-3", "home", 60); mk("4-3-3", "3-4-3", "away", 46);   // 双压上 12% 平
  mk("4-4-2", "5-4-1", "draw", 52); mk("4-4-2", "5-4-1", "home", 90); mk("4-4-2", "5-4-1", "away", 58);   // 中性 26% 平
  const rep = analyzeLineupSignal(recs);
  assert.equal(rep.ok, true);
  assert.equal(rep.direction.bothDefensive.confirmed, true);
  assert.equal(rep.direction.bothAttacking.confirmed, true);
  assert.ok(rep.probabilisticGain.firedImproves);
  assert.ok(rep.probabilisticGain.logLoss.delta < 0, "LogLoss 应改善");
});

test("analyzeLineupSignal 空样本安全返回", () => {
  assert.equal(analyzeLineupSignal([]).ok, false);
  assert.equal(analyzeLineupSignal(null).ok, false);
});
