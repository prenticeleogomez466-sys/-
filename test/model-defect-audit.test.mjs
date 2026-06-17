import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isWorldCupRoutedDay,
  inspectFixtureCoverage,
  inspectMarketCoverage,
  inspectRealtimeGate
} from "../src/model-defect-audit.js";

test("isWorldCupRoutedDay: 全部走 worldcup-match-model 路由 → true", () => {
  const rec = {
    predictions: [
      { provenance: "worldcup-match-model" },
      { wcModel: { foo: 1 } },
      { provenance: "worldcup-match-model" }
    ]
  };
  assert.equal(isWorldCupRoutedDay(rec), true);
});

test("isWorldCupRoutedDay: 混合(部分俱乐部) → false(回退俱乐部严判)", () => {
  const rec = {
    predictions: [
      { provenance: "worldcup-match-model" },
      { provenance: "odds(x)+dixon-coles(y)" }
    ]
  };
  assert.equal(isWorldCupRoutedDay(rec), false);
});

test("isWorldCupRoutedDay: 空预测/引擎失败 → false", () => {
  assert.equal(isWorldCupRoutedDay(null), false);
  assert.equal(isWorldCupRoutedDay({ predictions: [] }), false);
});

test("inspectFixtureCoverage: 0场14场胜负彩(世界杯期常态) → 不报 P0", () => {
  const defects = [];
  inspectFixtureCoverage(
    { fixtures: [{ marketType: "jingcai" }, { marketType: "jingcai" }] },
    defects
  );
  assert.equal(defects.filter((d) => d.severity === "P0").length, 0);
});

test("inspectFixtureCoverage: 已开售但抓取不全(0<n<14) → 报 P0", () => {
  const defects = [];
  const fixtures = [{ marketType: "jingcai" }, ...Array.from({ length: 13 }, () => ({ marketType: "shengfucai" }))];
  inspectFixtureCoverage({ fixtures }, defects);
  const p0 = defects.filter((d) => d.severity === "P0");
  assert.equal(p0.length, 1);
  assert.match(p0[0].title, /13\/14/);
});

test("inspectFixtureCoverage: 完整14场 → 无14场缺陷", () => {
  const defects = [];
  const fixtures = [{ marketType: "jingcai" }, ...Array.from({ length: 14 }, () => ({ marketType: "shengfucai" }))];
  inspectFixtureCoverage({ fixtures }, defects);
  assert.equal(defects.some((d) => d.title.includes("14")), false);
});

const STATUS_WC = {
  fixtures: 12,
  usable: 12,
  complete: 12,
  rows: Array.from({ length: 12 }, (_, i) => ({ match: `m${i}`, usable: true, complete: true, realTime: false }))
};

test("inspectMarketCoverage: 世界杯日 realTime 全 false → 不报实时闸门 P0", () => {
  const defects = [];
  inspectMarketCoverage(STATUS_WC, defects, { worldCupDay: true });
  assert.equal(defects.some((d) => d.title.includes("实时赔率不足")), false);
});

test("inspectMarketCoverage: 俱乐部日 realTime 不足 → 报实时闸门 P0", () => {
  const defects = [];
  inspectMarketCoverage(STATUS_WC, defects, { worldCupDay: false });
  assert.equal(defects.some((d) => d.severity === "P0" && d.title.includes("实时赔率不足")), true);
});

test("inspectMarketCoverage: 世界杯日仍保留真实赔率缺口检查(complete<fixtures)", () => {
  const defects = [];
  const status = { ...STATUS_WC, complete: 11 };
  inspectMarketCoverage(status, defects, { worldCupDay: true });
  assert.equal(defects.some((d) => d.title.includes("完整赔率不完整")), true);
});

test("inspectRealtimeGate: 世界杯日 → 跳过(不报缺文件 P0)", () => {
  const defects = [];
  inspectRealtimeGate("2099-01-01", defects, {}, { worldCupDay: true });
  assert.equal(defects.length, 0);
});

test("inspectRealtimeGate: 俱乐部日且闸门文件缺失 → 报 P0", () => {
  const defects = [];
  inspectRealtimeGate("2099-01-01", defects, {}, { worldCupDay: false });
  assert.equal(defects.some((d) => d.severity === "P0" && d.title.includes("缺少实时闸门文件")), true);
});
