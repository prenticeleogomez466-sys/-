// 守护:全网赛前情报(web-intel)接入 buildMatchIntel —— 伤停优先 web、扩展维度落 intel.web。
// 背景(2026-06-14 用户裁决:情报必须全覆盖,去全网收集真实资料):免费结构化伤停源对国家队=空墙,
//   改走全网媒体核录(中文+来源URL),展示层不进概率;此测试钉死接线不回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatchIntel, resolveWebInjuries, INTEL_TAG } from "../src/match-intel.js";

const web = {
  injuries: [
    { team: "德国", name: "格纳布里", status: "赛前伤缺", certain: true },
    { team: "库拉索", name: "全队", status: "无伤停", certain: true },
  ],
  h2h: "史上首次交锋",
  group: "E组开门战",
  style: "德国控球 vs 库拉索防反",
  venue: "休斯顿 NRG Stadium(室内)",
  news: "德国9连胜冲头名",
  sources: ["https://example.com/a", "https://example.com/b"],
};

test("resolveWebInjuries:中文+来源标注,标 ✅实测", () => {
  const r = resolveWebInjuries(web.injuries, web.sources);
  assert.equal(r.tag, INTEL_TAG.REAL);
  assert.equal(r.count, 2);
  assert.match(r.text, /德国:格纳布里/);
  assert.match(r.text, /来源:2处赛前媒体/);
});

test("resolveWebInjuries:空 → null(标缺不编)", () => {
  assert.equal(resolveWebInjuries([], []), null);
  assert.equal(resolveWebInjuries(null), null);
});

test("buildMatchIntel:有 webIntel → 伤停走 web、扩展维度落 intel.web", () => {
  const it = buildMatchIntel({ fixture: { homeTeam: "德国", awayTeam: "库拉索" }, webIntel: web });
  assert.equal(it.injuries.tag, INTEL_TAG.REAL);
  assert.match(it.injuries.text, /格纳布里/);
  assert.equal(it.web.h2h, "史上首次交锋");
  assert.equal(it.web.venue, "休斯顿 NRG Stadium(室内)");
  assert.deepEqual(it.web.sources, web.sources);
  assert.equal(it.news.tag, INTEL_TAG.INFER); // web 新闻=🔶含分析
  assert.ok(it.maturity >= 1); // 伤停 REAL 计入成熟度
});

test("buildMatchIntel:无 webIntel → intel.web=null,伤停退回采集层(向后兼容)", () => {
  const it = buildMatchIntel({ fixture: { homeTeam: "A", awayTeam: "B" } });
  assert.equal(it.web, null);
  assert.equal(it.injuries.tag, INTEL_TAG.MISS); // 无采集层 → 标缺
});
