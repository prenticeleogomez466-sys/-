import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOneX2Producers, buildEmpiricalTables, PRODUCER_KEYS } from "../src/ensemble-producers.js";
import { fuseEnsemble1x2, loadEnsemble1x2Profile, __resetEnsemble1x2ForTests } from "../src/ensemble-1x2.js";

describe("胜负平 10 路集成", () => {
  test("PRODUCER_KEYS 恰 10 路", () => {
    assert.equal(PRODUCER_KEYS.length, 10);
    assert.ok(PRODUCER_KEYS.includes("market") && PRODUCER_KEYS.includes("dc") && PRODUCER_KEYS.includes("experience"));
  });

  test("buildOneX2Producers:缺拟合/缺数据的路返回 null,不编造", () => {
    const prod = buildOneX2Producers({}, { home: "A", away: "B", league: "英超", marketProbs: { home: 0.5, draw: 0.3, away: 0.2 } }, {});
    assert.ok(prod.market && Math.abs(prod.market.home + prod.market.draw + prod.market.away - 1) < 1e-9, "market 归一");
    assert.equal(prod.dc, null, "无 DC 拟合 → null");
    assert.equal(prod.pi, null);
  });

  test("buildEmpiricalTables:拉普拉斯平滑频率,概率归一", () => {
    const matches = Array.from({ length: 50 }, (_, i) => ({ homeGoals: i % 3, awayGoals: i % 2, league: "测试联", date: "2025-01-01" }));
    const t = buildEmpiricalTables(matches, () => ({ home: 0.6, draw: 0.25, away: 0.15 }));
    const lp = t.leaguePrior.get("测试联");
    assert.ok(lp && Math.abs(lp.h + lp.d + lp.a - 1) < 1e-9, "联赛先验归一");
  });

  test("fuseEnsemble1x2:有 market 用 withMarket 权重,无 market 用 noMarket 权重", () => {
    __resetEnsemble1x2ForTests();
    const prof = loadEnsemble1x2Profile();
    if (!prof) return; // 无 profile(CI 无 exports)则跳过
    const withMkt = fuseEnsemble1x2({ market: { home: 0.5, draw: 0.3, away: 0.2 }, dc: { home: 0.4, draw: 0.3, away: 0.3 }, experience: { home: 0.45, draw: 0.3, away: 0.25 } });
    assert.equal(withMkt.weightSet, "withMarket");
    const noMkt = fuseEnsemble1x2({ dc: { home: 0.4, draw: 0.3, away: 0.3 }, experience: { home: 0.45, draw: 0.3, away: 0.25 } });
    assert.ok(noMkt.weightSet.startsWith("noMarket"));
    assert.ok(Math.abs(noMkt.probabilities.home + noMkt.probabilities.draw + noMkt.probabilities.away - 1) < 1e-9);
  });
});
