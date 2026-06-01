import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ensembleHalfFull, __resetEnsembleHalfFullForTests } from "../src/ensemble-halffull.js";

const CLASSES = ["主胜-主胜", "主胜-平局", "主胜-客胜", "平局-主胜", "平局-平局", "平局-客胜", "客胜-主胜", "客胜-平局", "客胜-客胜"];

describe("半全场集成生产层", () => {
  test("非法 λ 返回 null,不编造", () => {
    __resetEnsembleHalfFullForTests();
    assert.equal(ensembleHalfFull(NaN, 1.2, "英超"), null);
  });

  test("有 profile+经验表时返回 9 类归一分布", () => {
    __resetEnsembleHalfFullForTests();
    const d = ensembleHalfFull(1.6, 1.1, "英超");
    if (!d) return; // 无 profile/经验表(CI 无 exports/fixtures)则跳过
    for (const c of CLASSES) assert.ok(Number.isFinite(d[c]) && d[c] >= 0, `${c} 概率有效`);
    const sum = CLASSES.reduce((s, c) => s + d[c], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, "9 类归一");
  });

  test("league 缺失时退回全局经验,仍出有效分布", () => {
    __resetEnsembleHalfFullForTests();
    const d = ensembleHalfFull(1.4, 1.4);
    if (!d) return;
    const sum = CLASSES.reduce((s, c) => s + d[c], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});
