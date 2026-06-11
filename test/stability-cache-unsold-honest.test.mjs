import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// fetch-gate-500-1 刀②守护(2026-06-11):
//   1. "明确未开售"(euroUnsold=true)≠"抓取失败",稳定缓存绝不对未开售场回填 last-good 欧赔
//      ——否则 06-08 新浪机构赔率复活成"在售1X2"绕过⛔未开售闸(6005卡塔尔/1013西班牙真钱事故)。
//   2. 回填陈旧值时 collectedAt 必须如实标龄(用缓存采集时间),不得给陈旧值盖新鲜时间戳。

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stab-unsold-"));
  process.env.FOOTBALL_DATA_DIR = tmp;
});
afterEach(() => {
  delete process.env.FOOTBALL_DATA_DIR;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const date = "2026-06-11";
const STALE_AT = "2026-06-08T10:00:00.000Z";
const FRESH_AT = "2026-06-11T08:00:00.000Z";

function staleSinaSnapshot() {
  return {
    date, fixtureId: "jc500-2026-06-11-6005-卡塔尔-瑞士", sequence: "6005", marketType: "jingcai",
    competition: "世界杯", homeTeam: "卡塔尔", awayTeam: "瑞士",
    collectedAt: STALE_AT,
    europeanOdds: { initial: { home: 13.5, draw: 6.5, away: 1.2 }, current: { home: 13.5, draw: 6.5, away: 1.2 } },
    source: "新浪胜负彩欧洲四大机构 sina 06-08文",
  };
}

describe("stability cache 未开售/陈旧时间戳", () => {
  it("euroUnsold=true(明确未开售)的快照,缓存绝不回填欧赔", async () => {
    const { updateStabilityCache, backfillFromStabilityCache } = await import("../src/odds-stability-cache.js");
    updateStabilityCache(date, [staleSinaSnapshot()]);
    const live = {
      date, fixtureId: "jc500-2026-06-11-6005-卡塔尔-瑞士", sequence: "6005", marketType: "jingcai",
      competition: "世界杯", homeTeam: "卡塔尔", awayTeam: "瑞士",
      collectedAt: FRESH_AT,
      europeanOdds: null,
      euroUnsold: true, // ingest 成功跑完且 1X2 feed 无此场 = 竞彩明确未开售
      handicapOdds: { initial: { home: 1.85, draw: 3.4, away: 3.6 }, current: { home: 1.85, draw: 3.4, away: 3.6 } },
      source: "500.com-jczq-fallback",
    };
    const out = backfillFromStabilityCache(date, [live], []);
    const snap = out.snapshots.find((s) => s.fixtureId === live.fixtureId);
    assert.equal(snap.europeanOdds ?? null, null, "明确未开售的1X2绝不能被陈旧缓存复活");
  });

  it("非未开售的缺失(抓取失败)仍可回填,但 collectedAt 必须如实用缓存陈旧时间", async () => {
    const { updateStabilityCache, backfillFromStabilityCache } = await import("../src/odds-stability-cache.js");
    updateStabilityCache(date, [staleSinaSnapshot()]);
    const live = {
      date, fixtureId: "jc500-2026-06-11-6005-卡塔尔-瑞士", sequence: "6005", marketType: "jingcai",
      competition: "世界杯", homeTeam: "卡塔尔", awayTeam: "瑞士",
      collectedAt: FRESH_AT,
      europeanOdds: null, // 无 euroUnsold 标记 = 视为抓取失败,允许 last-good 回填
      source: "500.com-jczq-fallback",
    };
    const out = backfillFromStabilityCache(date, [live], []);
    const snap = out.snapshots.find((s) => s.fixtureId === live.fixtureId);
    assert.ok(snap.europeanOdds?.current, "抓取失败场允许 last-good 回填(稳定缓存原语义)");
    assert.equal(snap.collectedAt, STALE_AT, "回填陈旧值后 collectedAt 必须标陈旧采集时间,不得冒充新鲜");
  });

  it("无回填发生时 collectedAt 保持实时值(不被误改旧)", async () => {
    const { backfillFromStabilityCache } = await import("../src/odds-stability-cache.js");
    const live = { ...staleSinaSnapshot(), collectedAt: FRESH_AT, source: "500.com-jczq-fallback" };
    const out = backfillFromStabilityCache(date, [live], []);
    const snap = out.snapshots.find((s) => s.fixtureId === live.fixtureId);
    assert.equal(snap.collectedAt, FRESH_AT);
  });
});
