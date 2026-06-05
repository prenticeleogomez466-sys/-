import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simpleFourteenHeaders, toSimpleFourteenRow } from "../src/daily-report.js";

// 14 场胜负彩极简表(无官方期号时不出此表;世界杯小组赛 6/11 起会首次出现)。
// 守护:极简 14 场表只 6 列、单式方向就是胜负平、列数与表头对齐、不堆冗余。
describe("14场极简表行构建(toSimpleFourteenRow)", () => {
  it("表头恰 6 列:序/赛事/比赛/胜负平/覆盖/信心", () => {
    assert.deepEqual(simpleFourteenHeaders(), ["序", "赛事", "比赛", "胜负平", "覆盖", "信心"]);
  });

  it("一条胆(单选)selection → 6 列对齐、单式即胜负平方向、信心档", () => {
    const sel = {
      index: 1, match: "阿根廷 对 沙特", single: "主胜", compound: "主胜",
      type: "胆", competitionType: "🌍 世界杯", confidence: 100,
      probabilities: { home: "78%", draw: "15%", away: "7%" }
    };
    const row = toSimpleFourteenRow(sel);
    assert.equal(row.length, simpleFourteenHeaders().length, "列数须与表头一致");
    assert.deepEqual(row.slice(0, 5), [1, "🌍 世界杯", "阿根廷 对 沙特", "主胜", "主胜"]);
    assert.match(String(row[5]), /较高|高|100/);
  });

  it("双选 selection → 覆盖列体现双选方向、单式仍是主方向", () => {
    const sel = {
      index: 7, match: "美国 对 塞内加尔", single: "主胜", compound: "主胜/平局",
      type: "双选", competitionType: "🌍 世界杯", confidence: 28
    };
    const row = toSimpleFourteenRow(sel);
    assert.equal(row[3], "主胜");           // 胜负平 = 单式主方向
    assert.equal(row[4], "主胜/平局");      // 覆盖 = 双选覆盖
    assert.equal(row.length, 6);
  });

  it("缺 competitionType → 占位 '—',不抛错不臆造", () => {
    const row = toSimpleFourteenRow({ index: 3, match: "甲 对 乙", single: "客胜", compound: "客胜", confidence: 50 });
    assert.equal(row[1], "—");
    assert.equal(row[3], "客胜");
  });
});
