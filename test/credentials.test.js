import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionCredentials } from "../src/source-credentials.js";
import { recommendFixtures, fourteenSelectionRules } from "../src/prediction-engine.js";

test("生产凭据必须包含赔率、让球胜平负和赛程赛果源", () => {
  assert.equal(validateProductionCredentials({}).ok, false);
  assert.equal(validateProductionCredentials({ ODDS_API_KEY: "a", ODDS_JSON_URL: "https://x", API_FOOTBALL_KEY: "b" }).ok, true);
});

test("推荐引擎分离竞彩和14场,无真实先验的场诚实剔除不编造", () => {
  const result = recommendFixtures("2026-05-14");
  // 总场次守恒:可预测(provenance=赔率/DC)+ 无真实先验(data-missing)= 原始 19。
  assert.equal(result.fixtures + result.unpredictable.length, 19);
  // 该数据集多数场缺实时赔率且不在 DC 训练集 ⇒ 不再用 seeded 队名哈希编假概率凑数,
  // 而是诚实进 unpredictable 单列(根因修复 2026-05-30)。
  assert.ok(result.unpredictable.length > 0);
  // 进入推荐的每一场都必须可追溯到真实先验,绝不含 data-missing/seeded 编造。
  for (const p of result.predictions) {
    assert.ok(p.provenance && !/seed|fallback|data-missing/i.test(p.provenance), `${p.fixture.homeTeam} 先验来源非法:${p.provenance}`);
  }
  // 14 场腿多数无真实先验 ⇒ 不能冒充满 14 腿,标记 available=false 不对外发布。
  assert.equal(result.fourteen.available, false);
});

test("14场定胆必须严格限量", () => {
  const result = recommendFixtures("2026-05-15");
  const bankerCount = result.fourteen.selections.filter((selection) => selection.type === "胆").length;
  // 定胆数严格卡在系统声明的上限内(maxBankers)。断言对齐规则常量而非魔法数字——
  // 2026-05-30 温度 bug 修复后强热门信心恢复真实值,更多真·强热门达标定胆,但仍受 maxBankers 硬限。
  const { maxBankers } = fourteenSelectionRules();
  assert.ok(bankerCount <= maxBankers, `定胆 ${bankerCount} 超过上限 ${maxBankers}`);
});
