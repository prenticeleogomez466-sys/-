import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeMarketDivergence } from "../src/prediction-engine.js";

// 接生产校验:clv-confidence-gate 经 computeMarketDivergence 接进每场预测,
// 只附加背离标签 + 建议降档系数,不改 pick/confidence(遵 feedback_confidence_not_autosuppress)。
describe("市场背离置信门接生产", () => {
  const mk = (pickCode, prob, conf, odds) => ({
    pick: { code: pickCode, probability: prob },
    confidence: conf,
    marketSnapshot: { europeanOdds: { current: odds } },
  });

  it("同向:模型选项=市场最热项 → 系数 1.0、保持", () => {
    // 主胜赔率最低=市场最热,模型也推主胜
    const md = computeMarketDivergence(mk("3", 0.7, 80, { home: 1.4, draw: 4.5, away: 7.0 }));
    assert.equal(md.modelPick, "home");
    assert.equal(md.marketPick, "home");
    assert.equal(md.aligned, true);
    assert.equal(md.fightLevel, "同向");
    assert.equal(md.confidenceMultiplier, 1);
  });

  it("逆市:模型押市场最冷项 → 降档 + 慎单选标签", () => {
    // 市场最热=主胜,模型偏押客胜(最冷)
    const md = computeMarketDivergence(mk("0", 0.4, 60, { home: 1.4, draw: 4.5, away: 7.0 }));
    assert.equal(md.modelPick, "away");
    assert.equal(md.aligned, false);
    assert.equal(md.fightLevel, "逆市");
    assert.ok(md.confidenceMultiplier < 1, "逆市应降档");
    assert.match(md.tag, /逆市/);
  });

  it("次热:押市场次热项 → 略降档(0.85)", () => {
    // 市场:主1.4最热、平4.5次热、客7.0最冷;模型推平=次热
    const md = computeMarketDivergence(mk("1", 0.35, 50, { home: 1.4, draw: 4.5, away: 7.0 }));
    assert.equal(md.fightLevel, "次热");
    assert.equal(md.confidenceMultiplier, 0.85);
  });

  it("无欧赔 → 返回 null,不臆造", () => {
    const md = computeMarketDivergence({ pick: { code: "3", probability: 0.6 }, confidence: 70, marketSnapshot: { europeanOdds: {} } });
    assert.equal(md, null);
  });

  it("优先用收盘价(final)且标记 closingAvailable", () => {
    const p = mk("3", 0.7, 80, { home: 1.4, draw: 4.5, away: 7.0 });
    p.marketSnapshot.europeanOdds.final = { home: 1.35, draw: 4.6, away: 7.5 };
    const md = computeMarketDivergence(p);
    assert.equal(md.closingAvailable, true);
  });
});
