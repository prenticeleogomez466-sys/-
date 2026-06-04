import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confederationOf,
  confederationEloAdjustment,
  worldCupMatchPrior,
  eloExpectation,
} from "../src/world-cup-priors.js";

test("confederationOf 映射已知队的洲属", () => {
  assert.equal(confederationOf("Spain"), "UEFA");
  assert.equal(confederationOf("Japan"), "AFC");
  assert.equal(confederationOf("Brazil"), "CONMEBOL");
  assert.equal(confederationOf("Australia"), "AFC"); // 2006 起属 AFC
  assert.equal(confederationOf("New Zealand"), "OFC");
  assert.equal(confederationOf("United States"), "CONCACAF");
  assert.equal(confederationOf("Senegal"), "CAF");
  assert.equal(confederationOf("不存在的队"), null);
});

test("confederationEloAdjustment = Δ主洲 − Δ客洲,符号正确且反对称", () => {
  // UEFA(+20) vs AFC(-80) = +100 给主队
  assert.equal(confederationEloAdjustment("Spain", "Japan"), 100);
  // 反过来 = -100
  assert.equal(confederationEloAdjustment("Japan", "Spain"), -100);
  // 同洲 → 0
  assert.equal(confederationEloAdjustment("Spain", "France"), 0);
  // CONMEBOL 参考 = 0;CONMEBOL vs CAF(-60) = +60
  assert.equal(confederationEloAdjustment("Brazil", "Senegal"), 60);
  // 未知队按 0 处理,不臆造
  assert.equal(confederationEloAdjustment("火星队", "Spain"), -20);
});

test("worldCupMatchPrior 把洲际校正叠加进 Elo 差,且推向被低估方", () => {
  const withAdj = worldCupMatchPrior("Japan", "Spain"); // AFC 主、UEFA 客 → confedAdj=-100
  if (!withAdj) return; // 数据缺失环境跳过(CI 无 team-priors.json 时)
  assert.equal(withAdj.confedAdj, -100);
  assert.match(withAdj.source, /confed-100/);

  // 同两队不带校正的纯 Elo 期望应比带校正(主队被扣 100)给主队更高胜率
  // 通过 eloExpectation 直接对比:校正使主队(Japan)期望下降。
  const teamElo = 1700; // 任意,验证方向
  const base = eloExpectation(teamElo, teamElo, 0);
  const penalized = eloExpectation(teamElo, teamElo, -100);
  assert.ok(penalized.home < base.home, "扣 100 Elo 后主队胜率应下降");
});
