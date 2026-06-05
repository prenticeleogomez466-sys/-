import test from "node:test";
import assert from "node:assert/strict";
import { isWeakLeague } from "../src/league-reliability.js";

test("isWeakLeague:仅可靠且命中<阈值才判弱;未知/样本不足/强联赛不判弱", () => {
  const prof = {
    weakThreshold: 0.42,
    leagues: {
      "阿甲": { accuracy: 0.37, total: 56, hit: 21, reliable: true },   // 可靠且弱 → true
      "墨超": { accuracy: 0.38, total: 39, hit: 15, reliable: true },   // 可靠且弱 → true
      "英超": { accuracy: 0.55, total: 80, hit: 44, reliable: true },   // 可靠但不弱 → false
      "某杯赛": { accuracy: 0.20, total: 2, hit: 0, reliable: false },  // 样本不足 → false(不臆断)
      "高命中小样本": { accuracy: 1.0, total: 3, hit: 3, reliable: false } // 不足 → false
    }
  };
  assert.equal(isWeakLeague("阿甲", prof), true);
  assert.equal(isWeakLeague("墨超", prof), true);
  assert.equal(isWeakLeague("英超", prof), false);
  assert.equal(isWeakLeague("某杯赛", prof), false);
  assert.equal(isWeakLeague("高命中小样本", prof), false);
  assert.equal(isWeakLeague("不存在的联赛", prof), false);
  assert.equal(isWeakLeague(null, prof), false);
  assert.equal(isWeakLeague("阿甲", null), false);     // 无 profile → 不臆断
  assert.equal(isWeakLeague("阿甲", { leagues: null }), false);
});

test("isWeakLeague:按 canonicalLeague 归一查,变体名也命中弱联赛(防样本割裂逃逸)", () => {
  const prof = {
    weakThreshold: 0.42,
    leagues: {
      // profile 以 canonical 键写入(沙特联/芬超),变体输入须归一后命中。
      "沙特联": { accuracy: 0.38, total: 41, hit: 16, reliable: true },
      "芬超": { accuracy: 0.40, total: 24, hit: 10, reliable: true },
    }
  };
  assert.equal(isWeakLeague("沙特联", prof), true);
  assert.equal(isWeakLeague("沙职", prof), true);            // 变体 → 归一沙特联
  assert.equal(isWeakLeague("芬超", prof), true);
  assert.equal(isWeakLeague("芬兰超级联赛", prof), true);     // 变体 → 归一芬超
});
