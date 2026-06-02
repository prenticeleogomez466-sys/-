import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDoubleRoundRobin, simulateLeagueSeason, runLeagueMonteCarlo } from "../src/league-simulator.js";
import { mulberry32 } from "../src/tournament-simulator.js";

test("generateDoubleRoundRobin:n队 → n*(n-1)场,主客各一次", () => {
  const fx = generateDoubleRoundRobin(["A", "B", "C", "D"]);
  assert.equal(fx.length, 12); // 4*3
  assert.ok(fx.some((f) => f.home === "A" && f.away === "B"));
  assert.ok(fx.some((f) => f.home === "B" && f.away === "A"));
});

test("simulateLeagueSeason:产完整积分榜,场次=每队打 2*(n-1)", () => {
  const teams = ["A", "B", "C", "D"];
  const eloOf = (t) => ({ A: 1900, B: 1800, C: 1700, D: 1600 })[t];
  const rng = mulberry32(5);
  const table = simulateLeagueSeason(teams, eloOf, {}, rng);
  assert.equal(table.length, 4);
  // 每队 6 场:最大积分 18
  assert.ok(table.every((r) => r.pts >= 0 && r.pts <= 18));
});

test("simulateLeagueSeason:midseason 叠加 currentTable 起始积分", () => {
  const teams = ["A", "B"];
  const eloOf = () => 1700;
  const rng = mulberry32(3);
  // 只剩 1 场,A 已有 30 分领先
  const table = simulateLeagueSeason(teams, eloOf, {
    fixtures: [{ home: "A", away: "B" }],
    currentTable: { A: { pts: 30, gd: 10, gf: 20 }, B: { pts: 5, gd: -5, gf: 8 } },
  }, rng);
  assert.equal(table[0].team, "A"); // A 必第一
  assert.ok(table[0].pts >= 30);
});

test("runLeagueMonteCarlo:概率审计通过,最强队夺冠率最高、最弱队降级率最高", () => {
  const teams = ["T1", "T2", "T3", "T4", "T5", "T6"];
  const elo = { T1: 2000, T2: 1850, T3: 1750, T4: 1700, T5: 1620, T6: 1500 };
  const eloOf = (t) => elo[t];
  const res = runLeagueMonteCarlo(teams, eloOf, { euroSpots: 2, europaCut: 3, relegationSpots: 2 }, 4000, 777);
  assert.ok(res.audit.ok, `audit ${JSON.stringify(res.audit)}`);
  // 夺冠和≈1
  assert.ok(Math.abs(res.audit.champSum - 1) < 0.02);
  // 最强 T1 夺冠率最高
  assert.equal(res.teams[0].team, "T1");
  assert.ok(res.teams[0].champion >= res.teams[1].champion);
  // 最弱 T6 降级率最高
  const t6 = res.teams.find((r) => r.team === "T6");
  const maxRel = Math.max(...res.teams.map((r) => r.relegation));
  assert.equal(t6.relegation, maxRel);
  // 单调合理:夺冠 ≤ 欧冠区 ≤ 欧战区
  assert.ok(res.teams.every((r) => r.champion <= r.euroUcl + 1e-9 && r.euroUcl <= r.euro + 1e-9));
});

test("runLeagueMonteCarlo:同 seed 可复现", () => {
  const teams = ["A", "B", "C", "D"];
  const eloOf = (t) => ({ A: 1900, B: 1800, C: 1700, D: 1600 })[t];
  const a = runLeagueMonteCarlo(teams, eloOf, { relegationSpots: 1 }, 1500, 42);
  const b = runLeagueMonteCarlo(teams, eloOf, { relegationSpots: 1 }, 1500, 42);
  assert.equal(a.teams[0].champion, b.teams[0].champion);
});
