import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeMarketSnapshot,
  saveMarketSnapshots,
  loadMarketSnapshots,
  findMarketSnapshot
} from "../src/market-data-store.js";
import { mergeMarketSnapshots } from "../src/china-web-sources.js";
import { getDataSubdir } from "../src/paths.js";

// wc-handicap-line-persist-fix2(2026-06-08):已 Playwright 实时核对的世界杯单场真实让球线
// (add-wc-singles-jingcai.mjs 注入 verified:true)必须在 23:50 Run-MarketRefresh 重 ingest 后仍保留,
// 不被无线新快照回退平手。verified 只由人工核实路径设置,绝不从 source/启发式推断(守脏数据铁律)。

const TEST_DATE = "2099-01-01"; // 临时日期,测试末尾清理,避免污染真实数据
function cleanup() {
  const p = join(getDataSubdir("market"), `${TEST_DATE}.json`);
  if (existsSync(p)) rmSync(p);
}

const wcVerified = () => ({
  fixtureId: "jc-wc-2026-06-08-4002-韩国-捷克",
  homeTeam: "韩国",
  awayTeam: "捷克",
  marketType: "jingcai",
  verified: true,
  jingcaiHandicap: { line: -1, source: "500.com-jczq-DOM" }
});

test("normalizeMarketSnapshot 透传 verified 标记(true 不被剥掉)", () => {
  const out = normalizeMarketSnapshot(wcVerified(), "2026-06-08");
  assert.equal(out.verified, true);
  assert.equal(out.jingcaiHandicap.line, -1);
});

test("normalizeMarketSnapshot 未标 verified 时为 falsy(默认不冒充已核实)", () => {
  const out = normalizeMarketSnapshot(
    { fixtureId: "x", homeTeam: "A", awayTeam: "B", marketType: "jingcai" },
    "2026-06-08"
  );
  assert.notEqual(out.verified, true);
});

test("normalizeMarketSnapshot 不从 source 启发式推断 verified", () => {
  const out = normalizeMarketSnapshot(
    { fixtureId: "x", homeTeam: "A", awayTeam: "B", marketType: "jingcai", source: "500.com-jczq-DOM verified 已核" },
    "2026-06-08"
  );
  assert.notEqual(out.verified, true);
});

test("mergeMarketSnapshots:重 ingest 后 verified line 仍在(无线新快照不抹旧线)", () => {
  const prev = [normalizeMarketSnapshot(wcVerified(), "2026-06-08")];
  const next = [{
    fixtureId: "jc-wc-2026-06-08-4002-韩国-捷克",
    homeTeam: "韩国",
    awayTeam: "捷克",
    marketType: "jingcai",
    europeanOdds: { initial: { home: 2.43, draw: 2.84, away: 2.74 }, current: { home: 2.43, draw: 2.84, away: 2.74 } },
    jingcaiHandicap: null
  }];
  const merged = mergeMarketSnapshots(prev, next);
  const m = merged.find((s) => s.homeTeam === "韩国");
  assert.equal(m.jingcaiHandicap.line, -1, "无线新快照不应抹掉已核实线");
  assert.equal(m.verified, true, "verified 不应被新源降级");
  assert.ok(m.europeanOdds, "新快照的普通字段(欧赔)应正常合并进来");
});

test("mergeMarketSnapshots:新快照带有效线时按新线更新(verified 不冻结真实更新)", () => {
  const prev = [normalizeMarketSnapshot(wcVerified(), "2026-06-08")];
  const next = [{
    fixtureId: "jc-wc-2026-06-08-4002-韩国-捷克",
    homeTeam: "韩国",
    awayTeam: "捷克",
    marketType: "jingcai",
    jingcaiHandicap: { line: -2, source: "500.com-jczq" }
  }];
  const merged = mergeMarketSnapshots(prev, next);
  const m = merged.find((s) => s.homeTeam === "韩国");
  assert.equal(m.jingcaiHandicap.line, -2, "有效新线允许更新,只防无线/缺失覆盖");
});

test("普通(非 verified)快照重 ingest 后正常被新快照覆盖", () => {
  const prev = [normalizeMarketSnapshot({
    fixtureId: "jc500-2026-06-08-7201",
    homeTeam: "C",
    awayTeam: "D",
    marketType: "jingcai",
    jingcaiHandicap: { line: 0 }
  }, "2026-06-08")];
  const next = [{
    fixtureId: "jc500-2026-06-08-7201",
    homeTeam: "C",
    awayTeam: "D",
    marketType: "jingcai",
    europeanOdds: { initial: { home: 1.5, draw: 4, away: 6 }, current: { home: 1.5, draw: 4, away: 6 } },
    jingcaiHandicap: { line: 1 }
  }];
  const merged = mergeMarketSnapshots(prev, next);
  const m = merged.find((s) => s.homeTeam === "C");
  assert.equal(m.jingcaiHandicap.line, 1, "普通快照不享受冻结,回归正常覆盖");
  assert.ok(m.europeanOdds);
});

test("findMarketSnapshot 多源合并时优先 verified 快照的 jingcaiHandicap", () => {
  const snapshots = [
    normalizeMarketSnapshot({ fixtureId: "jc500-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克", marketType: "jingcai", jingcaiHandicap: { line: 0 }, source: "500.com-jczq-fallback" }, "2026-06-08"),
    normalizeMarketSnapshot({ fixtureId: "jc-wc-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克", marketType: "jingcai", verified: true, jingcaiHandicap: { line: -1 } }, "2026-06-08")
  ];
  const fixture = { id: "jc-wc-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克" };
  const found = findMarketSnapshot(fixture, snapshots);
  assert.equal(found.jingcaiHandicap.line, -1, "donor 优先 verified,不被 line=0 脏副本污染");
});

test("findMarketSnapshot:base 为脏副本(line=0)时仍取 verified 的让球线", () => {
  // base 取 fixtureId 精确匹配=脏 fallback 副本(line=0),verified 同场快照带有效线 → 应被 verified 覆盖
  const snapshots = [
    normalizeMarketSnapshot({ fixtureId: "jc500-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克", marketType: "jingcai", jingcaiHandicap: { line: 0 }, source: "500.com-jczq-fallback" }, "2026-06-08"),
    normalizeMarketSnapshot({ fixtureId: "jc-wc-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克", marketType: "jingcai", verified: true, jingcaiHandicap: { line: -1 } }, "2026-06-08")
  ];
  const fixture = { id: "jc500-2026-06-08-4002", homeTeam: "韩国", awayTeam: "捷克" };
  const found = findMarketSnapshot(fixture, snapshots);
  assert.equal(found.jingcaiHandicap.line, -1, "base=脏副本时应被 verified 的有效线覆盖");
});

test("saveMarketSnapshots 整库往返不丢 verified(持久化锁)", () => {
  try {
    saveMarketSnapshots(TEST_DATE, [wcVerified()]);
    const s = loadMarketSnapshots(TEST_DATE).snapshots[0];
    assert.equal(s.verified, true);
    assert.equal(s.jingcaiHandicap.line, -1);
  } finally {
    cleanup();
  }
});

test("ingest-500 previous 合并保留 verified WC 单场(端到端 store 往返)", () => {
  try {
    saveMarketSnapshots(TEST_DATE, [wcVerified()]);
    // 模拟 ingest 的 previous 过滤(剔除 fallback 源)
    const previous = loadMarketSnapshots(TEST_DATE).snapshots.filter((s) => s.source !== "500.com-jczq-fallback");
    assert.ok(previous.some((s) => s.verified && s.jingcaiHandicap?.line === -1), "previous 应含 verified 快照且线未变");
    // 再保存 previous + 新500快照(含同名 jc500- 无线副本)
    const dirty = {
      fixtureId: "jc500-2026-06-08-4002",
      homeTeam: "韩国",
      awayTeam: "捷克",
      marketType: "jingcai",
      source: "500.com-jczq-fallback",
      jingcaiHandicap: { line: 0 }
    };
    saveMarketSnapshots(TEST_DATE, [...previous, dirty]);
    const reload = loadMarketSnapshots(TEST_DATE).snapshots;
    const found = findMarketSnapshot({ id: "jc-wc-2026-06-08-4002-韩国-捷克", homeTeam: "韩国", awayTeam: "捷克" }, reload);
    assert.equal(found.jingcaiHandicap.line, -1, "精确 fixtureId + verified 双保险");
  } finally {
    cleanup();
  }
});
