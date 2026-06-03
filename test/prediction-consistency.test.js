import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditRecommendations } from "../src/recommendation-audit.js";
import { halfFullFinalOutcomeCode, predictFixture, scoreHalfFullConsistent, scoreOutcomeCode } from "../src/prediction-engine.js";

const baseFixture = {
  id: "fixture-1",
  date: "2026-05-15",
  kickoff: "2026-05-15 20:00",
  competition: "测试联赛",
  homeTeam: "主队",
  awayTeam: "客队",
  marketType: "jingcai",
  sequence: "001",
  tags: []
};

describe("prediction derived market consistency", () => {
  it("builds score and half-full picks from the selected WDL outcome", () => {
    const cases = [
      { expected: "3", odds: { home: 1.5, draw: 4.2, away: 6.5 } },
      { expected: "1", odds: { home: 3.4, draw: 2.1, away: 3.8 } },
      { expected: "0", odds: { home: 5.8, draw: 3.7, away: 1.7 } }
    ];

    for (const item of cases) {
      const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: item.odds } }]);
      assert.equal(prediction.pick.code, item.expected);
      // 2026-06-02 解耦:primary=真实最可能比分(独立,可含平局/反向),不再强制等于 wld 方向;
      //   方向一致性落在 wldConsistent/wldConsistentSecondary。
      assert.ok(/^\d+-\d+$/.test(prediction.scorePicks.primary), "首选应为真实比分");
      assert.equal(scoreOutcomeCode(prediction.scorePicks.wldConsistent), prediction.pick.code);
      assert.equal(scoreOutcomeCode(prediction.scorePicks.wldConsistentSecondary), prediction.secondaryPick.code);
      assert.equal(halfFullFinalOutcomeCode(prediction.halfFullPicks.primary), prediction.pick.code);
      assert.equal(halfFullFinalOutcomeCode(prediction.halfFullPicks.secondary), prediction.secondaryPick.code);
    }
  });

  it("无实时赔率且无 DC 训练 ⇒ 返回 unpredictable·data-missing,绝不编造方向(2026-05-30 根因修复)", () => {
    // 不传任何 marketSnapshot(无赔率)、不传 dixonColesFitted(无 DC)⇒ 历史上会落 seeded 哈希假概率。
    const prediction = predictFixture(baseFixture, [], 0, {});
    assert.equal(prediction.unpredictable, true);
    assert.equal(prediction.provenance, "data-missing");
    // 关键:绝不产出任何胜平负/比分/半全场方向(不编造)。
    assert.equal(prediction.pick, null);
    assert.equal(prediction.probabilities, null);
    assert.equal(prediction.scorePicks, null);
    assert.equal(prediction.halfFullPicks, null);
    assert.ok(prediction.dataMissingReason.includes("不预测"));
  });

  it("让球带 Skellam 独立交叉校验:同 λ 两路径覆盖概率应接近且给一致性提示(2026-05-30)", () => {
    const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 1.5, draw: 4.2, away: 6.5 } } }]);
    const sk = prediction.handicapPick.skellamCheck;
    assert.ok(sk, "应产出 skellamCheck");
    assert.ok(Number.isFinite(sk.coverProbability), "Skellam 覆盖概率应为数值");
    assert.ok(Number.isFinite(sk.gap), "应给矩阵与 Skellam 的分歧 gap");
    // 同一组 λ 的两条独立路径(二维矩阵 vs 一维 Skellam)应高度一致。
    assert.ok(sk.gap <= 0.08 && sk.agree === true, `两模型应一致,gap=${sk.gap}`);
    assert.ok(typeof sk.note === "string" && sk.note.length > 0);
  });

  it("让球胜平负融合市场亚盘水位:线一致时用市场主客比例(2026-05-31 矫正,回测 +1.49pp)", () => {
    // 亚盘线 -1 与让球线一致;主水低(1.5,被看好覆盖)、客水高(2.5)⇒ 市场隐含主覆盖 ≈0.625。
    const prediction = predictFixture(baseFixture, [{
      fixtureId: baseFixture.id,
      date: baseFixture.date,
      europeanOdds: { current: { home: 1.9, draw: 3.3, away: 3.9 } },
      asianHandicap: { current: { line: -1, homeWater: 1.5, awayWater: 2.5 } }
    }]);
    const hw = prediction.handicapPick.handicapWld;
    assert.equal(hw.source, "market-asian-water", "线一致+两路水位 ⇒ 融合市场");
    const mktHome = (1 / 1.5) / (1 / 1.5 + 1 / 2.5); // ≈0.625
    const splitHome = hw.probabilities.home / (hw.probabilities.home + hw.probabilities.away);
    assert.ok(Math.abs(splitHome - mktHome) < 0.02, `非push主客比例应≈市场 ${mktHome.toFixed(3)},实际 ${splitHome.toFixed(3)}`);
    // 仍保留模型 push(走盘)质量 + 模型原始覆盖供追溯。
    assert.ok(Number.isFinite(hw.probabilities.push));
    assert.ok(hw.modelCover && Number.isFinite(hw.modelCover.home));
  });

  it("让球胜平负无两路亚盘水位 ⇒ 降级纯 DC-τ 覆盖(零回归)", () => {
    const prediction = predictFixture(baseFixture, [{
      fixtureId: baseFixture.id,
      date: baseFixture.date,
      europeanOdds: { current: { home: 1.9, draw: 3.3, away: 3.9 } },
      asianHandicap: { current: { line: -1 } } // 只有线、无两路水位
    }]);
    const hw = prediction.handicapPick.handicapWld;
    assert.equal(hw.source, "dc-tau", "无水位应降级纯模型");
    // 降级时输出概率应等于模型覆盖(未被市场改写)。
    assert.equal(hw.probabilities.home, hw.modelCover.home);
    assert.equal(hw.probabilities.away, hw.modelCover.away);
  });

  it("fails audit when wld-consistent score or half-full conflicts with WDL outcome", () => {
    const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 1.5, draw: 4.2, away: 6.5 } } }]);
    // 真实众数 primary 允许任意方向;方向一致比分 wldConsistent 与 wld 冲突才该拦。
    prediction.scorePicks.wldConsistent = "0-1";
    const audit = auditRecommendations({ predictions: [prediction], fourteen: { count: 0 } });

    assert.equal(audit.ok, false);
    assert.ok(audit.summary.errors >= 1);
    assert.ok(audit.errors.some((e) => /方向一致比分/.test(e.message)), "应报方向一致比分冲突");
  });

  it("keeps score and half-full picks on a possible match path", () => {
    const prediction = predictFixture(baseFixture, [{
      fixtureId: baseFixture.id,
      date: baseFixture.date,
      europeanOdds: { current: { home: 1.5, draw: 4.2, away: 6.5 } },
      scoreOdds: { top: [{ score: "2-0", odds: 7.5 }] },
      halfFullOdds: { top: [{ halfFull: "负胜", odds: 18 }, { halfFull: "平胜", odds: 4.5 }] }
    }]);

    // 市场比分赔率 2-0 ⇒ 方向一致比分锚到 2-0;半全场与它路径自洽。真实众数 primary 独立(可平局)。
    assert.equal(prediction.scorePicks.wldConsistent, "2-0");
    assert.equal(scoreHalfFullConsistent(prediction.scorePicks.wldConsistent, prediction.halfFullPicks.primary), true);
    assert.ok(/^\d+-\d+$/.test(prediction.scorePicks.primary), "首选仍为真实比分");
  });

  it("bounds confidence and rejects high-risk bankers", () => {
    const prediction = predictFixture(baseFixture, [{
      fixtureId: baseFixture.id,
      date: baseFixture.date,
      europeanOdds: { current: { home: 1.05, draw: 12, away: 21 } },
      asianHandicap: { current: { line: -2, homeWater: 0.9, awayWater: 0.9 } }
    }]);
    assert.ok(prediction.confidence <= 100);

    const audit = auditRecommendations({
      predictions: [prediction],
      fourteen: { count: 1, selections: [{ index: 1, match: "主队 对 客队", type: "胆", risk: "高" }] }
    });
    assert.equal(audit.ok, false);
    assert.match(audit.errors.at(-1).message, /高风险场次禁止定胆/);
  });

  it("uses fixture-level Elo and form as bounded probability adjustments", () => {
    const advancedData = {
      fixtures: [{
        fixtureId: baseFixture.id,
        data: {
          elo: {
            home: { Elo: "2050" },
            away: { Elo: "1700" }
          },
          form: {
            home: { matches: 8, pointsPerMatch: 2.25, goalDiff: 8 },
            away: { matches: 8, pointsPerMatch: 0.5, goalDiff: -8 }
          }
        }
      }]
    };
    const prediction = predictFixture(baseFixture, [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 2.05, draw: 3.2, away: 3.4 } } }], 0, { advancedData });

    assert.equal(prediction.probabilityAdjustment.applied, true);
    assert.ok(prediction.probabilityAdjustment.signals.some((signal) => signal.key === "elo"));
    // 调整层(Elo/form)应抬高 home;最终概率之后还会过融合+温度校准(回测拟合 T 软化过度自信),
    // 故方向性断言落在 adjustment 层,而非已被软化的最终 probabilities。
    assert.ok(prediction.probabilityAdjustment.probabilities.home > prediction.baseProbabilities.home);
    assert.ok(prediction.probabilityAdjustment.maxShift <= 0.1);
    assert.equal(prediction.simulation.iterations, 20000);
    assert.ok(prediction.simulation.topScores.length > 0);
  });

  it("applies historical calibration without changing probability normalization", () => {
    const calibrationProfile = {
      usable: true,
      source: "test-profile",
      minSamples: 10,
      minBucketSamples: 5,
      maxShift: 0.05,
      global: { samples: 30, predictedHitRate: 0.62, actualHitRate: 0.54, adjustment: -0.04 },
      buckets: {
        "55-65": { samples: 12, predictedHitRate: 0.61, actualHitRate: 0.52, adjustment: -0.045 }
      }
    };
    const prediction = predictFixture(
      baseFixture,
      [{ fixtureId: baseFixture.id, date: baseFixture.date, europeanOdds: { current: { home: 1.7, draw: 3.6, away: 5.2 } } }],
      0,
      { calibrationProfile }
    );
    const total = prediction.probabilities.home + prediction.probabilities.draw + prediction.probabilities.away;

    assert.equal(prediction.probabilityAdjustment.calibration.applied, true);
    assert.ok(prediction.probabilities.home < prediction.baseProbabilities.home);
    assert.ok(Math.abs(total - 1) < 0.0001);
  });
});
