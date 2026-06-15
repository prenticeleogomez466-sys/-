// 毒用例守护(2026-06-15):settled↔pendingReason 矛盾必须被探针抓出,干净放行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSettledWithPendingResidue } from "../src/result-sanity.js";

test("抓出已结算却残留 pendingReason 的矛盾行", () => {
  const rows = [
    { match: "A 对 B", actualStatus: "settled", actual: "主胜", pendingReason: "比赛未开赛(开赛 2026-06-14)" },
    { match: "C 对 D", actualStatus: "settled", actual: "平局" },                       // 干净已结算
    { match: "E 对 F", actualStatus: "pending-result", pendingReason: "免费源暂无赛果" }, // pending 带 reason 合法
    { match: "G 对 H", actual: "客胜", pendingReason: "去毒残留" },                       // 仅 actual 也算已结算
  ];
  const bad = findSettledWithPendingResidue(rows);
  assert.equal(bad.length, 2);
  assert.deepEqual(bad.map((r) => r.match).sort(), ["A 对 B", "G 对 H"]);
});

test("全干净返回空", () => {
  const rows = [
    { actualStatus: "settled", actual: "主胜" },
    { actualStatus: "pending-result", pendingReason: "未开赛" },
  ];
  assert.equal(findSettledWithPendingResidue(rows).length, 0);
});

test("空白/非字符串 pendingReason 不算残留", () => {
  assert.equal(findSettledWithPendingResidue([{ actualStatus: "settled", actual: "主胜", pendingReason: "  " }]).length, 0);
  assert.equal(findSettledWithPendingResidue([{ actualStatus: "settled", actual: "主胜", pendingReason: null }]).length, 0);
});

test("非数组安全返回空", () => {
  assert.equal(findSettledWithPendingResidue(null).length, 0);
  assert.equal(findSettledWithPendingResidue(undefined).length, 0);
});
