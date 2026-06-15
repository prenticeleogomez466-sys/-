// 健康监控指标守护(2026-06-15):新鲜度阈值 + reliability 分桶/防薄样本误报。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFreshness, bucketReliability } from "../src/health-metrics.js";

const NOW = 1_700_000_000_000;
const H = 3600e3;

test("新鲜度:在阈值内=fresh,超阈值=stale", () => {
  const out = assessFreshness([
    { source: "fixtures", latestFile: "a.json", mtimeMs: NOW - 10 * H }, // 10h < 36h
    { source: "crawler", latestFile: "b.json", mtimeMs: NOW - 120 * H }, // 120h > 96h
  ], NOW);
  assert.equal(out[0].stale, false);
  assert.equal(out[1].stale, true);
  assert.equal(out[1].ageHours, 120);
});

test("新鲜度:目录缺/空 → missing 且 stale", () => {
  const out = assessFreshness([{ source: "market", latestFile: null, mtimeMs: null }], NOW);
  assert.equal(out[0].missing, true);
  assert.equal(out[0].stale, true);
});

test("新鲜度:自定义阈值覆盖默认", () => {
  const out = assessFreshness([{ source: "fixtures", latestFile: "x", mtimeMs: NOW - 20 * H }], NOW, { fixtures: 12 });
  assert.equal(out[0].stale, true); // 20h > 自定义 12h
});

test("reliability:分桶正确 + actual/gap 计算", () => {
  const pairs = [
    { predicted: 0.70, hit: 1 }, { predicted: 0.72, hit: 1 }, { predicted: 0.68, hit: 0 }, // 65-100
    { predicted: 0.50, hit: 0 }, // 45-55
  ];
  const rel = bucketReliability(pairs);
  const hi = rel.find((b) => b.bucket === "65-100");
  assert.equal(hi.samples, 3);
  assert.ok(Math.abs(hi.actual - 2 / 3) < 1e-3); // actual 已 toFixed(4),用 1e-3 容差
});

test("reliability:薄样本不标记 flagged(防噪声误报)", () => {
  // 3 场大 gap,但 < minSamples=20 → 不 flag
  const pairs = [{ predicted: 0.6, hit: 0 }, { predicted: 0.6, hit: 0 }, { predicted: 0.6, hit: 0 }];
  const rel = bucketReliability(pairs);
  assert.equal(rel.find((b) => b.bucket === "55-65").flagged, false);
});

test("reliability:样本足够且大 gap → flagged", () => {
  const pairs = Array.from({ length: 25 }, () => ({ predicted: 0.6, hit: 0 })); // gap -0.6, n=25
  const rel = bucketReliability(pairs);
  assert.equal(rel.find((b) => b.bucket === "55-65").flagged, true);
});

test("空输入安全", () => {
  assert.equal(assessFreshness(null, NOW).length, 0);
  assert.equal(bucketReliability(null).length, 4); // 4 桶全空
});
