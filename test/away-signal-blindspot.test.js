import assert from "node:assert/strict";
import test from "node:test";
import { buildFourteenPlan } from "../src/prediction-engine.js";
import { simpleWldCell } from "../src/daily-report.js";

// 客胜信号盲区修法(2026-06-07,317场live复盘):中信心(<60)主推客胜实测命中仅30.6%(五大更低29.6%)、
//   实际35.6%反向是主胜(模型次选才对)=平局盲区客侧孪生。零风险 Pareto:不动 argmax/概率核心,
//   只①14场/任选9 绝不当胆(挡50-60档单推翻车,40-50已被conf≥50门挡)②极简表标注。≥60客胜健康(68.8%)放行。
//   定胆阈值 bankerMinConfidence=50/bankerMinGap=0.22 → conf=55 客胜原本可当胆,正好被客胜门拦。
function pred({ id, comp, pickCode, conf, pickProb = 0.78, secProb = 0.14 }) {
  return {
    fixture: { id, homeTeam: `H${id}`, awayTeam: `A${id}`, competition: comp, date: "2026-06-01", marketType: "shengfucai", tags: ["14场胜负彩"] },
    pick: { code: pickCode, label: "x", probability: pickProb },
    secondaryPick: { code: "1", label: "平局", probability: secProb },
    confidence: conf, risk: "中",
    advancedFeatures: { quality: { score: 70 } },
    rationale: "test"
  };
}
const COMPS = ["英超", "德甲", "西甲", "意甲"];
const four = (pickCode, conf) => COMPS.map((c, i) => pred({ id: `f${i}`, comp: c, pickCode, conf }));

test("客胜盲区:中信心(conf55<60)主推客胜 14场绝不当胆(0胆腿)", () => {
  const plan = buildFourteenPlan(four("0", 55));
  assert.equal(plan.bankerParlay.ok, false, "4场中信心客胜应无胆腿可串");
});

test("对照:同参数中信心(conf55)主胜照常当胆(证明拦的是客胜门非conf门)", () => {
  const plan = buildFourteenPlan(four("3", 55));
  assert.equal(plan.bankerParlay.ok, true, "中信心主胜不受客胜门影响");
  assert.ok(plan.bankerParlay.legs >= 2, "应有≥2胆腿");
});

test("≥60高信心客胜健康(实测68.8%)→放行当胆", () => {
  const plan = buildFourteenPlan(four("0", 65));
  assert.equal(plan.bankerParlay.ok, true, "≥60客胜准,不该被拦");
});

test("simpleWldCell:中信心主推客胜标注'客胜信号弱建议双选'", () => {
  const p = { pick: { code: "0" }, confidence: 55, probabilities: { home: 0.3, draw: 0.3, away: 0.4 } };
  assert.match(simpleWldCell(p), /客胜信号弱/);
});

test("simpleWldCell:≥60客胜不加提示(健康档)", () => {
  const p = { pick: { code: "0" }, confidence: 65, probabilities: { home: 0.3, draw: 0.3, away: 0.4 } };
  assert.doesNotMatch(simpleWldCell(p), /客胜信号弱/);
});

test("simpleWldCell:主推主胜不加客胜提示", () => {
  const p = { pick: { code: "3" }, confidence: 55, probabilities: { home: 0.4, draw: 0.3, away: 0.3 } };
  assert.doesNotMatch(simpleWldCell(p), /客胜信号弱/);
});
