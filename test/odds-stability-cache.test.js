import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// 隔离到临时数据目录,避免污染真实 stability-cache.json。
let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "stab-cache-"));
  process.env.FOOTBALL_DATA_DIR = tmp;
});
afterEach(() => {
  delete process.env.FOOTBALL_DATA_DIR;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const date = "2026-06-02";
const fixture = { id: "jc-1", sequence: "201", marketType: "jingcai", competition: "国际赛", date, homeTeam: "克罗地亚", awayTeam: "比利时" };

function realSnapshot() {
  return {
    date, fixtureId: fixture.id, sequence: fixture.sequence, marketType: "jingcai",
    competition: "国际赛", homeTeam: "克罗地亚", awayTeam: "比利时",
    collectedAt: "2026-06-02T12:00:00.000Z",
    europeanOdds: { initial: { home: 2.1, draw: 3.2, away: 3.3 }, current: { home: 2.0, draw: 3.1, away: 3.4 } },
    jingcaiHandicap: { line: -1, source: "500.com-jczq" },
    source: "trade.500.com/jczq XML"
  };
}

describe("odds stability cache", () => {
  it("一次抓到真实盘口后,实时源全失败仍能整场复现 last-good", async () => {
    const { updateStabilityCache, backfillFromStabilityCache } = await import("../src/odds-stability-cache.js");
    updateStabilityCache(date, [realSnapshot()]);
    // 模拟下一轮抓取:这场完全没拿到快照
    const out = backfillFromStabilityCache(date, [], [fixture]);
    assert.equal(out.backfilled, 1);
    const snap = out.snapshots.find((s) => s.fixtureId === fixture.id);
    assert.ok(snap, "应由缓存造出整场快照");
    assert.equal(snap.europeanOdds.current.away, 3.4);
    assert.equal(snap.jingcaiHandicap.line, -1);
    assert.match(snap.source, /稳定缓存/);
  });

  it("派生 fallback(主客对称)不得覆盖已缓存的真实盘口", async () => {
    const { updateStabilityCache, backfillFromStabilityCache } = await import("../src/odds-stability-cache.js");
    updateStabilityCache(date, [realSnapshot()]);
    // 本轮只拿到对称派生欧赔(质量低)
    const weak = {
      ...realSnapshot(),
      europeanOdds: { initial: { home: 2.57, draw: 2.85, away: 2.57 }, current: { home: 2.57, draw: 2.85, away: 2.57 } },
      source: "500.com-jczq-fallback"
    };
    const out = backfillFromStabilityCache(date, [weak], [fixture]);
    const snap = out.snapshots.find((s) => s.fixtureId === fixture.id);
    // 真实非对称盘口应被缓存复原,而非保留对称占位
    assert.equal(snap.europeanOdds.current.home, 2.0);
    assert.equal(snap.europeanOdds.current.away, 3.4);
    assert.ok(out.backfilled >= 1);
  });

  it("质量更高的新实时值应覆盖旧缓存(只升不降)", async () => {
    const { updateStabilityCache, backfillFromStabilityCache, loadStabilityCache } = await import("../src/odds-stability-cache.js");
    // 先存一个对称占位(质量1)
    updateStabilityCache(date, [{ ...realSnapshot(), europeanOdds: { initial: { home: 2.5, draw: 2.5, away: 2.5 }, current: { home: 2.5, draw: 2.5, away: 2.5 } }, source: "fallback" }]);
    // 再来真实双向值(质量3)
    updateStabilityCache(date, [realSnapshot()]);
    const out = backfillFromStabilityCache(date, [], [fixture]);
    const snap = out.snapshots.find((s) => s.fixtureId === fixture.id);
    assert.equal(snap.europeanOdds.current.away, 3.4, "应保留质量更高的真实值");
  });
});
