import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupHandicapLine } from "../scripts/ingest-500-jingcai-fallback.mjs";

// 让球线查找容错守护(2026-06-17 洞):官方让球 DOM 截断长队名(塞伊奈约基→塞伊奈),
//   精确键 `${home}|${away}` 不匹配 → line=null → 守护退回 ×2 误杀让深盘场。
//   lookupHandicapLine 退而做双向前缀容错(home 与 away 都需前缀命中,防同前缀误配)。

test("精确键 home|away 命中优先", () => {
  const map = { "法国|塞内加尔": "-1.5", "法国": "-9.9" };
  assert.equal(lookupHandicapLine(map, "法国", "塞内加尔"), "-1.5");
});

test("legacy 单 home 键命中(无 | 分隔)", () => {
  const map = { "法国": "-1" };
  assert.equal(lookupHandicapLine(map, "法国", "塞内加尔"), "-1");
});

test("存键被截断 → 双向前缀容错命中", () => {
  // DOM 把 塞伊奈约基 截成 塞伊奈,瓦萨完整
  const map = { "塞伊奈|瓦萨": "-0.5" };
  assert.equal(lookupHandicapLine(map, "塞伊奈约基", "瓦萨"), "-0.5");
});

test("查询被截断、存键完整 → 仍前缀容错命中(对称)", () => {
  const map = { "塞伊奈约基|瓦萨": "+0.25" };
  assert.equal(lookupHandicapLine(map, "塞伊奈", "瓦萨"), "+0.25");
});

test("同前缀但客队不同 → 绝不误配(home 与 away 都需命中)", () => {
  // 存的是 塞伊奈 vs 拉赫蒂,查询客队是 瓦萨 → 不得返回拉赫蒂那条
  const map = { "塞伊奈|拉赫蒂": "-2" };
  assert.equal(lookupHandicapLine(map, "塞伊奈约基", "瓦萨"), undefined);
});

test("legacy 单键也需 home 前缀命中", () => {
  const map = { "塞伊奈": "-1.25" };
  assert.equal(lookupHandicapLine(map, "塞伊奈约基", "瓦萨"), "-1.25");
  assert.equal(lookupHandicapLine(map, "完全不同", "瓦萨"), undefined);
});

test("无任何匹配 → undefined(交给守护退回安全阈值)", () => {
  const map = { "甲|乙": "-1" };
  assert.equal(lookupHandicapLine(map, "丙", "丁"), undefined);
});

test("空 map / 空 home → undefined 不抛", () => {
  assert.equal(lookupHandicapLine(null, "法国", "塞内加尔"), undefined);
  assert.equal(lookupHandicapLine({}, "", "塞内加尔"), undefined);
});
