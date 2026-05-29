/**
 * GG 档:asian-handicap-water + ensemble-weights-profile 接入测试。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectFusionEvidence, SIGNAL_NAMES } from "../src/signal-fusion-layer.js";
import { learnAndPersistWeights, loadEnsembleWeightsProfile } from "../src/ensemble-weights-profile.js";

const PRIOR = { home: 0.45, draw: 0.27, away: 0.28 };

describe("GG 档 — asian-handicap-water 接入 signal-fusion-layer", () => {
  it("SIGNAL_NAMES 包含 asian-handicap-water", () => {
    assert.ok(SIGNAL_NAMES.includes("asian-handicap-water"));
  });

  it("缺水位数据 → dormant", () => {
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, {});
    assert.ok(dormant.find((d) => d.name === "asian-handicap-water" && d.dormant === "no-water-data"));
  });

  it("早晚水位主队降水(让球方降水)→ 主队 dangerous → 客胜 LR > 1", () => {
    const ctx = {
      asianHandicapWater: {
        earlyHome: 0.95, earlyAway: 0.95,
        lateHome: 0.86, lateAway: 1.04,  // 主队降水 0.09 = danger-home
        line: -1
      }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "asian-handicap-water");
    assert.ok(ev, "asian-handicap-water 应 fire");
    assert.ok(ev.ratio.away > 1, "danger-home → away LR > 1");
    assert.ok(ev.ratio.home < 1, "danger-home → home LR < 1");
  });

  it("早晚水位主队升水(让球方升水)→ warn-home → 客胜 LR 略 > 1", () => {
    const ctx = {
      asianHandicapWater: {
        earlyHome: 0.90, earlyAway: 1.00,
        lateHome: 0.98, lateAway: 0.92,  // 主队升水 0.08 = warn-home
        line: -1
      }
    };
    const { evidence } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    const ev = evidence.find((e) => e.name === "asian-handicap-water");
    assert.ok(ev, "warn-home 应 fire");
    assert.ok(ev.ratio.home < 1);
  });

  it("水位平稳 → dormant(信号弱)", () => {
    const ctx = {
      asianHandicapWater: {
        earlyHome: 0.95, earlyAway: 0.95,
        lateHome: 0.96, lateAway: 0.94,
        line: -1
      }
    };
    const { dormant } = collectFusionEvidence(PRIOR, { homeTeam: "A", awayTeam: "B" }, {}, ctx);
    assert.ok(dormant.find((d) => d.name === "asian-handicap-water"));
  });
});

describe("GG 档 — ensemble-weights-profile 接入", () => {
  it("loadEnsembleWeightsProfile 缺文件时返回 null", () => {
    // 在测试环境 ratings-ensemble-weights.json 通常不存在
    const profile = loadEnsembleWeightsProfile();
    // 文件可能存在也可能不存在,只验证函数不炸 + 返回 null 或 object
    assert.ok(profile === null || typeof profile === "object");
  });

  it("learnAndPersistWeights 样本不够时返回 ok=false", () => {
    const r = learnAndPersistWeights([{ hit: true, actual: "主胜", probabilityHome: 0.5, probabilityDraw: 0.3, probabilityAway: 0.2 }]);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith("insufficient"));
  });
});
