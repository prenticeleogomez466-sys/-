import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildModelMemory, buildModelMemoryFromLedger, recallSegmentPerformance, favoriteTierFromProbs, confidenceBand } from "../src/model-memory.js";

function row(over = {}) {
  return {
    competition: "英超", probabilityHome: 0.72, probabilityDraw: 0.18, probabilityAway: 0.1, confidence: 70,
    hit: true, actual: "主胜",
    scoreHit: false, actualScore: "2-1",
    halfFullHit: true, actualHalfFull: "主胜-主胜",
    handicapWldHit: true, actualHandicapCode: "3",
    ...over,
  };
}

describe("永久记忆 model-memory", () => {
  it("favoriteTierFromProbs / confidenceBand 分档正确", () => {
    assert.equal(favoriteTierFromProbs({ home: 0.72, draw: 0.18, away: 0.1 }), "超级大热");
    assert.equal(favoriteTierFromProbs({ home: 0.4, draw: 0.33, away: 0.27 }), "势均");
    assert.equal(confidenceBand(80), "极高(≥75)");
    assert.equal(confidenceBand(40), "低(<55)");
  });

  it("buildModelMemory 只数已结算行,按联赛/热门档/信心带 digest", () => {
    const ledger = [row(), row({ hit: false, actual: "平局" }), { competition: "X", hit: null }];
    const m = buildModelMemory(ledger);
    assert.equal(m.settledTotal, 2, "未结算行(hit 非 boolean)不计");
    assert.equal(m.global.n, 2);
    assert.equal(m.global.wldHit, 0.5, "2 场 1 中 = 50%");
    assert.ok(m.byLeague["英超"]);
    assert.equal(m.byFavoriteTier["超级大热"].n, 2);
    assert.equal(m.byConfidenceBand["高(65-75)"].n, 2);
  });

  it("诚实账本:无真实赛果的玩法不计(防假 0%)", () => {
    // 两行都没有 actualHalfFull(空串)→ 半全场不应计为命中也不计为失败
    const ledger = [row({ actualHalfFull: "" }), row({ actualHalfFull: "  " })];
    const m = buildModelMemory(ledger);
    assert.equal(m.global.halfFullN, 0, "无 HT 数据 → 半全场 n=0(不误记 0%)");
    assert.equal(m.global.halfFullHit, null);
    assert.equal(m.global.wldN, 2, "胜平负有 actual → 正常计");
  });

  it("recallSegmentPerformance:样本足→给读数,不足→标 insufficient 不外推", () => {
    const many = Array.from({ length: 12 }, (_, i) => row({ hit: i % 2 === 0 }));
    const m = buildModelMemory(many);
    const r = recallSegmentPerformance(m, { competition: "英超", probabilities: { home: 0.72, draw: 0.18, away: 0.1 }, confidence: 70 }, { minN: 10 });
    assert.equal(r.leagueSufficient, true);
    assert.match(r.note, /英超本类胜平负命中/);
    // 不同联赛(无样本)→ league null / insufficient,但有 overall 兜底读数
    const r2 = recallSegmentPerformance(m, { competition: "火星联", probabilities: { home: 0.5, draw: 0.3, away: 0.2 } }, { minN: 10 });
    assert.equal(r2.leagueSufficient, false);
    assert.ok(r2.note.length > 0);
  });

  it("无记忆/空输入安全降级", () => {
    assert.equal(recallSegmentPerformance(null, {}), null);
    const m = buildModelMemory([]);
    assert.equal(m.settledTotal, 0);
    assert.equal(m.global.wldHit, null);
  });
});

// ── 2026-06-21 接线:buildModelMemoryFromLedger 实时 digest(此前无代码写 model-memory.json→标注静默失效) ──
describe("model-memory 实时 ledger 接线(2026-06-21)", () => {
  it("buildModelMemoryFromLedger:从对象结构 ledger 实时 digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "mmem-"));
    try {
      // ledger 真实结构=对象({0:row,...})
      const obj = {};
      for (let i = 0; i < 8; i++) obj[i] = row({ hit: i % 2 === 0, competition: "世界杯" });
      const p = join(dir, "recommendation-ledger.json");
      writeFileSync(p, JSON.stringify(obj));
      const m = buildModelMemoryFromLedger({ path: p });
      assert.equal(m.settledTotal, 8);
      assert.ok(m.byLeague["世界杯"]);
      assert.equal(m.byLeague["世界杯"].n, 8);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("buildModelMemoryFromLedger:缺文件/零结算 → null(优雅降级,绝不兜底)", () => {
    assert.equal(buildModelMemoryFromLedger({ path: join(tmpdir(), "no-ledger-xyz.json") }), null);
    const dir = mkdtempSync(join(tmpdir(), "mmem2-"));
    try {
      const p = join(dir, "recommendation-ledger.json");
      writeFileSync(p, JSON.stringify({ 0: { competition: "X", hit: null } })); // 无已结算
      assert.equal(buildModelMemoryFromLedger({ path: p }), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("接线守护:recommendFixtures 用 buildModelMemoryFromLedger 兜住缺 model-memory.json(防标注再死)", () => {
    const enginePath = fileURLToPath(new URL("../src/prediction-engine.js", import.meta.url));
    const src = readFileSync(enginePath, "utf8");
    assert.match(src, /buildModelMemoryFromLedger/, "须 import+调用 buildModelMemoryFromLedger");
    assert.match(src, /loadModelMemory\(\)\s*\?\?\s*buildModelMemoryFromLedger\(/, "缺持久档时须实时 digest 兜底");
  });
});
