import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLeague } from "../src/league-profile.js";

// 账本实测出现的联赛名变体——分裂会让 league-expert-mixture 样本减半、
// 弱联赛胆门 n≥20 误判。canonicalLeague 须把同一联赛各变体归一到同一 key。
test("芬超变体合并(此前无芬兰条目→分裂)", () => {
  assert.equal(canonicalLeague("芬超"), "芬超");
  assert.equal(canonicalLeague("芬兰超级联赛"), "芬超");
  assert.equal(canonicalLeague("Veikkausliiga"), "芬超");
});
test("沙职并入沙特联(此前沙职不匹配沙特→分裂)", () => {
  assert.equal(canonicalLeague("沙职"), "沙特联");
  assert.equal(canonicalLeague("沙特联"), "沙特联");
  assert.equal(canonicalLeague("Saudi Pro League"), "沙特联");
});
test("欧冠↔欧洲冠军联赛同一赛事", () => {
  assert.equal(canonicalLeague("欧冠"), "欧冠");
  assert.equal(canonicalLeague("欧洲冠军联赛"), "欧冠");
  assert.equal(canonicalLeague("Champions League"), "欧冠");
});
test("欧罗巴/欧协联为独立赛事不并入欧冠", () => {
  assert.equal(canonicalLeague("欧罗巴"), "欧罗巴");
  assert.equal(canonicalLeague("欧协联"), "欧协联");
});
test("既有合并不回归", () => {
  assert.equal(canonicalLeague("瑞典超级联赛"), "瑞超");
  assert.equal(canonicalLeague("日本职业联赛"), "日职");
  assert.equal(canonicalLeague("挪威超级联赛"), "挪超");
  assert.equal(canonicalLeague("英超"), "英超");
});
