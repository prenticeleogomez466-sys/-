import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeUnderstatVar, teamRecentXg, fixtureXgEstimate,
  buildXgLayerFromUnderstat, matchXgFromShots, matchXgFromDates
} from "../src/understat-source.js";

test("decodeUnderstatVar 解码内嵌 \\xHH 转义的 JSON", () => {
  // 模拟 Understat 内嵌:var teamsData = JSON.parse('\x7B...') —— 这里用真实十六进制转义串
  const obj = { "1": { id: "1", title: "Arsenal", history: [{ date: "2024-03-01", xG: "1.8", xGA: "0.6" }] } };
  // 构造 \xHH 转义串(模拟页面)
  const esc = JSON.stringify(obj).replace(/[^\x20-\x7E]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"))
    .replace(/(["\\])/g, (m) => "\\x" + m.charCodeAt(0).toString(16).padStart(2, "0"));
  const html = `<script>var teamsData = JSON.parse('${esc}');</script>`;
  const decoded = decodeUnderstatVar(html, "teamsData");
  assert.ok(decoded, "应解出对象");
  assert.equal(decoded["1"].title, "Arsenal");
  assert.equal(decodeUnderstatVar("<html>无数据</html>", "teamsData"), null);
});

const TEAMS = {
  "1": { title: "Arsenal", history: [
    { date: "2024-02-01", xG: "2.0", xGA: "0.5" },
    { date: "2024-02-10", xG: "1.6", xGA: "0.9" },
    { date: "2024-02-20", xG: "1.8", xGA: "0.7" },
  ] },
  "2": { title: "Chelsea", history: [
    { date: "2024-02-05", xG: "1.0", xGA: "1.4" },
    { date: "2024-02-15", xG: "1.2", xGA: "1.6" },
  ] },
};

test("teamRecentXg 近 n 场均值 + 防泄漏 beforeDate", () => {
  const r = teamRecentXg(TEAMS, "Arsenal", { n: 6 });
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.xgFor - (2.0 + 1.6 + 1.8) / 3) < 1e-9);
  // beforeDate 只取早于的场
  const r2 = teamRecentXg(TEAMS, "Arsenal", { beforeDate: "2024-02-15" });
  assert.equal(r2.n, 2, "只剩 02-01 和 02-10");
  assert.equal(teamRecentXg(TEAMS, "不存在的队"), null);
});

test("fixtureXgEstimate 双方近期 xG → 前瞻 λ,主场乘子生效", () => {
  const est = fixtureXgEstimate(TEAMS, "Arsenal", "Chelsea");
  assert.ok(est.home > 0 && est.away > 0);
  // 主队强攻弱防 + 客队弱 → home λ 应明显高于 away λ
  assert.ok(est.home > est.away, "阿森纳主场期望应更高");
  assert.deepEqual(est.samples, { home: 3, away: 2 });
  // 缺一队数据 → null
  assert.equal(fixtureXgEstimate(TEAMS, "Arsenal", "未知队"), null);
});

test("buildXgLayerFromUnderstat 装 xg 层(只覆盖匹配上的场)", () => {
  const fixtures = [
    { id: "f1", homeTeam: "Arsenal", awayTeam: "Chelsea" },
    { id: "f2", homeTeam: "未知A", awayTeam: "未知B" },
  ];
  const { byFixtureId, matched } = buildXgLayerFromUnderstat(fixtures, TEAMS);
  assert.equal(matched, 1);
  assert.ok(byFixtureId.f1);
  assert.equal(byFixtureId.f1.source, "understat");
  assert.equal(byFixtureId.f1.proxy, false);
  assert.equal(byFixtureId.f2, undefined);
});

test("matchXgFromShots / matchXgFromDates 取赛果级真 xG", () => {
  const shots = { h: [{ xG: "0.5" }, { xG: "0.3" }], a: [{ xG: "0.1" }] };
  assert.deepEqual(matchXgFromShots(shots), { home: 0.8, away: 0.1 });
  assert.equal(matchXgFromShots(null), null);

  const dates = [{ isResult: true, h: { title: "Arsenal" }, a: { title: "Chelsea" }, goals: { h: "2", a: "1" }, xG: { h: "1.9", a: "0.7" } }];
  const mx = matchXgFromDates(dates, "Arsenal", "Chelsea");
  assert.equal(mx.home, 1.9);
  assert.equal(mx.goals.home, 2);
  assert.equal(matchXgFromDates(dates, "Chelsea", "Arsenal"), null, "主客反了不匹配");
});
