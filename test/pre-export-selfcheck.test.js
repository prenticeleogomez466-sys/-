/**
 * 出表前自检闸门测试(用户硬规则 2026-05-30):
 * 自检必须能拦下 ① 比分进球数失真(如 8-0)② 让球方向不以 wld 为锚 ③ 比分/半全场方向冲突
 * ④ 场次不全 ⑤ 非真模型(seeded 兜底);并放行各玩法齐全、方向一致、真模型跑出的正常数据。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPreExportSelfCheck } from "../src/pre-export-selfcheck.js";

// 一条字段齐全、方向一致、DC 真跑的合格预测
function goodPrediction(overrides = {}) {
  return {
    fixture: { sequence: 1, homeTeam: "甲", awayTeam: "乙", marketType: "shengfucai" },
    pick: { code: "3", label: "主胜" },
    secondaryPick: { code: "1", label: "平局" },
    probabilities: { home: 0.55, draw: 0.27, away: 0.18 },
    scorePicks: { primary: "2-0", secondary: "1-1" },
    halfFullPicks: { primary: "主胜-主胜", secondary: "平局-平局" },
    handicapPick: { line: -1, direction: "主胜", anchor: "wld" },
    dixonColes: { source: "dixon-coles", expectedGoals: { home: 1.8, away: 0.6 } },
    probabilityAdjustment: { fusion: { fired: ["season-phase"], dormant: [] } },
    marketSnapshot: {},
    ...overrides,
  };
}

function pkg(predictions, fourteen = { available: false }) {
  return { fixtures: predictions.length, predictions, fourteen };
}

describe("出表自检闸门", () => {
  it("全玩法齐全 + 方向一致 + DC 真跑 → 通过", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction()]));
    assert.equal(sc.verdict, "pass");
    assert.equal(sc.ok, true);
    assert.equal(sc.blockers.length, 0);
    assert.equal(sc.summary.dcRan, 1);
  });

  it("比分进球数失真(8-0)→ 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ scorePicks: { primary: "8-0", secondary: "1-1" } })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("进球数异常")), sc.blockers.join("；"));
  });

  it("让球方向不以 wld 为锚 → 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ handicapPick: { line: -1, direction: "客胜" } })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("让球方向")), sc.blockers.join("；"));
  });

  it("比分方向与 wld 冲突(主胜却给客胜比分)→ 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ scorePicks: { primary: "0-2", secondary: "1-1" } })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("比分") && b.includes("冲突")), sc.blockers.join("；"));
  });

  it("半全场全场方向与 wld 冲突 → 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ halfFullPicks: { primary: "平局-客胜", secondary: "平局-平局" } })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("半全场")), sc.blockers.join("；"));
  });

  it("场次数不一致(fixtures≠predictions)→ 拦截", () => {
    const p = pkg([goodPrediction()]);
    p.fixtures = 5;
    const sc = runPreExportSelfCheck(p);
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("场次数不一致")), sc.blockers.join("；"));
  });

  it("非真模型(seeded 兜底)→ 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ dixonColes: { source: "seeded-fallback" } })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("非真模型")), sc.blockers.join("；"));
  });

  it("DC 未覆盖纯赔率 → 不拦截但 warning 标注", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ dixonColes: null })]));
    assert.equal(sc.verdict, "pass");
    assert.equal(sc.summary.oddsOnly, 1);
    assert.ok(sc.warnings.some((w) => w.includes("DC 未覆盖")), sc.warnings.join("；"));
  });

  it("竞彩缺实时快照 → 拦截", () => {
    const sc = runPreExportSelfCheck(pkg([goodPrediction({ fixture: { sequence: 1, homeTeam: "甲", awayTeam: "乙", marketType: "jingcai" }, marketSnapshot: null })]));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("实时赔率快照")), sc.blockers.join("；"));
  });

  it("14场不满14 → 拦截", () => {
    const fourteen = {
      available: true,
      selections: [{ index: 1, match: "甲 对 乙", single: "主胜", compound: "主胜", type: "胆", risk: "中" }],
      renxuan9: { ok: true, picks: new Array(9).fill({ pick: "主胜" }) },
    };
    const sc = runPreExportSelfCheck(pkg([goodPrediction()], fourteen));
    assert.equal(sc.verdict, "blocked");
    assert.ok(sc.blockers.some((b) => b.includes("14场场次不全")), sc.blockers.join("；"));
  });
});
