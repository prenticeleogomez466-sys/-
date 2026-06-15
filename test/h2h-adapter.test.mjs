// 结构化H2H适配器守护(2026-06-15):两形态归一为主队视角{score};无交锋→null不编。
import { test } from "node:test";
import assert from "node:assert/strict";
import { h2hToStatsList } from "../src/today-delivery-lib.js";
import { h2hStats } from "../src/intel-stats.js";

test("h2hToStatsList: 数组形态(ESPN,gf/ga主视角)直接用", () => {
  const list = h2hToStatsList([{ date: "2025-06-01", gf: 2, ga: 0, res: "胜" }, { date: "2024-06-01", gf: 1, ga: 1, res: "平" }]);
  assert.equal(list.length, 2);
  assert.equal(list[0].score, "2-0");
  // 接 h2hStats 算统计
  const s = h2hStats(list);
  assert.equal(s.n, 2); assert.equal(s.w, 1); assert.equal(s.d, 1);
});

test("h2hToStatsList: 49k库形态(meetings)按 homeEn 定向,客先则flip", () => {
  const h2h = {
    homeEn: "Brazil", source: "49k",
    meetings: [
      { date: "2022-01-01", home: "Brazil", score: "3-1" },   // 主先,直接用 → 3-1
      { date: "2021-01-01", home: "Argentina", score: "2-0" }, // 客先(对 Brazil 而言),flip → 0-2
    ],
  };
  const list = h2hToStatsList(h2h);
  assert.equal(list[0].score, "3-1");
  assert.equal(list[1].score, "0-2");
});

test("h2hToStatsList: 无交锋/null → null(标缺不编)", () => {
  assert.equal(h2hToStatsList(null), null);
  assert.equal(h2hToStatsList({ meetings: [] }), null);
  assert.equal(h2hToStatsList([]), null);
});
