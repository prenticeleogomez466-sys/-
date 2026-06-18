import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { riskScore, RISK_CONST } from "../src/risk-score.js";

// 连续风险分守护(2026-06-18 工作流A)。OOS 回测裁决:风险分=市场隐含"pick不中"概率,
// 因子只标注不计入分数。下列用例锁死该口径,防回归成"多因子堆叠"(已证 Brier 更差)。
describe("连续风险分 risk-score(核心分=市场隐含不中·因子=透明标注)", () => {
  const market = { home: 0.62, draw: 0.24, away: 0.14 };

  it("缺市场隐含 → 返回 null(诚实不编造)", () => {
    assert.equal(riskScore({ pick: "home", marketProbs: null }), null);
    assert.equal(riskScore({ pick: "home", marketProbs: { home: 0.6 } }), null);
  });

  it("核心分 = 1 − 市场devig(pick)·与因子无关", () => {
    const r = riskScore({ pick: "home", marketProbs: market });
    assert.equal(r.score, 38);                 // 1-0.62=0.38
    assert.equal(r.band, "中");                 // 30-50
    assert.equal(r.lossProb, 0.38);
  });

  it("强热门押热门 → 低风险分", () => {
    const r = riskScore({ pick: "home", marketProbs: { home: 0.78, draw: 0.14, away: 0.08 } });
    assert.equal(r.score, 22);
    assert.equal(r.band, "低");
  });

  it("双选(数组) → 风险=两选项都不中", () => {
    const r = riskScore({ pick: ["home", "draw"], marketProbs: market });
    assert.equal(r.score, 14);                 // 1-(0.62+0.24)=0.14
    assert.equal(r.band, "低");
  });

  it("逆市(押市场冷门方向) → 高风险驱动标注 + 分数随市场", () => {
    const r = riskScore({ pick: "away", marketProbs: market });
    assert.equal(r.score, 86);                 // 1-0.14
    assert.ok(r.drivers.some((d) => d.tag === "逆市" && d.severity === "高"));
  });

  it("平局陷阱:平局隐含≥30% 且 pick 非平 → 标注(不改分数)", () => {
    const mk = { home: 0.45, draw: 0.32, away: 0.23 };
    const r = riskScore({ pick: "home", marketProbs: mk });
    assert.equal(r.score, 55);                 // 分数仍只来自市场: 1-0.45
    assert.ok(r.drivers.some((d) => d.tag === "平局陷阱"));
    // 押平局本身 → 无平局陷阱标注
    const r2 = riskScore({ pick: "draw", marketProbs: mk });
    assert.ok(!r2.drivers.some((d) => d.tag === "平局陷阱"));
  });

  it("因子绝不计入分数:同一 pick 加任何因子分数不变(防双重计数回归)", () => {
    const base = riskScore({ pick: "home", marketProbs: market }).score;
    const withFactors = riskScore({
      pick: "home", marketProbs: market, drawImplied: 0.4,
      ahLineAbs: 0.5, over25: 0.4, softLeague: true, favImplied: 0.62,
    }).score;
    assert.equal(base, withFactors);           // 市场 pickProb 不变 → 分数不变
  });

  it("band 阈值与实测校准一致(<30低/30-50中/≥50高)", () => {
    assert.equal(RISK_CONST.BAND_LOW, 30);
    assert.equal(RISK_CONST.BAND_HIGH, 50);
    assert.equal(riskScore({ pick: "home", marketProbs: { home: 0.71, draw: 0.18, away: 0.11 } }).band, "低"); // 29
    assert.equal(riskScore({ pick: "home", marketProbs: { home: 0.5, draw: 0.27, away: 0.23 } }).band, "高");  // 50
  });
});
