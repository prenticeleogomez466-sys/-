import { test } from "node:test";
import assert from "node:assert/strict";
import { keepPreviousSnapshot } from "../scripts/ingest-500-jingcai-fallback.mjs";

// fetch-gate-500-1 守护(2026-06-11):稳定缓存改写过 source 的本店旧快照副本必须被新抓覆盖剔除。
// 实锤事故:market/2026-06-11.json 留存 28 条 source='500.com-jczq-fallback+稳定缓存(新浪胜负彩…06-08文)'
// 的陈旧快照,与新快照同 fixtureId 并存;旧保留过滤 s.source!=='500.com-jczq-fallback' 精确比较永远剔不掉
// 这种改写副本 → findMarketSnapshot 取到陈旧条,6005卡塔尔/1013西班牙"未开售1X2"被 06-08 新浪机构赔率
// 复活成 sfcSold=true 干净主选,绕过⛔未开售闸进真钱交付。

test("稳定缓存改写过source的本店旧副本必须被剔除(包含判,非精确比较)", () => {
  const stale = {
    fixtureId: "jc500-2026-06-11-6005-卡塔尔-瑞士",
    source: "500.com-jczq-fallback+稳定缓存(新浪胜负彩欧洲四大机构 https://sports.sina.com.cn/xxx 06-08文)",
    collectedAt: "2026-06-10T16:22:00.000Z",
  };
  assert.equal(keepPreviousSnapshot(stale), false, "陈旧稳定缓存副本不得被保留(06-08新浪欧赔复活'未开售1X2'的根因)");
});

test("纯本店旧快照(source精确等于500.com-jczq-fallback)同样被剔除(以本次新抓为准)", () => {
  assert.equal(keepPreviousSnapshot({ fixtureId: "x", source: "500.com-jczq-fallback" }), false);
});

test("verified=true 人工核实快照绝不剔除(wc-handicap-line-persist-fix2 语义保留)", () => {
  const verified = {
    fixtureId: "y",
    verified: true,
    source: "500.com-jczq-fallback+人工核实",
    jingcaiHandicap: { line: -1 },
  };
  assert.equal(keepPreviousSnapshot(verified), true);
});

test("其它源快照(官方/Playwright/ESPN)原样保留,不被误剔", () => {
  assert.equal(keepPreviousSnapshot({ fixtureId: "z", source: "trade.500.com/jczq XML(Playwright)" }), true);
  assert.equal(keepPreviousSnapshot({ fixtureId: "w", source: "https://www.sporttery.cn" }), true);
});

test("窗口外保留场(preservedIds)的本店快照保留——保场不保赔会让远期预售场失盘", () => {
  const s = { fixtureId: "jc500-2026-06-11-3024-i-j", source: "500.com-jczq-fallback" };
  assert.equal(keepPreviousSnapshot(s, new Set(["jc500-2026-06-11-3024-i-j"])), true);
});
