import assert from "node:assert/strict";
import test from "node:test";
import { validateProductionCredentials } from "../src/source-credentials.js";
import { recommendFixtures } from "../src/prediction-engine.js";

test("生产凭据必须包含赔率、让球胜平负和赛程赛果源", () => {
  assert.equal(validateProductionCredentials({}).ok, false);
  assert.equal(validateProductionCredentials({ ODDS_API_KEY: "a", ODDS_JSON_URL: "https://x", API_FOOTBALL_KEY: "b" }).ok, true);
});

test("推荐引擎分离竞彩和14场", () => {
  const result = recommendFixtures("2026-05-14");
  assert.equal(result.fixtures, 19);
  assert.equal(result.fourteen.count, 14);
});

test("14场定胆必须严格限量", () => {
  const result = recommendFixtures("2026-05-15");
  const bankerCount = result.fourteen.selections.filter((selection) => selection.type === "胆").length;
  assert.ok(bankerCount <= 4);
});
