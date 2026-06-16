import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeUpsetTrap, favoriteUpset, diagnoseUpsetRisk } from "../src/upset-trap-detector.js";

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

  describe("多信号爆冷诊断(diagnoseUpsetRisk)——区分德国血洗 vs 西班牙闷平", () => {
    it("无 1X2 隐含 → null,不编造", () => {
      assert.equal(diagnoseUpsetRisk({}), null);
      assert.equal(diagnoseUpsetRisk({ p1x2Fav: 1.2 }), null);
    });
    it("德国vs库拉索:超级大热+深让球(-3.5)+高大小球(4.5)=真血洗→低,无背离", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.91, ahLine: -3.5, totalsLine: 4.5, pOver25: 0.81 });
      assert.equal(r.band, "低");
      assert.equal(r.grindDivergence, false);
    });
    it("★西班牙型(深热+大小球线低):回测审计证'易爆冷平'OOS翻车(五大联赛78%窄胜)→诚实归低风险+WC尾部caveat", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.88, ahLine: -2.5, totalsLine: 3.5, pOver25: 0.74 });
      assert.equal(r.band, "低", "OOS证强热低球多为窄胜·不夸大爆冷");
      assert.match(r.upsetType, /低风险/);
      assert.match(r.reason, /窄胜|尾部|不可靠预判/, "须含诚实WC尾部caveat");
    });
    it("深浅以同1X2实力档中位线为基准:86%热门基准2.5,开-2.5=同类正常(纠正旧绝对阈)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.86, ahLine: -2.5, totalsLine: 4.0 });
      assert.equal(r.lineDepth, "同类正常");
    });
    it("94%热门基准2.75,开-2.5=踩'浅于同类'临界(残差-0.25,西班牙原型)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.94, ahLine: -2.5, totalsLine: 4.0 });
      assert.equal(r.lineDepth, "浅于同类");
    });
    it("德国-3.5对91%热门=深于同类(基准2.75),市场敢加码", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.91, ahLine: -3.5, totalsLine: 4.5 });
      assert.equal(r.lineDepth, "深于同类(市场敢加码)");
    });
    it("比利时vs埃及:1X2本身只60%→不胜40%→高", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.60, ahLine: -0.5, totalsLine: 2.5 });
      assert.equal(r.band, "高");
    });
    it("平局隐含≥30%=最干净平局信号→升档到中(校准31.5%)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.72, ahLine: -1.5, totalsLine: 2.5, drawImplied: 0.31 });
      assert.equal(r.band, "中");
      assert.match(r.reason, /平局隐含/);
    });
    it("分型 upsetType:强热(≥72%)→🟢低风险(OOS胜~78%)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.82, ahLine: -2.5, totalsLine: 4, pOver25: 0.62 });
      assert.match(r.upsetType, /低风险/);
    });
    it("分型 upsetType:平局隐含≥30%→🟡防平(OOS校准31.5%·唯一成立的平局触发)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.55, ahLine: -0.5, totalsLine: 2.5, pOver25: 0.44, drawImplied: 0.31 });
      assert.match(r.upsetType, /防平|双向爆冷/); // 势均同时满足双向,二者皆为正确高风险标注
    });
    it("分型 upsetType:势均(不胜≥42%)→🔴双向爆冷(OOS胜47/平28/负25)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.55, ahLine: -0.5, totalsLine: 2.5, pOver25: 0.5 });
      assert.match(r.upsetType, /双向爆冷/);
    });
    it("恒带诚实 caveat(非必爆·不自动弃赛)", () => {
      const r = diagnoseUpsetRisk({ p1x2Fav: 0.88, ahLine: -2.5, totalsLine: 3.5 });
      assert.ok(r.caveat && /非必爆|不自动弃赛/.test(r.caveat));
    });
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
