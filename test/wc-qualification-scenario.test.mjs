import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDataSubdir } from "../src/paths.js";
import { positionPath, finalRoundScenario, mutualDrawSuspect, scenarioIntensity } from "../src/wc-qualification-scenario.js";

const bracket = JSON.parse(readFileSync(join(getDataSubdir("world-cup"), "2026", "bracket.json"), "utf8"));

test("positionPath: H 组第1名落下半区Q3、第2名落下半区Q4(西班牙/阿根廷死亡半区结构)", () => {
  const p = positionPath(bracket.r32, "H");
  assert.equal(p.pos1.slot, "1H");
  assert.equal(p.pos2.slot, "2H");
  assert.equal(p.pos1.half, "下半区");
  assert.equal(p.pos2.half, "下半区");
  // 1H 在 M84(vs 2J),2H 在 M86(vs 1J)——名次决定碰 J 组头名还是次名
  assert.equal(p.pos1.r32Match, 84);
  assert.equal(p.pos2.r32Match, 86);
  assert.equal(p.pos1.oppSlot, "2J");
  assert.equal(p.pos2.oppSlot, "1J");
});

test("finalRoundScenario: 已锁定/平即可/必须赢-未必够 三态(保守按积分,不臆造净胜球)", () => {
  // 末轮前:A 6 / B 4 / C 1 / D 1,前2出线
  const t1 = [
    { team: "A", pts: 6, gd: 4, gf: 6 }, { team: "B", pts: 4, gd: 1, gf: 3 },
    { team: "C", pts: 1, gd: -2, gf: 2 }, { team: "D", pts: 1, gd: -3, gf: 1 },
  ];
  assert.equal(finalRoundScenario(t1, "A", "D").tier, "likely-through"); // 6>1+3 锁定
  assert.equal(finalRoundScenario(t1, "B", "C").tier, "draw-enough");    // 4>1,平即可
  assert.equal(finalRoundScenario(t1, "C", "B").tier, "must-win-and-pray"); // 胜=4 不超第2名4
});

test("finalRoundScenario: 末轮第3名胜可反超→must-win", () => {
  const t2 = [
    { team: "A", pts: 6, gd: 4, gf: 6 }, { team: "B", pts: 3, gd: 0, gf: 2 },
    { team: "C", pts: 3, gd: 0, gf: 2 }, { team: "D", pts: 1, gd: -4, gf: 1 },
  ];
  assert.equal(finalRoundScenario(t2, "C", "B").tier, "must-win"); // 胜=6>第2名3
});

test("mutualDrawSuspect: 双方平即可出线→标默契球嫌疑", () => {
  const safe = { tier: "draw-enough" }, fight = { tier: "must-win" };
  assert.equal(mutualDrawSuspect(safe, safe), true);
  assert.equal(mutualDrawSuspect(safe, fight), false);
});

test("scenarioIntensity: 默认 no-op(铁律不偷改概率),显式 apply 才给保守 nudge", () => {
  const d = scenarioIntensity({ tier: "must-win" }, { tier: "likely-through" });
  assert.deepEqual(d, { home: 1.0, away: 1.0, applied: false });
  const a = scenarioIntensity({ tier: "must-win" }, { tier: "likely-through" }, true);
  assert.equal(a.applied, true);
  assert.ok(a.home > 1 && a.away < 1);
});
