// WC 逐场模型核心正向单测(2026-06-15 补:此前仅 1 个反向毒用例,核心计算零正向覆盖)。
// 断言基于真实 Elo 先验的实测输出(非构造桩),覆盖 Elo→λ / argmax锚 / 洲际校正 / λ物理范围 / 防御。
import { test } from "node:test";
import assert from "node:assert/strict";
import { predictWcMatch } from "../src/wc-match-model.js";

test("Elo→λ:高 Elo 队 λ 更高(supremacy 方向正确)", () => {
  const r = predictWcMatch("西班牙", "南非", {});
  assert.ok(!r.error, r.error);
  assert.ok(r.elo.home > r.elo.away, "西班牙 Elo 应高于南非");
  assert.ok(r.lambda.home > r.lambda.away, `强队 λ 应更高: ${r.lambda.home} vs ${r.lambda.away}`);
});

test("Elo→λ:Elo 差越大 λ 差越大(单调)", () => {
  const big = predictWcMatch("西班牙", "南非", {});   // diff ~726
  const small = predictWcMatch("日本", "韩国", {});     // diff ~120
  assert.ok(!big.error && !small.error);
  const gapBig = big.lambda.home - big.lambda.away;
  const gapSmall = small.lambda.home - small.lambda.away;
  assert.ok(gapBig > gapSmall, `λ 差应随 Elo 差扩大: ${gapBig} vs ${gapSmall}`);
});

test("argmax 锚:pickProb 等于 wld 三项最大值(单选锚一致)", () => {
  const r = predictWcMatch("法国", "日本", {});
  assert.ok(!r.error);
  const { home, draw, away } = r.wld.probabilities;
  assert.equal(r.wld.pickProb, Math.max(home, draw, away));
  // pick=3 对应主胜,且必须是最大项
  assert.equal(r.wld.pickCode, "3");
});

test("wld 概率归一(和≈1)", () => {
  const r = predictWcMatch("西班牙", "南非", {});
  const { home, draw, away } = r.wld.probabilities;
  assert.ok(Math.abs(home + draw + away - 1) < 0.01, `和=${home + draw + away}`);
});

test("洲际校正:同洲 confedAdj=0", () => {
  const r = predictWcMatch("日本", "韩国", {}); // AFC vs AFC
  assert.equal(r.confed.home, r.confed.away);
  assert.equal(r.confed.adj, 0);
});

test("洲际校正:跨洲 confedAdj≠0", () => {
  const r = predictWcMatch("法国", "日本", {}); // UEFA vs AFC
  assert.notEqual(r.confed.home, r.confed.away);
  assert.notEqual(r.confed.adj, 0);
  assert.ok(Number.isFinite(r.confed.adj));
});

test("λ 物理范围:0 < λ < 4.0(side block 内,不输出失真 λ)", () => {
  for (const [h, a] of [["西班牙", "南非"], ["日本", "韩国"], ["法国", "日本"], ["巴西", "库拉索"]]) {
    const r = predictWcMatch(h, a, {});
    assert.ok(!r.error, r.error);
    for (const k of ["home", "away"]) {
      assert.ok(r.lambdas[k] > 0 && r.lambdas[k] < 4.0, `${h} vs ${a} λ.${k}=${r.lambdas[k]} 越界`);
    }
  }
});

test("防御:缺 Elo 先验 → 返回 error,不崩不兜底", () => {
  const r = predictWcMatch("阿根廷", "冰岛", {}); // 冰岛无 Elo 先验
  assert.ok(r.error, "应返回 error");
  assert.match(r.error, /缺 Elo/);
});
