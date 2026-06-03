import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proportionalDevig, shinDevig, powerDevig, shinFromInverse } from "../src/market-devig.js";

const sum = (p) => p.home + p.draw + p.away;

describe("market-devig", () => {
  const odds = { home: 1.8, draw: 3.6, away: 4.8 }; // 含抽水(booksum>1)

  it("三法都归一到 1", () => {
    for (const fn of [proportionalDevig, shinDevig, powerDevig]) {
      const p = fn(odds);
      assert.ok(Math.abs(sum(p) - 1) < 1e-6, `${fn.name} 应和=1`);
    }
  });

  it("非法赔率返回 null", () => {
    assert.equal(shinDevig(null), null);
    assert.equal(shinDevig({ home: 1, draw: 0.5, away: 2 }), null);
  });

  it("Shin 单调保序:概率排序与逆赔率一致", () => {
    const p = shinDevig(odds);
    assert.ok(p.home > p.draw && p.draw > p.away, "赔率越低概率越高");
  });

  it("Shin 估计内幕比例 z ∈ [0,0.5)", () => {
    const p = shinDevig(odds);
    assert.ok(p.z >= 0 && p.z < 0.5, `z=${p.z} 越界`);
  });

  it("Shin 相对比例法上调热门(favourite-longshot 校正)", () => {
    // 强不对称盘口:大热门 + 大冷门
    const skew = { home: 1.25, draw: 6.0, away: 11.0 };
    const prop = proportionalDevig(skew);
    const shin = shinDevig(skew);
    assert.ok(shin.home > prop.home, "Shin 应上调热门(被低估)");
    assert.ok(shin.away < prop.away, "Shin 应下压冷门(被高估)");
  });

  it("无抽水(公平赔率)三法≈一致", () => {
    // 构造 booksum=1 的公平盘
    const fair = { home: 2.0, draw: 4.0, away: 4.0 }; // 0.5+0.25+0.25=1
    const prop = proportionalDevig(fair), shin = shinDevig(fair);
    assert.ok(Math.abs(shin.home - prop.home) < 0.02, "无抽水时 Shin≈比例");
  });

  it("shinFromInverse 处理多路+零项(冠军盘)", () => {
    const pis = [1 / 5, 1 / 8, 0, 1 / 30, 1 / 100]; // 含一支无赔率队
    const { probs, z } = shinFromInverse(pis);
    assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-6, "和=1");
    assert.equal(probs[2], 0, "零逆赔率→概率 0");
    assert.ok(z >= 0 && z < 0.5);
  });
});
