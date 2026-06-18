import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSoftLeague, honestPass } from "../src/honest-pass-gate.js";

// soft-league 判定集中化守护(2026-06-18 工作流②)。
// 关键:国家队/友谊/热身 命中;但俱乐部资格赛(欧冠资格赛等)绝不被误伤为 soft。
describe("isSoftLeague 集中判定(谨慎扩词·不误伤俱乐部赛)", () => {
  it("国家队/友谊/热身/邀请赛 → true", () => {
    for (const c of ["国际友谊赛", "国家队友谊", "友賽", "热身赛", "熱身賽", "邀请赛", "International Friendly", "UEFA Nations League", "Exhibition"]) {
      assert.equal(isSoftLeague(c), true, c);
    }
  });
  it("俱乐部联赛/杯赛/资格赛 → false(不误伤)", () => {
    for (const c of ["英超", "西甲", "欧冠资格赛", "欧冠预选赛", "意甲", "Premier League", "Champions League Qualifying", "足总杯"]) {
      assert.equal(isSoftLeague(c), false, c);
    }
  });
  it("非字符串 → false(安全)", () => {
    assert.equal(isSoftLeague(null), false);
    assert.equal(isSoftLeague(undefined), false);
    assert.equal(isSoftLeague(123), false);
  });
  it("honestPass 用集中判定:友谊赛单选触发 soft 硬伤", () => {
    const r = honestPass({ prob: 0.6, ev: 0.05, risk: "低", competition: "国际友谊赛", aligned: true, divergencePp: 2 });
    assert.ok(r.failReasons.some((x) => /soft-international/.test(x)));
  });
});
