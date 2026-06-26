import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDoubleChance } from "../src/prediction-engine.js";

// 2026-06-25 世界杯42场自学习落地的三道门控(改概率必回测;这两条是"只告警不改概率/不改主推"的选择性门控):
//   改动②ouHit/comboCaution 由集成管线(npm run today + recap)端到端覆盖;
//   本测试钉死纯函数 computeDoubleChance 的"世界杯/国家队限定·平局风险告警",防回退成全局改动(会毁俱乐部价值)。

const wc = (favHome) => [
  { code: "3", probability: favHome },
  { code: "1", probability: (1 - favHome) * 0.6 },
  { code: "0", probability: (1 - favHome) * 0.4 },
];

test("drawRiskCaution:世界杯超级大热(≥70%)→ 触发平局风险告警(只提示,不改 recommended/概率)", () => {
  const dc = computeDoubleChance(wc(0.78), { home: 0.78, draw: 0.13, away: 0.09 }, {}, "世界杯");
  assert.equal(dc.drawRiskCaution.flag, true);
  assert.match(dc.note, /平局风险|逼平/);
  // 不改主推:强档仍 recommended=false(≥0.70 单关),概率不被改写
  assert.equal(dc.recommended, false);
});

test("drawRiskCaution:俱乐部联赛同档大热 → 不告警(回测证俱乐部强热门单选77%,全局改动会毁价值)", () => {
  const dc = computeDoubleChance(wc(0.78), { home: 0.78, draw: 0.13, away: 0.09 }, {}, "英超");
  assert.equal(dc.drawRiskCaution.flag, false);
  assert.doesNotMatch(dc.note, /平局风险\(国际大赛\)/);
});

test("drawRiskCaution:国际大赛但非超级大热(<70%)→ 不额外告警(走常规双选逻辑)", () => {
  const dc = computeDoubleChance(wc(0.62), { home: 0.62, draw: 0.22, away: 0.16 }, {}, "世界杯");
  assert.equal(dc.drawRiskCaution.flag, false);
});

test("drawRiskCaution:competition 缺省 → 不告警(默认俱乐部口径,零回归)", () => {
  const dc = computeDoubleChance(wc(0.80), { home: 0.80, draw: 0.12, away: 0.08 });
  assert.equal(dc.drawRiskCaution.flag, false);
});
