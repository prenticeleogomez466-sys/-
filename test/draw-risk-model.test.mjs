import assert from "node:assert/strict";
import test from "node:test";
import { assessDrawRisk } from "../src/draw-risk-model.js";

test("低平赔(防平区2.7-3.35)→平局率偏高·强防平/偏平", () => {
  // 平赔3.1(防平区) + 均势
  const r = assessDrawRisk({ home: 2.5, draw: 3.1, away: 2.7 });
  assert.ok(r);
  assert.equal(r.direction, "draw-guard");
  assert.ok(r.drawRateEst > 0.252, "防平区估计平率应高于基线");
});

test("高平赔(≥3.7看胜负区)→平局率偏低·看胜负", () => {
  const r = assessDrawRisk({ home: 2.2, draw: 4.5, away: 3.2 });
  assert.ok(r);
  assert.equal(r.direction, "decisive");
  assert.ok(r.drawRateEst < 0.252, "看胜负区估计平率应低于基线");
});

test("均势盘(主客赔接近)+平赔>3.5→反转看胜负(回测过测)", () => {
  // 主客赔几乎相等且平赔3.6
  const r = assessDrawRisk({ home: 2.55, draw: 3.6, away: 2.6 });
  assert.ok(r.factors.some((f) => f.includes("均势+平赔>3.5")), "应识别均势+高平赔的看胜负反转");
});

test("平赔退烧(初→收盘平隐含↓)→压低平率·看胜负", () => {
  const withDrift = assessDrawRisk({ home: 2.3, draw: 3.4, away: 3.1 }, { euOpen: { home: 2.3, draw: 3.0, away: 3.1 } });
  const noDrift = assessDrawRisk({ home: 2.3, draw: 3.4, away: 3.1 });
  assert.ok(withDrift.drawRateEst < noDrift.drawRateEst, "平赔从3.0退烧到3.4应压低估计平率");
  assert.ok(withDrift.factors.some((f) => f.includes("退烧")));
});

test("窄价值袋:让1区大热+平≥4+负≥6.5→标记valueDrawPocket", () => {
  const r = assessDrawRisk({ home: 1.5, draw: 4.2, away: 7.0 }, { ahLineAbs: 1.0 });
  assert.equal(r.valueDrawPocket, true);
  assert.ok(r.factors.some((f) => f.includes("价值袋")));
});

test("非价值袋:同样大热但平赔<4→不标价值袋", () => {
  const r = assessDrawRisk({ home: 1.5, draw: 3.6, away: 7.0 }, { ahLineAbs: 1.0 });
  assert.equal(r.valueDrawPocket, false);
});

test("缺/坏赔率→诚实返回null(不兜底)", () => {
  assert.equal(assessDrawRisk(null), null);
  assert.equal(assessDrawRisk({ home: 1, draw: 0, away: 2 }), null);
});
