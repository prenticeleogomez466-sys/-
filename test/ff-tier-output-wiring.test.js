/**
 * FF 档接入测试:consistency-derivation + extended-markets 接进 prediction-engine 主路径。
 * 不跑整条 recommendFixtures 流水,只验证 validatePredictionConsistency 新增的 handicap
 * 一致性、scoreMatrix 暴露给 extended-markets、以及 buildExtendedMarkets 端到端形状。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePredictionConsistency } from "../src/prediction-engine.js";
import { buildExtendedMarkets } from "../src/extended-markets.js";
import { predictFromFitted } from "../src/dixon-coles-engine.js";

describe("FF 档 — consistency-derivation 接入 validatePredictionConsistency", () => {
  // prediction-engine 用 "主胜-主胜" 格式的 halfFull;consistency-derivation 用单字符"胜胜"。
  // 验证 halfFull 一致性走的是 prediction-engine 自己的 scoreHalfFullConsistent(走 normalizeHalfFull)。
  // 这里测试只盯新增的 handicap 一致性。
  it("score 1-0 + handicapPick.direction=主胜 + line=0 → 一致,无 error", () => {
    const prediction = {
      scorePicks: { primary: "1-0", secondary: "0-0" },
      halfFullPicks: { primary: "主胜-主胜", secondary: "平局-平局" },
      pick: { code: "3", label: "主胜" },
      secondaryPick: { code: "1", label: "平局" },
      handicapPick: { line: 0, direction: "主胜" }
    };
    const errors = validatePredictionConsistency(prediction);
    assert.equal(errors.length, 0, `应无 error,得到: ${errors.join("; ")}`);
  });

  it("score 1-0 + handicapPick=客胜(让 -1 → 0-0 平,不该客胜) → 报错", () => {
    const prediction = {
      scorePicks: { primary: "1-0", secondary: "0-0" },
      halfFullPicks: { primary: "主胜-主胜", secondary: "平局-平局" },
      pick: { code: "3", label: "主胜" },
      secondaryPick: { code: "1", label: "平局" },
      handicapPick: { line: -1, direction: "客胜" }
    };
    const errors = validatePredictionConsistency(prediction);
    assert.ok(errors.some((e) => e.includes("让球方向") || e.includes("派生冲突")), `应捕获让球矛盾,得到: ${errors.join("; ")}`);
  });

  it("score 0-0 + handicapPick=客胜(让 -1 → -1,客胜)→ 一致", () => {
    const prediction = {
      scorePicks: { primary: "0-0", secondary: "0-1" },
      halfFullPicks: { primary: "平局-平局", secondary: "平局-客胜" },
      pick: { code: "1", label: "平局" },
      secondaryPick: { code: "0", label: "客胜" },
      handicapPick: { line: -1, direction: "客胜" }
    };
    const errors = validatePredictionConsistency(prediction);
    assert.equal(errors.length, 0, `应无 error,得到: ${errors.join("; ")}`);
  });

  it("缺 handicapPick 不会报错(backward-compat)", () => {
    const prediction = {
      scorePicks: { primary: "1-0", secondary: "0-0" },
      halfFullPicks: { primary: "主胜-主胜", secondary: "平局-平局" },
      pick: { code: "3", label: "主胜" },
      secondaryPick: { code: "1", label: "平局" }
    };
    const errors = validatePredictionConsistency(prediction);
    assert.equal(errors.length, 0);
  });
});

describe("FF 档 — dc matrix 暴露 + extended-markets 端到端", () => {
  it("predictFromFitted 返回结果包含 matrix 字段", () => {
    const fitted = {
      usable: true,
      teams: {
        "A": { attack: 1.2, defense: 0.9 },
        "B": { attack: 0.8, defense: 1.1 }
      },
      homeAdvantage: 0.25,
      baseRate: 1.3,
      rho: -0.08
    };
    const r = predictFromFitted(fitted, { homeTeam: "A", awayTeam: "B" });
    assert.ok(r);
    assert.ok(Array.isArray(r.matrix), "应有 matrix");
    assert.ok(r.matrix.length > 0);
    assert.ok(Array.isArray(r.matrix[0]));
  });

  it("buildExtendedMarkets 从 matrix 派生 7 大玩法", () => {
    const fitted = {
      usable: true,
      teams: {
        "A": { attack: 1.2, defense: 0.9 },
        "B": { attack: 0.8, defense: 1.1 }
      },
      homeAdvantage: 0.25,
      baseRate: 1.3,
      rho: -0.08
    };
    const dc = predictFromFitted(fitted, { homeTeam: "A", awayTeam: "B" });
    const markets = buildExtendedMarkets(dc.matrix);
    assert.ok(markets);
    assert.ok(markets.overUnder?.["2.5"]?.over > 0);
    assert.ok(markets.totalGoalsOddEven);
    assert.ok(markets.firstHalf);
    assert.ok(markets.asianHandicap);
    assert.ok(markets.doubleChance);
    assert.ok(markets.scoreGroup);
    assert.ok(markets.totalGoalsExact);
  });

  it("各玩法概率内部归一(over+under≈1, odd+even≈1)", () => {
    const fitted = {
      usable: true,
      teams: { "A": { attack: 1.1, defense: 0.95 }, "B": { attack: 0.9, defense: 1.05 } },
      homeAdvantage: 0.25, baseRate: 1.3, rho: -0.08
    };
    const dc = predictFromFitted(fitted, { homeTeam: "A", awayTeam: "B" });
    assert.ok(dc?.matrix, "predictFromFitted 应返回 matrix");
    const m = buildExtendedMarkets(dc.matrix);
    const ouSum = m.overUnder["2.5"].over + m.overUnder["2.5"].under;
    assert.ok(Math.abs(ouSum - 1) < 0.02, `over+under = ${ouSum}`);
    const oeSum = m.totalGoalsOddEven.odd + m.totalGoalsOddEven.even;
    assert.ok(Math.abs(oeSum - 1) < 0.02, `odd+even = ${oeSum}`);
  });
});
