import test from "node:test";
import assert from "node:assert/strict";
import { attributeRecap, attributionHeadline } from "../src/recap-attribution.js";

// ── 2026-06-10 接住率(单选为主+双选接住为辅,用户定口径)──
test("接住率:双选触发场任一方向兑现算接住,未触发场不放宽", () => {
  const rows = [
    { match: "A", primary: "主胜", actual: "主胜", hit: true, actualScore: "2-0", probabilityHome: 0.6, probabilityDraw: 0.25, probabilityAway: 0.15, confidence: 70 },
    { match: "B", primary: "主胜", actual: "平局", hit: false, actualScore: "1-1", doubleChanceRecommended: true, doubleChanceCodes: ["3", "1"], probabilityHome: 0.4, probabilityDraw: 0.3, probabilityAway: 0.3, confidence: 35 },
    { match: "C", primary: "主胜", actual: "客胜", hit: false, actualScore: "0-1", doubleChanceRecommended: true, doubleChanceCodes: ["3", "1"], probabilityHome: 0.4, probabilityDraw: 0.3, probabilityAway: 0.3, confidence: 35 },
    { match: "D", primary: "主胜", actual: "平局", hit: false, actualScore: "0-0", probabilityHome: 0.5, probabilityDraw: 0.3, probabilityAway: 0.2, confidence: 50 },
  ];
  const r = attributeRecap(rows);
  assert.equal(r.hit, 1);
  assert.equal(r.caught, 2, "A单选中+B双选接住;C双选未含客胜不算;D未触发双选不放宽");
  assert.equal(r.caughtRate, 50);

  // 复盘看板头行(daily-recap 展示用):命中为主 + 接住率为辅,口径注明"双选触发场任一兑现"
  const head = attributionHeadline(r);
  assert.match(head, /结算 4 · 命中 1\(25%\)/);
  assert.match(head, /接住 2\(50%\)/);
  assert.match(head, /单选中或双选触发场任一兑现/);
});

test("attributionHeadline:无结算/旧数据缺caughtRate → 诚实降级不编", () => {
  assert.match(attributionHeadline(null), /暂无已结算场次/);
  assert.match(attributionHeadline({ settled: 0 }), /暂无已结算场次/);
  // 旧汇总对象没有 caughtRate 字段 → 不显示接住段(不拿 undefined 冒充)
  const head = attributionHeadline({ settled: 3, hit: 2, accuracy: 66.7, caughtRate: null });
  assert.match(head, /结算 3 · 命中 2/);
  assert.doesNotMatch(head, /接住/);
});
