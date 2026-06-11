import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMarketSnapshot, findMarketSnapshot, snapshotEuroProvenance } from "../src/market-data-store.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fetch-gate-500-1 守护(2026-06-11):market 层三道防线——
//   a. euroUnsold(明确未开售)透传持久化,不被 normalize 剥掉;
//   b. findMarketSnapshot 同 fixtureId 多条快照按 collectedAt 取最新为基,且
//      基为"明确未开售"时,陈旧副本的欧赔绝不被 donor 合并复活;
//   c. 交付层 ✅500欧赔/✅实测 标签必须由 snapshotEuroProvenance(来源派生)裁决,见值即打✅是缺陷。

const date = "2026-06-11";
const FX = { id: "jc500-2026-06-11-6005-卡塔尔-瑞士", date, homeTeam: "卡塔尔", awayTeam: "瑞士", marketType: "jingcai" };

const staleCopy = () => normalizeMarketSnapshot({
  date, fixtureId: FX.id, homeTeam: "卡塔尔", awayTeam: "瑞士", marketType: "jingcai",
  collectedAt: "2026-06-10T16:22:00.000Z",
  europeanOdds: { initial: { home: 13.5, draw: 6.5, away: 1.2 }, current: { home: 13.5, draw: 6.5, away: 1.2 } },
  source: "500.com-jczq-fallback+稳定缓存(新浪胜负彩欧洲四大机构 sina 06-08文)",
}, date, 0);

const freshUnsold = () => normalizeMarketSnapshot({
  date, fixtureId: FX.id, homeTeam: "卡塔尔", awayTeam: "瑞士", marketType: "jingcai",
  collectedAt: "2026-06-11T08:00:00.000Z",
  europeanOdds: null,
  euroUnsold: true,
  handicapOdds: { initial: { home: 1.85, draw: 3.4, away: 3.6 }, current: { home: 1.85, draw: 3.4, away: 3.6 } },
  source: "500.com-jczq-fallback",
}, date, 1);

test("normalizeMarketSnapshot 透传 euroUnsold(true保留/缺省false)", () => {
  assert.equal(freshUnsold().euroUnsold, true);
  assert.equal(staleCopy().euroUnsold, false);
});

test("findMarketSnapshot:陈旧副本在数组前、新快照在后,基必须取 collectedAt 最新的那条", () => {
  const base = findMarketSnapshot(FX, [staleCopy(), freshUnsold()]);
  assert.equal(base.collectedAt, "2026-06-11T08:00:00.000Z", "同fixtureId多条须按新鲜度择基,不依赖数组顺序");
});

test("findMarketSnapshot:基为明确未开售时,陈旧副本欧赔绝不被donor合并复活(6005卡塔尔事故钉死)", () => {
  const base = findMarketSnapshot(FX, [staleCopy(), freshUnsold()]);
  assert.equal(base.europeanOdds ?? null, null, "未开售1X2不得被06-08新浪陈旧欧赔复活成在售");
  assert.ok(base.handicapOdds?.current, "让球真实盘保留");
});

test("snapshotEuroProvenance:稳定缓存来源=stale,纯500实抓=from500", () => {
  const p1 = snapshotEuroProvenance(staleCopy());
  assert.equal(p1.stale, true, "含'稳定缓存'的来源必须判stale,交付层禁打✅500欧赔/✅实测");
  const p2 = snapshotEuroProvenance(normalizeMarketSnapshot({
    date, fixtureId: FX.id, homeTeam: "卡塔尔", awayTeam: "瑞士",
    collectedAt: "2026-06-11T08:00:00.000Z",
    europeanOdds: { initial: { home: 2.1, draw: 3.2, away: 3.3 }, current: { home: 2.0, draw: 3.1, away: 3.4 } },
    source: "500.com-jczq-fallback",
  }, date, 2));
  assert.equal(p2.stale, false);
  assert.equal(p2.from500, true);
});

test("交付层 today-full-coverage 标签从来源派生(引用 snapshotEuroProvenance,不再见值即打✅)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "..", "scripts", "today-full-coverage.mjs"), "utf8");
  assert.match(text, /snapshotEuroProvenance/, "euroStr/auditFor 必须经 snapshotEuroProvenance 派生标签");
});
