// 让球线来源诚实守护(2026-06-13 用户三次重申"不许冒充作假兜底·我要下注"):
//   竞彩官方让球线(jingcaiHandicap.line)缺失时,绝不许用模型/推断线冒充真实线、绝不盖✅500过盘数字。
//   赔率真实(500 nspf)可标✅,但"过盘%"依赖真实线→线缺=按铁律标缺不出过盘,不糊弄。
//   背景:28/52未来场(06-16/17)让球赔率在但竞彩官方线未开,显示层旧逻辑 `line ?? p.handicapPick?.line`
//   会把 undefined/模型线盖成"让X ✅500让球"。今天交付场靠合并层选到真线侥幸没触发,此测试焊死防复发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handicapVerdictParts } from "../src/today-delivery-lib.js";

const hwMain = { pick: "让球主胜", pickCode: "3", probability: 0.55 };

test("真线在(lineReal=true)→ 正常出让球(让/受让后胜平负)分析(不变,无回归)", () => {
  const v = handicapVerdictParts({ line: -1, wldCode: "3", wldLabel: "主胜", hw: hwMain, marketDist: { home: 0.52 }, lineReal: true });
  assert.equal(v.modelPct, 55);
  assert.match(v.text, /让1球后胜 55%\(模型\)/);
  assert.doesNotMatch(v.text, /官方让球线未抓到/);
});

test("默认不传 lineReal → 向后兼容按真线处理(既有调用/测试不受影响)", () => {
  const v = handicapVerdictParts({ line: -1, wldCode: "3", wldLabel: "主胜", hw: hwMain, marketDist: { home: 0.52 } });
  assert.equal(v.modelPct, 55);
  assert.match(v.text, /让1球后胜 55%\(模型\)/);
});

test("🔴竞彩官方线缺(lineReal=false)→ 标缺不冒充:无过盘数字、不盖✅500、明示线未抓到", () => {
  const v = handicapVerdictParts({ line: -1, wldCode: "3", wldLabel: "主胜", hw: hwMain, marketDist: { home: 0.52 }, lineReal: false });
  assert.match(v.text, /官方让球线未抓到/);
  assert.doesNotMatch(v.text, /过盘\d+%/);        // 绝不给按推断线算的过盘百分比
  assert.equal(v.modelPct, null);                  // 过盘数清空
  assert.equal(v.lineReal, false);
});

test("让球三态本身缺 → 仍标⚠️裁决缺(原有行为保留)", () => {
  const v = handicapVerdictParts({ line: -1, wldCode: "3", wldLabel: "主胜", hw: {}, marketDist: null });
  assert.match(v.text, /让球真实裁决缺/);
});
