import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectInSale, IN_SALE_HORIZON_DAYS, defaultIngestHorizonDays, preserveOutOfWindowFixtures,
} from "../scripts/ingest-500-jingcai-fallback.mjs";

// fetch-gate-500-2 / output-threeway-6 / automation-chain-3 守护(2026-06-11):
//   horizon 塌缩根因 = 默认 IN_SALE_HORIZON_DAYS=4 + 无 --horizon 的调用方(daily:fallback/jingcai-daily/
//   LineupWatch 触发 Run-Daily)每次 ingest 整批替换 → store 里已在售的 6/16+ 世界杯竞彩腿被静默删除。
//   根修两件:①世界杯窗口(2026-06-11~07-19)默认窗口动态抬到 7;②窗口外既有本店未开赛场原样保留,
//   绝不整批覆盖删除("ingest 后已存在的未停售竞彩行不得变少")。

test("世界杯窗口内默认 horizon ≥7(覆盖 06-11→06-18 全部在售腿);窗口外维持 4", () => {
  assert.ok(defaultIngestHorizonDays("2026-06-11") >= 7, "世界杯首日默认窗口必须≥7");
  assert.ok(defaultIngestHorizonDays("2026-07-19") >= 7, "世界杯末日仍≥7");
  assert.equal(defaultIngestHorizonDays("2026-06-10"), IN_SALE_HORIZON_DAYS, "开赛前一日维持默认4");
  assert.equal(defaultIngestHorizonDays("2026-08-01"), IN_SALE_HORIZON_DAYS, "世界杯后维持默认4");
  assert.equal(defaultIngestHorizonDays("乱输入"), IN_SALE_HORIZON_DAYS, "非法日期不崩,回默认");
});

test("06-11 用动态默认窗口 selectInSale 必须纳入 06-16/17/18 在售腿(塌缩复现钉死)", () => {
  const feed = ["2026-06-12", "2026-06-16", "2026-06-17", "2026-06-18"].map((d, i) => ({ matchnum: String(3000 + i), date: d, home: `H${i}`, away: `A${i}` }));
  const out = selectInSale(feed, "2026-06-11", defaultIngestHorizonDays("2026-06-11"));
  assert.equal(out.length, 4, `06-11 动态窗口应纳入全部 4 场(含06-18),实得 ${out.length}`);
});

test("preserveOutOfWindowFixtures:窗口外既有本店未开赛场保留,不被整批覆盖删除", () => {
  const prevOwn = [
    { id: "a", sequence: "3021", kickoff: "2026-06-18 21:00", homeTeam: "I", awayTeam: "J", source: "500.com-jczq-fallback" },
    { id: "b", sequence: "1013", kickoff: "2026-06-16 03:00", homeTeam: "西班牙", awayTeam: "佛得角", source: "500.com-jczq-fallback" },
    { id: "c", sequence: "6001", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非", source: "500.com-jczq-fallback" }, // 窗口内
    { id: "d", sequence: "9001", kickoff: "2026-06-05 20:00", homeTeam: "已结束", awayTeam: "X", source: "500.com-jczq-fallback" }, // 已过赛日
  ];
  const newBatch = [{ sequence: "6001", homeTeam: "墨西哥", awayTeam: "南非" }];
  // 模拟旧默认窗口(+4 → ≤06-15)的 ingest:06-16/06-18 在窗口外,必须保留
  const kept = preserveOutOfWindowFixtures(prevOwn, newBatch, "2026-06-11", 4);
  assert.deepEqual(kept.map((f) => f.id).sort(), ["a", "b"], "窗口外未开赛场(06-16/06-18)必须保留;窗口内与已过赛日不保");
});

test("preserveOutOfWindowFixtures:本次新批已含同场则不重复保留(以新抓为准)", () => {
  const prevOwn = [{ id: "a", sequence: "3021", kickoff: "2026-06-18 21:00", homeTeam: "I", awayTeam: "J", source: "500.com-jczq-fallback" }];
  const newBatch = [{ sequence: "3021", homeTeam: "I", awayTeam: "J" }];
  assert.equal(preserveOutOfWindowFixtures(prevOwn, newBatch, "2026-06-11", 4).length, 0);
});

test("不变量:ingest 合并后,store 内已存在的未停售竞彩行不得变少(默认窗口重跑不再删 6/16+ 腿)", () => {
  const prevOwn = [
    { id: "a", sequence: "3021", kickoff: "2026-06-18 21:00", homeTeam: "I", awayTeam: "J", source: "500.com-jczq-fallback" },
    { id: "b", sequence: "1013", kickoff: "2026-06-16 03:00", homeTeam: "西班牙", awayTeam: "佛得角", source: "500.com-jczq-fallback" },
    { id: "c", sequence: "6001", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非", source: "500.com-jczq-fallback" },
  ];
  const newBatch = [
    { id: "c2", sequence: "6001", kickoff: "2026-06-12 03:00", homeTeam: "墨西哥", awayTeam: "南非", source: "500.com-jczq-fallback" },
  ];
  const merged = [...newBatch, ...preserveOutOfWindowFixtures(prevOwn, newBatch, "2026-06-11", 4)];
  const futureBefore = prevOwn.filter((f) => String(f.kickoff).slice(0, 10) >= "2026-06-11").length;
  assert.ok(merged.length >= futureBefore, `未停售行不得变少:之前${futureBefore} → 合并后${merged.length}`);
});
