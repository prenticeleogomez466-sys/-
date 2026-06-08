import { test } from "node:test";
import assert from "node:assert/strict";
import { selectInSale } from "../scripts/ingest-500-jingcai-fallback.mjs";

// jingcai-ingest-wc-singles(2026-06-08):500 静态 XML 只列"当前在售"竞彩,在售=feed 全部场次。
//   旧"单批锚定"(取最早赛日那批/单 matchnum 系列)对世界杯长预售期不成立——会把 4001 墨西哥vs南非
//   等世界杯单场整批丢弃。selectInSale 纯函数:纳入全部在售场,只剔赛日严格早于业务日(已结束)的场。

// 同形固件:模拟 pl_nspf/spf parseMatches 后的形状(matchnum 跨 1/3/4/6 系列,kickoff 跨 06-09~06-18)。
const FEED = [
  { id: "1", matchnum: "1201", date: "2026-06-09", matchtime: "02:45", league: "国际赛", home: "葡萄牙", away: "西班牙", latest: {}, opening: {} },
  { id: "2", matchnum: "1014", date: "2026-06-09", matchtime: "03:00", league: "国际赛", home: "A", away: "B", latest: {}, opening: {} },
  { id: "3", matchnum: "1015", date: "2026-06-09", matchtime: "03:00", league: "国际赛", home: "C", away: "D", latest: {}, opening: {} },
  { id: "4", matchnum: "1016", date: "2026-06-09", matchtime: "03:00", league: "国际赛", home: "E", away: "F", latest: {}, opening: {} },
  { id: "5", matchnum: "4001", date: "2026-06-12", matchtime: "03:00", league: "世界杯", home: "墨西哥", away: "南非", latest: {}, opening: {} },
  { id: "6", matchnum: "4002", date: "2026-06-12", matchtime: "10:00", league: "世界杯", home: "韩国", away: "捷克", latest: {}, opening: {} },
  { id: "7", matchnum: "6006", date: "2026-06-14", matchtime: "23:00", league: "世界杯", home: "G", away: "H", latest: {}, opening: {} },
  { id: "8", matchnum: "3024", date: "2026-06-18", matchtime: "23:00", league: "世界杯", home: "I", away: "J", latest: {}, opening: {} },
];

test("selectInSale 含世界杯单场 4001 墨西哥vs南非(不再被系列锚定丢弃)", () => {
  const out = selectInSale(FEED, "2026-06-08");
  const wc = out.find((m) => m.matchnum === "4001");
  assert.ok(wc, "应包含 matchnum=4001 的世界杯单场");
  assert.equal(wc.league, "世界杯");
  assert.equal(wc.home, "墨西哥");
  assert.equal(wc.away, "南非");
});

test("selectInSale 多系列纳入但限开赛窗口(业务日+4天):近场+最近WC比赛日,远期预售剔除", () => {
  // 业务日 06-08,窗口 ≤06-12:6/09 国际赛 4 场 + 6/12 世界杯单场 2 场 = 6 场;6/14/6/18 远期预售剔除。
  // (旧"抓全"会返回 8 场把整届预售堆进当日;旧"单批锚定"只 4 场漏掉世界杯单场——本断言钉死折中:窗口化)
  const out = selectInSale(FEED, "2026-06-08");
  assert.equal(out.length, 6, `窗口内应纳入 6 场(6/09×4 + 6/12×2),实得 ${out.length}`);
  // 跨系列纳入:含最近世界杯单场 4001/4002(用户"还有2")
  assert.ok(out.some((m) => m.matchnum === "4001"), "应含 6/12 世界杯单场 4001");
  assert.ok(out.some((m) => m.matchnum === "4002"), "应含 6/12 世界杯单场 4002");
  // 远期预售(6/14 6006 / 6/18 3024)在窗口外,不堆进当日推荐
  assert.ok(!out.some((m) => m.matchnum === "6006"), "6/14 远期预售应被窗口剔除");
  assert.ok(!out.some((m) => m.matchnum === "3024"), "6/18 远期预售应被窗口剔除");
});

test("selectInSale 开赛窗口可配置:horizonDays 放大则纳入更多预售", () => {
  // horizon=10(≤06-18)→ 8 场全纳入;horizon=0(仅业务日当天)→ FEED 无 06-08 场=0
  assert.equal(selectInSale(FEED, "2026-06-08", 10).length, 8, "窗口放大到10天纳入全部8场");
  assert.equal(selectInSale(FEED, "2026-06-08", 0).length, 0, "窗口=0只当天,FEED无06-08场");
  // 默认窗口(4)= 6 场(回归锁)
  assert.equal(selectInSale(FEED, "2026-06-08").length, 6, "默认窗口4天=6场");
});

test("selectInSale 剔除赛日严格早于业务日的场(已结束),保留当日+未来预售", () => {
  const feed = [
    { matchnum: "9001", date: "2026-06-05", home: "已结束", away: "X" },     // 早于业务日 → 剔
    { matchnum: "9002", date: "2026-06-08", home: "当日", away: "Y" },        // 当日 → 留
    { matchnum: "9003", date: "2026-06-12", home: "预售", away: "Z" },        // 未来 → 留
  ];
  const out = selectInSale(feed, "2026-06-08");
  assert.equal(out.length, 2);
  assert.ok(!out.some((m) => m.home === "已结束"));
  assert.ok(out.some((m) => m.home === "当日"));
  assert.ok(out.some((m) => m.home === "预售"));
});

test("selectInSale 缺 m.date 的场保留(不因缺日期丢场)", () => {
  const feed = [{ matchnum: "1", home: "无日期", away: "X" }];
  const out = selectInSale(feed, "2026-06-08");
  assert.equal(out.length, 1);
});

test("selectInSale 当日有真实赛日时维持纳入(无回归),且其它预售场也纳入", () => {
  const feed = [
    { matchnum: "1001", date: "2026-06-08", home: "当日主", away: "当日客" },
    { matchnum: "4001", date: "2026-06-12", home: "墨西哥", away: "南非" },
  ];
  const out = selectInSale(feed, "2026-06-08");
  assert.equal(out.length, 2, "当日场 + 预售场都纳入");
  assert.ok(out.some((m) => m.home === "当日主"));
  assert.ok(out.some((m) => m.matchnum === "4001"));
});
