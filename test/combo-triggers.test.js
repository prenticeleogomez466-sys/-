import assert from "node:assert/strict";
import test from "node:test";
import { comboTriggers, comboFeatures, parseLine, RULES } from "../src/combo-triggers.js";
import { buildComboTriggerSheet } from "../src/today-delivery-lib.js";

test("parseLine 解析单值与分盘字符串", () => {
  assert.equal(parseLine(-0.75), -0.75);
  assert.equal(parseLine("-0.5/1"), -0.75); // (0.5+1)/2 带负号
  assert.equal(parseLine("0/0.5"), 0.25);
  assert.equal(parseLine("-2"), -2);
  assert.equal(parseLine(null), null);
  assert.equal(parseLine("无"), null);
});

test("comboFeatures 计算热门/走势/让球band", () => {
  const f = comboFeatures({ euClose: { home: 1.25, draw: 6, away: 11 }, euOpen: { home: 1.35, draw: 5.5, away: 9 }, ahLineClose: "-2", ahLineOpen: "-1.75" });
  assert.equal(f.favHome, true);
  assert.equal(f.favOdds, 1.25);
  assert.equal(f.ahAbs, 2);
  assert.equal(f.drift, "加注"); // 收盘热门隐含上升
});

test("超大热门主队 → 触发主胜+大球(高信心)", () => {
  const r = comboTriggers({ euClose: { home: 1.22, draw: 6.5, away: 12 }, euOpen: { home: 1.22, draw: 6.5, away: 12 }, ahLineClose: "-2.25" });
  const ids = r.triggers.map((t) => t.id);
  assert.ok(ids.includes("超大热门→主胜"));
  assert.ok(ids.includes("超大热门→大球"));
  assert.ok(r.triggers.find((t) => t.predict === "主胜").tier === "高");
});

test("退烧热门 → 触发危险避坑提醒", () => {
  // 收盘热门隐含比初盘低=退烧
  const r = comboTriggers({ euClose: { home: 2.1, draw: 3.3, away: 3.4 }, euOpen: { home: 1.8, draw: 3.4, away: 4.2 }, ahLineClose: "-0.5" });
  assert.ok(r.triggers.some((t) => t.id === "退烧热门→危险避坑"));
});

test("胶着低平赔+平稳 → 触发小球", () => {
  const r = comboTriggers({ euClose: { home: 2.4, draw: 3.0, away: 3.1 }, euOpen: { home: 2.4, draw: 3.0, away: 3.1 }, ahLineClose: "0" });
  assert.ok(r.triggers.some((t) => t.predict === "小球"));
});

test("无收盘欧赔 → 返回null(不编)", () => {
  assert.equal(comboTriggers({ euClose: null }), null);
  assert.equal(comboTriggers({ euClose: { home: 0, draw: 0, away: 0 } }), null);
});

test("buildComboTriggerSheet 出'组合触发'sheet·全覆盖·缺赔率诚实标", () => {
  const rows = [
    { match: "强队 vs 弱旅", wld: "主胜", sanityOdds: { euro: { home: 1.22, draw: 6.5, away: 12 }, euroInit: { home: 1.22, draw: 6.5, away: 12 }, ahLine: -2.25 } },
    { match: "缺赔率场 vs 对手", wld: "—", sanityOdds: {} },
  ];
  const sheet = buildComboTriggerSheet({ date: "2026-06-22", rows });
  assert.equal(sheet.name, "组合触发");
  // 第一场触发高命中组合(主胜/大球),第二场缺赔率诚实标
  const joined = sheet.rows.map((r) => r.join("｜")).join("\n");
  assert.match(joined, /主胜|大球/);
  assert.match(joined, /未抓全|缺/);
});

test("每条规则结构完整(命中率/档/来源)", () => {
  for (const r of RULES) {
    assert.ok(r.id && r.market && r.predict && r.tier && r.src, `规则缺字段: ${r.id}`);
    assert.ok(r.hit && Number.isFinite(r.hit.tr) && Number.isFinite(r.hit.te) && r.hit.n > 0, `规则命中率缺: ${r.id}`);
    assert.equal(typeof r.fire, "function");
  }
});
