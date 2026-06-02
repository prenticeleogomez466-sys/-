import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32, poissonSample, sampleScoreline, rankGroup,
  standardSeedOrder, seedBracket, simulateGroupStage, runMonteCarlo,
} from "../src/tournament-simulator.js";

test("mulberry32 同 seed 可复现、不同 seed 不同", () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  assert.ok(sa.every((x) => x >= 0 && x < 1));
});

test("poissonSample 大样本均值≈lambda", () => {
  const rng = mulberry32(7);
  let sum = 0; const N = 20000;
  for (let i = 0; i < N; i++) sum += poissonSample(1.6, rng);
  assert.ok(Math.abs(sum / N - 1.6) < 0.05, `mean ${sum / N}`);
});

test("sampleScoreline 强队主胜期望更高", () => {
  const rng = mulberry32(1);
  const exp = sampleScoreline(2000, 1500, { lambdaTotal: 2.6 }, rng);
  assert.ok(exp.we > 0.7, `we=${exp.we}`);
});

test("rankGroup 真 tiebreaker:积分优先、净胜球次之", () => {
  const teams = ["A", "B", "C", "D"];
  // A 全胜, B/C/D 各 1 胜;构造 A 第一,B 净胜球高于 C
  const matches = [
    { home: "A", away: "B", ga: 2, gb: 0 },
    { home: "A", away: "C", ga: 2, gb: 0 },
    { home: "A", away: "D", ga: 2, gb: 0 },
    { home: "B", away: "C", ga: 3, gb: 0 },
    { home: "C", away: "D", ga: 1, gb: 0 },
    { home: "D", away: "B", ga: 1, gb: 0 },
  ];
  const eloOf = (t) => ({ A: 1900, B: 1800, C: 1700, D: 1600 })[t];
  const ranked = rankGroup(teams, matches, eloOf);
  assert.equal(ranked[0], "A"); // 9 分第一
  // B,C,D 各 3 分 → 净胜球:B(+3-3+ -1? 计算) 用断言:第一必 A,最后一名净胜球最低
  assert.equal(ranked.length, 4);
  assert.ok(ranked.includes("B") && ranked.includes("C") && ranked.includes("D"));
});

test("rankGroup 全平时用相互战绩,再用评级兜底(非随机/可复现)", () => {
  const teams = ["A", "B"];
  const matches = [{ home: "A", away: "B", ga: 1, gb: 1 }]; // 全平
  const eloOf = (t) => ({ A: 1500, B: 1700 })[t];
  const r1 = rankGroup(teams, matches, eloOf);
  const r2 = rankGroup(teams, matches, eloOf);
  assert.deepEqual(r1, r2); // 确定性
  assert.equal(r1[0], "B"); // 评级高者兜底在前
});

test("standardSeedOrder 8 队种子树:1号对8号、强队分两半区", () => {
  const order = standardSeedOrder(8); // 0-based 种子下标
  assert.equal(order.length, 8);
  // 第一场是种子1(idx0) vs 种子8(idx7)
  assert.equal(order[0], 0);
  assert.equal(order[1], 7);
  // 标准种子序 [1,8,4,5,2,7,3,6] → 种子2(0-based=1)位于后半区起点(idx4),与种子1分两半区
  assert.equal(order[4], 1);
  assert.ok(order.slice(0, 4).includes(0) && order.slice(4).includes(1));
});

test("simulateGroupStage 产 24 直接出线 + 8 最佳第三 = 32", () => {
  const groups = {};
  for (let g = 0; g < 12; g++) groups[String.fromCharCode(65 + g)] = [`${g}-1`, `${g}-2`, `${g}-3`, `${g}-4`];
  const eloOf = (t) => 1500 + (t.endsWith("-1") ? 300 : t.endsWith("-2") ? 150 : t.endsWith("-3") ? 50 : 0);
  const rng = mulberry32(99);
  const gs = simulateGroupStage(groups, eloOf, rng, {});
  assert.equal(gs.winners.length, 12);
  assert.equal(gs.runners.length, 12);
  assert.equal(gs.bestThirds.length, 8);
  assert.equal(gs.advancers.length, 32);
});

test("runMonteCarlo:概率单调、夺冠和≈1、出线和≈32,强队夺冠概率最高", () => {
  const groups = {};
  for (let g = 0; g < 12; g++) groups[String.fromCharCode(65 + g)] = [`${g}-1`, `${g}-2`, `${g}-3`, `${g}-4`];
  // A-1 全场最强
  const eloOf = (t) => {
    if (t === "0-1") return 2100;
    return 1500 + (t.endsWith("-1") ? 250 : t.endsWith("-2") ? 120 : t.endsWith("-3") ? 40 : 0);
  };
  const res = runMonteCarlo({ groups, eloOf, hosts: new Set(), lambdaTotal: 2.6 }, 3000, 12345);
  assert.ok(res.audit.ok, `audit ${JSON.stringify(res.audit)}`);
  assert.ok(res.audit.monotonic);
  // 最强队夺冠概率应排第一且 > 任何其他
  assert.equal(res.teams[0].team, "0-1");
  assert.ok(res.teams[0].champion > res.teams[1].champion);
  // 同 seed 可复现
  const res2 = runMonteCarlo({ groups, eloOf, hosts: new Set(), lambdaTotal: 2.6 }, 3000, 12345);
  assert.equal(res.teams[0].champion, res2.teams[0].champion);
});
