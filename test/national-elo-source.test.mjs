import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nationalEloFor, eloToLambdas } from "../src/national-elo-source.js";

describe("国家队 Elo 源", () => {
  const mem = { elo: { "挪威": 1912, "瑞典": 1719, "保加利亚": 1475, "黑山": 1439 } };

  it("nationalEloFor 命中中文名 + 无记忆/无队返回 null", () => {
    assert.equal(nationalEloFor(mem, "挪威"), 1912);
    assert.equal(nationalEloFor(mem, "火星队"), null);
    assert.equal(nationalEloFor(null, "挪威"), null);
  });

  it("eloToLambdas:强队 λ 更高、净胜球为正、双 λ 在物理域", () => {
    const lam = eloToLambdas(1912, 1719, { totalGoals: 2.5 });
    assert.ok(lam.home > lam.away, "强队期望进球更高");
    assert.ok(lam.supremacy > 0, "净胜球为正");
    assert.ok(lam.home <= 3.2 && lam.away >= 0.2, "λ 夹在物理域");
    assert.equal(lam.eloDiff, 193);
  });

  it("eloToLambdas:Elo 差越大净胜球越大(单调)", () => {
    const small = eloToLambdas(1500, 1480);
    const big = eloToLambdas(2000, 1400);
    assert.ok(big.supremacy > small.supremacy);
  });

  it("eloToLambdas:非数字 Elo 返回 null,不编造", () => {
    assert.equal(eloToLambdas(1500, null), null);
    assert.equal(eloToLambdas(undefined, 1500), null);
  });

  it("总进球线驱动 λ 总量:O/U 高→双 λ 总和高", () => {
    const lo = eloToLambdas(1700, 1700, { totalGoals: 2.0 });
    const hi = eloToLambdas(1700, 1700, { totalGoals: 3.4 });
    assert.ok((hi.home + hi.away) > (lo.home + lo.away));
  });
});
