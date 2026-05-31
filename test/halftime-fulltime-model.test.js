import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { halfFullJoint, fitHalfFullParams, HF_CLASSES, HF_DEFAULTS } from "../src/halftime-fulltime-model.js";

const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
const htDraw = (o) => o["平局-主胜"] + o["平局-平局"] + o["平局-客胜"];
const ftHome = (o) => o["主胜-主胜"] + o["平局-主胜"] + o["客胜-主胜"];

describe("半全场联合分布升级模型", () => {
  it("输出 9 类且归一", () => {
    const p = halfFullJoint(1.6, 1.1);
    assert.equal(Object.keys(p).length, 9);
    for (const c of HF_CLASSES) assert.ok(p[c] >= 0, `${c} 非负`);
    assert.ok(Math.abs(sum(p) - 1) < 1e-9, "概率和=1");
  });

  it("强主队:FT 主胜边际最大,且半全场主-主 是最高单类", () => {
    const p = halfFullJoint(2.2, 0.7);
    assert.ok(ftHome(p) > 0.6, "FT 主胜边际应高");
    const top = HF_CLASSES.reduce((b, c) => (p[c] > p[b] ? c : b), HF_CLASSES[0]);
    assert.equal(top, "主胜-主胜");
  });

  it("低进球均势:半时平局概率显著(>0.35)", () => {
    const p = halfFullJoint(1.0, 1.0);
    assert.ok(htDraw(p) > 0.35, `半时平局应显著,得 ${htDraw(p).toFixed(3)}`);
  });

  it("chase=0 退回两半独立;chase 增大改变半全场转移分布", () => {
    const indep = halfFullJoint(1.8, 0.9, { chase: 0 });
    const state = halfFullJoint(1.8, 0.9, { chase: 0.3 });
    assert.ok(Math.abs(sum(indep) - 1) < 1e-9 && Math.abs(sum(state) - 1) < 1e-9);
    // 状态依赖应改变"平局-客胜""主胜-平局"等转移类(落后方搏/领先方控)
    const diff = HF_CLASSES.reduce((s, c) => s + Math.abs(indep[c] - state[c]), 0);
    assert.ok(diff > 1e-3, "chase 应实际改变分布");
  });

  it("默认参数即回测最优(chase=0.18, rho=-0.08, ratio≈0.45)", () => {
    assert.equal(HF_DEFAULTS.chase, 0.18);
    assert.equal(HF_DEFAULTS.rho, -0.08);
    assert.ok(HF_DEFAULTS.firstHalfRatioHome >= 0.4 && HF_DEFAULTS.firstHalfRatioHome <= 0.5);
  });

  it("fitHalfFullParams 从 HT/FT 比分还原半场占比", () => {
    const matches = [
      { halfHome: 1, halfAway: 0, homeGoals: 2, awayGoals: 1 },
      { halfHome: 0, halfAway: 1, homeGoals: 1, awayGoals: 2 },
      { halfHome: 1, halfAway: 1, homeGoals: 2, awayGoals: 2 },
    ];
    const f = fitHalfFullParams(matches);
    assert.equal(f.n, 3);
    // 主:半场 2 球 / 全场 5 球 = 0.4;客:半场 2 / 全场 5 = 0.4
    assert.ok(Math.abs(f.firstHalfRatioHome - 0.4) < 1e-6);
    assert.ok(Math.abs(f.firstHalfRatioAway - 0.4) < 1e-6);
  });

  it("异常输入安全降级", () => {
    assert.equal(halfFullJoint(NaN, 1), null);
    const f = fitHalfFullParams([]);
    assert.equal(f.n, 0);
  });
});
