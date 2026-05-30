import { test } from "node:test";
import assert from "node:assert/strict";
import { experienceCell } from "../src/daily-report.js";

test("experienceCell 汇总平局/大小球/漂移三类提示", () => {
  const cell = experienceCell({
    experienceContext: {
      drawAlert: "⚠️ 历史同情境平局率 30%(120场)",
      overUnderHint: "📈 历史同情境大球(>2.5)64%、均3.00球(151场),偏大球",
      driftHint: "🔀 历史同情境(热门被加注):主队(热门)兑现 61%(154场)",
    },
  });
  assert.match(cell, /平局率 30%/);
  assert.match(cell, /偏大球/);
  assert.match(cell, /兑现 61%/);
  // 多行汇总
  assert.equal(cell.split("\n").length, 3);
});

test("experienceCell 无 experienceContext 返回占位", () => {
  assert.equal(experienceCell({}), "—");
  assert.equal(experienceCell({ experienceContext: null }), "—");
});

test("experienceCell 有经验但无具体提示时退回样本量+来源", () => {
  const cell = experienceCell({
    experienceContext: { n: 88, source: "联赛+热门档(英超/home|强热)", drawAlert: null, overUnderHint: null, driftHint: null },
  });
  assert.match(cell, /历史88场/);
  assert.match(cell, /英超/);
});

test("experienceCell 只有部分提示时只拼接存在的", () => {
  const cell = experienceCell({
    experienceContext: { overUnderHint: "📊 历史同情境大球(>2.5)51%、均2.72球(41379场),大小球均衡", drawAlert: null, driftHint: null },
  });
  assert.equal(cell.split("\n").length, 1);
  assert.match(cell, /大小球均衡/);
});
