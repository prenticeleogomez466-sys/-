// 复盘 backfill provenance 守护(0614根因):自动化里 recap:daily 用 --no-result-sync(避免覆盖
// ESPN 回填),自身 syncResults 为空 → selfcheck.穷尽免费源 曾结构性永远 false(明明上游 backfill
// 已穷尽 ESPN)。修复=backfill 落 provenance 报告、recap 诚实读它。绝不硬编码 true(no-fabrication):
// 报告陈旧/缺失/该日未查源 → 必须返回 [](诚实标未穷尽)。
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillFreeSources } from "../src/daily-recap.js";

function withReport(report) {
  const dir = mkdtempSync(join(tmpdir(), "recap-prov-"));
  if (report) writeFileSync(join(dir, "recap-backfill-report.json"), JSON.stringify(report), "utf8");
  return dir;
}

test("新鲜报告 + 该日 espnQueried → 背书 ESPN(穷尽免费源=true)", () => {
  const gen = "2026-06-14T03:00:00.000Z";
  const dir = withReport({ generatedAt: gen, dates: { "2026-06-13": { espnQueried: true, sources: ["ESPN"], need: 6, matched: 0 } } });
  try {
    const now = Date.parse(gen) + 3600e3; // 1h 后,新鲜
    assert.deepStrictEqual(backfillFreeSources("2026-06-13", dir, now), ["ESPN"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("陈旧报告(>2天)不背书 → []", () => {
  const gen = "2026-06-10T03:00:00.000Z";
  const dir = withReport({ generatedAt: gen, dates: { "2026-06-13": { espnQueried: true, sources: ["ESPN"] } } });
  try {
    const now = Date.parse(gen) + 3 * 86400e3; // 3天后,陈旧
    assert.deepStrictEqual(backfillFreeSources("2026-06-13", dir, now), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("报告缺失 → [](诚实标未穷尽,不编造)", () => {
  const dir = withReport(null);
  try { assert.deepStrictEqual(backfillFreeSources("2026-06-13", dir, Date.now()), []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("该日不在报告 → []", () => {
  const gen = "2026-06-14T03:00:00.000Z";
  const dir = withReport({ generatedAt: gen, dates: { "2026-06-12": { espnQueried: true } } });
  try { assert.deepStrictEqual(backfillFreeSources("2026-06-13", dir, Date.parse(gen) + 3600e3), []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("该日 need=0/未查源(espnQueried=false)→ [](无可结算场不冒充穷尽)", () => {
  const gen = "2026-06-14T03:00:00.000Z";
  const dir = withReport({ generatedAt: gen, dates: { "2026-06-13": { espnQueried: false, sources: [], need: 0 } } });
  try { assert.deepStrictEqual(backfillFreeSources("2026-06-13", dir, Date.parse(gen) + 3600e3), []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
