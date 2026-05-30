import assert from "node:assert/strict";
import { test } from "node:test";
import { fitFromMatches } from "../src/dixon-coles-engine.js";

// 造数据:强队 STRONG 大量高比分主场 + 一支只踢极少场的 RARE 队。
// 收缩(K>0)应把低出场的 RARE 拉向均值 1.0,高出场队几乎不动。
function buildMatches() {
  const matches = [];
  const ref = "2025-01-01";
  const filler = ["A", "B", "C", "D", "E", "F"];
  // 大量常规对局(让多数队出场充足,基线稳)
  let day = 1;
  for (let r = 0; r < 12; r++) {
    for (let i = 0; i < filler.length; i += 2) {
      matches.push({ home: filler[i], away: filler[i + 1], homeGoals: 1, awayGoals: 1, date: `2024-${String((day % 9) + 1).padStart(2, "0")}-15` });
      day++;
    }
  }
  // STRONG 队出场很多、净胜多 → 真高 attack
  for (let r = 0; r < 30; r++) matches.push({ home: "STRONG", away: filler[r % 6], homeGoals: 4, awayGoals: 0, date: `2024-${String((r % 9) + 1).padStart(2, "0")}-20` });
  // RARE 队只踢 2 场、净胜也多 → 但样本太少,估计不可信
  matches.push({ home: "RARE", away: "A", homeGoals: 5, awayGoals: 0, date: "2024-09-25" });
  matches.push({ home: "RARE", away: "B", homeGoals: 4, awayGoals: 0, date: "2024-09-26" });
  return { matches, ref };
}

test("shrinkageK=0 不收缩(向后兼容):低出场队保留极端估计", () => {
  const { matches, ref } = buildMatches();
  const f = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 0, decayDays: 100000 });
  assert.ok(f.usable);
  // RARE 只 2 场 → 不收缩时 attack 估计应明显偏离均值 1.0(噪声大,未被正则化)
  assert.ok(Math.abs(f.teams["rare"].attack - 1) > 0.15, `RARE attack=${f.teams["rare"].attack}`);
});

test("shrinkageK>0 把低出场队拉向 1.0,远多于高出场队", () => {
  const { matches, ref } = buildMatches();
  const f0 = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 0, decayDays: 100000 });
  const fK = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 4, decayDays: 100000 });
  const rareMove = Math.abs(fK.teams["rare"].attack - f0.teams["rare"].attack);
  const strongMove = Math.abs(fK.teams["strong"].attack - f0.teams["strong"].attack);
  // 低出场队被拉得更狠
  assert.ok(rareMove > strongMove, `rareMove=${rareMove} strongMove=${strongMove}`);
  // RARE 收缩后更接近 1.0
  assert.ok(Math.abs(fK.teams["rare"].attack - 1) < Math.abs(f0.teams["rare"].attack - 1));
});

test("shrinkageK 越大收缩越强(单调向 1.0)", () => {
  const { matches, ref } = buildMatches();
  const a2 = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 2, decayDays: 100000 }).teams["rare"].attack;
  const a10 = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 10, decayDays: 100000 }).teams["rare"].attack;
  // K 越大 → RARE 越靠近 1.0
  assert.ok(Math.abs(a10 - 1) < Math.abs(a2 - 1), `a2=${a2} a10=${a10}`);
});

test("默认 shrinkageK=2:不传也启用温和收缩(生产默认)", () => {
  const { matches, ref } = buildMatches();
  const fDefault = fitFromMatches(matches, { referenceDate: ref, decayDays: 100000 });
  const f0 = fitFromMatches(matches, { referenceDate: ref, shrinkageK: 0, decayDays: 100000 });
  // 默认应已收缩(RARE 比关闭时更接近 1.0)
  assert.ok(Math.abs(fDefault.teams["rare"].attack - 1) < Math.abs(f0.teams["rare"].attack - 1));
});
