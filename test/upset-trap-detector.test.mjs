import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeUpsetTrap, favoriteUpset } from "../src/upset-trap-detector.js";

describe("爆冷风险 + 诱盘识别(upset-trap-detector)", () => {
  it("缺收盘概率返回 null,不编造", () => {
    assert.equal(analyzeUpsetTrap({ closing: null }), null);
    assert.equal(analyzeUpsetTrap({ closing: { home: 0.5 } }), null);
  });

  it("识别热门方向 + 强度档", () => {
    const r = analyzeUpsetTrap({ closing: { home: 0.74, draw: 0.16, away: 0.1 } });
    assert.equal(r.favorite, "home");
    assert.equal(r.favoriteLabel, "主胜");
    assert.equal(r.tier, "超级大热");
    assert.ok(r.upsetRisk < 0.42, "超级大热爆冷风险应低");
  });

  it("被加注热门 → 爆冷风险下调、moveTag=加注", () => {
    const opening = { home: 0.55, draw: 0.25, away: 0.2 };
    const closing = { home: 0.62, draw: 0.22, away: 0.16 }; // 主队被加注 +0.07
    const r = analyzeUpsetTrap({ opening, closing });
    assert.equal(r.movement.favoriteDrift > 0, true);
    assert.match(r.reason, /加注/);
  });

  it("退烧热门 → 爆冷风险上调 + 撤离提示", () => {
    const opening = { home: 0.62, draw: 0.22, away: 0.16 };
    const closing = { home: 0.5, draw: 0.27, away: 0.23 }; // 主队退烧 -0.12
    const r = analyzeUpsetTrap({ opening, closing });
    assert.equal(r.movement.favoriteDrift < 0, true);
    assert.ok(r.upsetRisk > 0.42, "退烧后爆冷风险升");
    assert.match(r.trapVerdict, /退烧|走冷/);
  });

  it("加注但模型评级明显更低 → 诱盘嫌疑", () => {
    const opening = { home: 0.5, draw: 0.27, away: 0.23 };
    const closing = { home: 0.6, draw: 0.23, away: 0.17 }; // 公众加注到 0.60
    const model = { home: 0.5, draw: 0.27, away: 0.23 };   // 模型只给 0.50
    const r = analyzeUpsetTrap({ opening, closing, model });
    assert.match(r.trapVerdict, /诱盘/);
    assert.equal(r.priceReflectsStrength, false);
  });

  it("加注且模型认同 → 真实", () => {
    const opening = { home: 0.5, draw: 0.27, away: 0.23 };
    const closing = { home: 0.6, draw: 0.23, away: 0.17 };
    const model = { home: 0.63, draw: 0.22, away: 0.15 }; // 模型更看好
    const r = analyzeUpsetTrap({ opening, closing, model });
    assert.match(r.trapVerdict, /真实/);
    assert.equal(r.priceReflectsStrength, true);
  });

  it("诱盘类判定带诚实 caveat(回测证市场更准·非弃注依据)", () => {
    const opening = { home: 0.5, draw: 0.27, away: 0.23 };
    const closing = { home: 0.6, draw: 0.23, away: 0.17 };
    const model = { home: 0.5, draw: 0.27, away: 0.23 }; // 模型明显更低 → 诱盘嫌疑
    const r = analyzeUpsetTrap({ opening, closing, model });
    assert.match(r.trapVerdict, /诱盘/);
    assert.ok(r.caveat && /市场通常更准|非弃注/.test(r.caveat), "诱盘类判定必须带诚实 caveat");
    assert.match(r.reason, /⚠/);
  });

  it("价实相符(无模型分歧)不加 caveat", () => {
    const r = analyzeUpsetTrap({ opening: { home: 0.55, draw: 0.25, away: 0.2 }, closing: { home: 0.56, draw: 0.25, away: 0.19 } });
    assert.equal(r.caveat, null);
  });

  it("favoriteUpset 正确判定热门是否翻车", () => {
    const closing = { home: 0.62, draw: 0.22, away: 0.16 };
    assert.equal(favoriteUpset(closing, { home: 2, away: 0 }).won, true);
    assert.equal(favoriteUpset(closing, { home: 0, away: 1 }).won, false);
    assert.equal(favoriteUpset(closing, { home: 1, away: 1 }).won, false);
    assert.equal(favoriteUpset(closing, { home: 1, away: 1 }).actual, "draw");
  });

  it("reason 是人读字符串,含强度/移动/爆冷/诱盘四要素", () => {
    const r = analyzeUpsetTrap({
      opening: { home: 0.62, draw: 0.22, away: 0.16 },
      closing: { home: 0.5, draw: 0.27, away: 0.23 },
      model: { home: 0.48, draw: 0.28, away: 0.24 },
    });
    assert.equal(typeof r.reason, "string");
    assert.match(r.reason, /胜率/);
    assert.match(r.reason, /爆冷风险/);
  });
});
