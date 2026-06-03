import assert from "node:assert/strict";
import test from "node:test";
import { honestPass, splitHonestPool } from "../src/honest-pass-gate.js";

test("国际赛高风险硬币注 → 全数观望(4-5条硬伤)", () => {
  const r = honestPass({ prob: 0.523, ev: 0.009, risk: "高", competition: "国际赛", divergencePp: 5.2, aligned: true });
  assert.equal(r.pass, false);
  assert.ok(r.failReasons.length >= 4);
  assert.ok(r.checks.find((c) => c.name === "校准档" && !c.ok), "45-55%档应判高估");
});

test("EV正但落45-55档 → 仍观望(校准档否决)", () => {
  const r = honestPass({ prob: 0.489, ev: 0.173, risk: "高", competition: "国际赛", divergencePp: 11.6, aligned: false });
  assert.equal(r.pass, false);
  assert.ok(r.checks.find((c) => c.name === "EV价值" && c.ok), "EV应过");
  assert.ok(r.checks.find((c) => c.name === "校准档" && !c.ok));
  assert.ok(r.checks.find((c) => c.name === "市场一致" && !c.ok), "大分歧应否决");
});

test("理想注:俱乐部赛+强热门+正EV+低风险+同向 → 诚实过关", () => {
  const r = honestPass({ prob: 0.62, ev: 0.06, risk: "低", competition: "英超", divergencePp: 3, aligned: true });
  assert.equal(r.pass, true);
  assert.equal(r.failReasons.length, 0);
});

test("splitHonestPool 分推荐池/观望池", () => {
  const { pass, watch } = splitHonestPool([
    { prob: 0.62, ev: 0.06, risk: "低", competition: "西甲", divergencePp: 2, aligned: true },
    { prob: 0.52, ev: -0.1, risk: "高", competition: "国际赛", divergencePp: 1, aligned: true },
  ]);
  assert.equal(pass.length, 1);
  assert.equal(watch.length, 1);
});
