import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLeagueName } from "../src/experience-library-store.js";

const lib = { leagues: { "瑞典超级联赛": {}, "芬兰超级联赛": {}, "挪威超级联赛": {}, "日本职业联赛": {}, "英超": {} } };

test("实时短名→经验库canonical键", () => {
  assert.equal(normalizeLeagueName("瑞超", lib), "瑞典超级联赛");
  assert.equal(normalizeLeagueName("芬超", lib), "芬兰超级联赛");
  assert.equal(normalizeLeagueName("日职", lib), "日本职业联赛");
});
test("直配键原样返回", () => {
  assert.equal(normalizeLeagueName("英超", lib), "英超");
  assert.equal(normalizeLeagueName("瑞典超级联赛", lib), "瑞典超级联赛");
});
test("无匹配返回原名(退全局)", () => {
  assert.equal(normalizeLeagueName("国际赛", lib), "国际赛");
  assert.equal(normalizeLeagueName(null, lib), null);
});
