import test from "node:test";
import assert from "node:assert/strict";
import { loadIntlXg, teamXgProfile, hasIntlXg } from "../src/statsbomb-xg-source.js";

test("loadIntlXg 永远返回 {teams} 结构(缺文件也优雅降级,不抛)", () => {
  const d = loadIntlXg();
  assert.ok(d && typeof d.teams === "object", "应有 teams 对象");
});

test("数据缺失时 teamXgProfile 返回 null,不臆造", () => {
  // 不存在的队名一定 null
  assert.equal(teamXgProfile("绝不存在的队XYZ"), null);
  assert.equal(teamXgProfile(null), null);
});

test("有数据时:队名中英/别名解析 + 画像字段完整", () => {
  if (!hasIntlXg()) { console.log("  (跳过:xG 数据未生成,先跑 sb_fetch_intl_xg.py)"); return; }
  const { teams } = loadIntlXg();
  // 取一个实际存在的英文队名,验证画像字段
  const anyEn = Object.keys(teams)[0];
  const p = teamXgProfile(anyEn);
  assert.ok(p, `${anyEn} 应有画像`);
  for (const k of ["matches", "xgForPerGame", "xgAgainstPerGame", "xgDiffPerGame", "finishingPerGame"]) {
    assert.ok(typeof p[k] === "number", `画像应含数值字段 ${k}`);
  }
  // 中文名解析(若西班牙在数据里)
  if (teams["Spain"]) {
    const zh = teamXgProfile("西班牙");
    assert.ok(zh && zh.team === "Spain", "中文'西班牙'应解析到 Spain");
  }
});
