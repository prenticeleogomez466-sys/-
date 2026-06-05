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
