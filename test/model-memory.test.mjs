import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelMemory, recallSegmentPerformance, favoriteTierFromProbs, confidenceBand } from "../src/model-memory.js";

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
