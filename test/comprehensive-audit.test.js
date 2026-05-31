import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recommendFixtures } from "../src/prediction-engine.js";
import { runComprehensiveAudit, comprehensiveAuditRows } from "../src/comprehensive-audit.js";

describe("全面审计总闸门(comprehensive-audit)", () => {
  it("健康推荐集:0 硬 blocker、0 造假、方向一致 → 允许出表", () => {
    const recs = recommendFixtures("2026-05-15");
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: recs, runModuleAudits: false });
    assert.equal(a.ok, true, `不应有硬 blocker:${a.blockers.join("；")}`);
    assert.equal(a.integrity.fabricated, 0, "进推荐场不得有 provenance 造假");
    assert.ok(a.integrity.total > 0);
    // 进推荐的每场 provenance 必须是真实先验,roll-up 里不含"造假/缺失"分桶。
    assert.ok(!a.integrity.provenanceDist["造假/缺失"]);
  });

  it("混入无真实先验(provenance=data-missing)的场 → 真实性 blocker 拦出表", () => {
    const recs = recommendFixtures("2026-05-15");
    // 克隆一条真实预测,把来源篡改成 data-missing 模拟造假泄漏进推荐。
    const real = recs.predictions[0];
    const faked = { ...real, provenance: "data-missing", unpredictable: true };
    const tampered = { ...recs, predictions: [...recs.predictions, faked] };
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: tampered, runModuleAudits: false });
    assert.equal(a.ok, false, "造假泄漏必须被拦");
    assert.ok(a.integrity.fabricated >= 1, "真实性 roll-up 应数出造假场");
    assert.ok(a.blockers.some((b) => /真实性|造假|provenance/i.test(b)), `blocker 应含真实性项:${a.blockers.join("；")}`);
  });

  it("逐玩法核验 roll-up:显式覆盖 胜负平/让球/比分/半全场 且健康集全通过", () => {
    const recs = recommendFixtures("2026-05-15");
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: recs, runModuleAudits: false });
    assert.ok(a.playtypes, "审计结果应含 playtypes 逐玩法汇总");
    const labels = a.playtypes.items.map((i) => i.label);
    assert.deepEqual(labels, ["胜负平", "让球", "比分", "半全场"], "必须覆盖四大玩法");
    assert.equal(a.playtypes.allPass, true, `健康集每玩法应全过:${JSON.stringify(a.playtypes.items)}`);
    // 审计分项 section 里能一眼看到逐玩法核验
    assert.ok(a.sections.some((s) => s.name === "逐玩法核验" && s.status === "✓"));
  });

  it("comprehensiveAuditRows 产出可写 xlsx 的报告行,含分项与裁决", () => {
    const recs = recommendFixtures("2026-05-15");
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: recs, runModuleAudits: false });
    const rows = comprehensiveAuditRows(a);
    assert.ok(Array.isArray(rows) && rows.length > 1);
    assert.match(String(rows[0][1]), /通过|拦截/);
  });

  it("⑨ 爆冷/诱盘核验 roll-up:健康集出现该分项且不拦出表", () => {
    const recs = recommendFixtures("2026-05-15");
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: recs, runModuleAudits: false });
    assert.ok(a.upsetTrap, "审计结果应含 upsetTrap 汇总");
    assert.ok(a.sections.some((s) => s.name === "爆冷/诱盘核验"), "分项应含爆冷/诱盘核验");
    assert.ok(a.upsetTrap.analyzed >= 0);
    assert.equal(a.upsetTrap.malformed.length, 0, "健康集不应有畸形 upsetTrap");
    // 高爆冷/诱盘是提示(warning),不应进硬 blocker
    assert.ok(!a.blockers.some((b) => /爆冷提示/.test(b)));
  });

  it("upsetTrap 字段畸形(概率越界)→ 真实性 blocker 拦出表", () => {
    const recs = recommendFixtures("2026-05-15");
    const real = recs.predictions.find((p) => p.upsetTrap) ?? recs.predictions[0];
    const faked = { ...real, upsetTrap: { ...(real.upsetTrap ?? {}), upsetRisk: 1.8, favoriteImplied: 0.6, reason: "x", upsetLevel: "中", trapVerdict: "中性" } };
    const tampered = { ...recs, predictions: [...recs.predictions, faked] };
    const a = runComprehensiveAudit({ date: "2026-05-15", recommendations: tampered, runModuleAudits: false });
    assert.equal(a.ok, false, "畸形 upsetTrap 必须被拦");
    assert.ok(a.blockers.some((b) => /爆冷\/诱盘/.test(b)), `blocker 应含爆冷/诱盘畸形项:${a.blockers.join("；")}`);
  });
});
