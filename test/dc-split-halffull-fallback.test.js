import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simpleWldCell, simpleHalfFullCell } from "../src/daily-report.js";
import { computeDoubleChance } from "../src/prediction-engine.js";

// ============================================================================
// consistency-engine-3(2026-06-11 审计):双选前缀可不含主推方向
//   computeDoubleChance 按市场隐含舍最低项 → 市场与模型 argmax 分歧时 dc.codes
//   可恰好排除 pick.code,旧 simpleWldCell 显式放行不含主推的前缀,输出
//   "双选主胜/平局(1X) 主选 客胜(37%)" 自相矛盾(双选覆盖的两项排除了主选方向),
//   且前缀首方向词"主胜"污染 threeColumnCoherence 的 dirWld 判向。
//   修后:dc.codes 不含 pick.code 时不打方向词前缀,改打显式分歧标注
//   (⚠️+shortCode,不含任何胜平负方向词),主选段仍为格内第一个方向词。
// ============================================================================
describe("双选与主推分裂显示闸(consistency-engine-3)", () => {
  // 模型 ranked: 客0.37 > 主0.34 > 平0.29;市场: 主0.45 > 平0.30 > 客0.25
  //   → 市场舍最低=客胜 → dc.codes=['3','1'] 恰好排除模型主推(客胜)。
  function makeSplitPrediction() {
    const dc = computeDoubleChance(
      [{ code: "0", probability: 0.37 }, { code: "3", probability: 0.34 }, { code: "1", probability: 0.29 }],
      { home: 0.45, draw: 0.30, away: 0.25 }
    );
    return {
      dc,
      prediction: {
        pick: { code: "0", label: "客胜" },
        probabilities: { home: 0.34, draw: 0.29, away: 0.37 },
        doubleChance: dc,
      },
    };
  }

  it("钉死前提:市场/模型分歧场 dc.codes 确实排除模型主推(可达边界)", () => {
    const { dc } = makeSplitPrediction();
    assert.equal(dc.recommended, true);
    assert.deepEqual(dc.codes, ["3", "1"]);
    assert.equal(dc.codes.includes("0"), false, "dc.codes 应排除模型主推客胜=分裂前提");
  });

  it("分裂场不再输出'双选主胜/平局…主选 客胜'自相矛盾前缀", () => {
    const { prediction } = makeSplitPrediction();
    const cell = simpleWldCell(prediction);
    assert.doesNotMatch(cell, /双选(主胜|平局|客胜)/, `分裂场不应打"双选+方向词"前缀冒充覆盖主推,实得 ${cell}`);
    // 格内第一个方向词必须=主选方向(客胜),前缀不得抢方向锚(dirWld 取最左方向词)
    const firstDir = String(cell).match(/(主胜|客胜|平局)/)?.[1];
    assert.equal(firstDir, "客胜", `格内首方向词应=主选客胜,实得 ${cell}`);
    assert.match(cell, /⚠️/, `分裂须显式标注(不静默吞掉信息),实得 ${cell}`);
    assert.match(cell, /分歧/, `应注明模型主推与市场双选分歧,实得 ${cell}`);
    assert.match(cell, /1X/, `应保留市场双选 shortCode(1X)供用户自判,实得 ${cell}`);
    assert.match(cell, /主选 客胜\(37%\)/, "主选段保持完整");
  });

  it("非分裂场(dc.codes 含主推)行为不变:双选前缀保留且主推排首", () => {
    // 模型与市场同向:主0.45 → dc 舍客胜,codes=['3','1'] 含主推'3'
    const dc = computeDoubleChance(
      [{ code: "3", probability: 0.45 }, { code: "1", probability: 0.30 }, { code: "0", probability: 0.25 }],
      { home: 0.45, draw: 0.30, away: 0.25 }
    );
    const cell = simpleWldCell({
      pick: { code: "3", label: "主胜" },
      probabilities: { home: 0.45, draw: 0.30, away: 0.25 },
      doubleChance: dc,
    });
    assert.match(cell, /^双选主胜\/平局\(1X\)/, `同向场前缀照常且主推排首,实得 ${cell}`);
    assert.doesNotMatch(cell, /分歧/);
  });
});

// ============================================================================
// consistency-engine-4(2026-06-11 审计):simpleHalfFullCell 可把 wld 锚首选整个丢掉
//   primary 不在展示分布、且分布无 ft1 向条目时,旧逻辑 main=[]、all=[次选向top1]
//   非空即返回 → 首选被静默丢弃,半全场格方向≠胜负平且无标注。
//   simpleScoreCell 同形逻辑有 wldConsistent 兜底,本修与之对齐:
//   main 为空时把 hp.primary(带 primaryProbability)强制排首再接次选。
// ============================================================================
describe("半全场首选兜底·primary 永不静默丢失(consistency-engine-4)", () => {
  function makeOrphanPrimary() {
    return {
      pick: { code: "3", label: "主胜" },
      probabilities: { home: 0.45, draw: 0.30, away: 0.25 },
      scorePicks: {
        marketDistribution: [{ score: "0-1", probability: 0.15 }],
        wldConsistent: "1-0", primary: "1-0",
      },
      halfFullPicks: {
        primary: "主胜-主胜", primaryProbability: 0.4,
        marketDistribution: [
          { halfFull: "客胜-客胜", probability: 0.2 },
          { halfFull: "平局-平局", probability: 0.15 },
        ],
      },
    };
  }

  it("primary 不在分布且分布无主选向条目 → primary 强制排首,方向=胜负平主选", () => {
    const p = makeOrphanPrimary();
    const hf = simpleHalfFullCell(p);
    assert.match(hf, /^主胜-主胜\(40%\)/, `首选 primary 必须排首(带概率),实得 ${hf}`);
    const firstDir = String(hf).match(/(主胜|客胜|平局)/)?.[1];
    assert.equal(firstDir, "主胜", `半全场格首方向必须=胜负平主选(主胜),实得 ${hf}`);
    // 次选(平局)向 top1 仍可跟随(两方向锚),但第三方向(客胜)绝不出现
    assert.doesNotMatch(hf, /客胜-客胜/, `第三方向(客胜)绝不出现,实得 ${hf}`);
  });

  it("对照:simpleScoreCell 同场景已有 wldConsistent 兜底(回归保持)", async () => {
    const { simpleScoreCell } = await import("../src/daily-report.js");
    const p = makeOrphanPrimary();
    assert.equal(simpleScoreCell(p), "1-0");
  });

  it("primaryProbability 缺失时兜底仍生效(无%但 primary 在首)", () => {
    const p = makeOrphanPrimary();
    delete p.halfFullPicks.primaryProbability;
    const hf = simpleHalfFullCell(p);
    assert.match(hf, /^主胜-主胜/, `无概率也须 primary 排首,实得 ${hf}`);
  });

  it("回归:分布含主选向条目时行为不变(primary 排首+同向次选)", () => {
    const p = makeOrphanPrimary();
    p.halfFullPicks.marketDistribution = [
      { halfFull: "主胜-主胜", probability: 0.45 },
      { halfFull: "平局-主胜", probability: 0.22 },
      { halfFull: "平局-平局", probability: 0.1 },
      { halfFull: "客胜-客胜", probability: 0.05 },
    ];
    p.halfFullPicks.primaryProbability = 0.45;
    const hf = simpleHalfFullCell(p);
    assert.match(hf, /^主胜-主胜\(45%\)/);
    assert.match(hf, /平局-主胜/);
    assert.doesNotMatch(hf, /客胜-客胜/);
  });
});
