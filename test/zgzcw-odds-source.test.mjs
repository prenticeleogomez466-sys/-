import { test } from "node:test";
import assert from "node:assert/strict";
import { parseZgzcwBjop, zgzcwImpliedProbs, buildZgzcwSnapshot, crossValidateZgzcw } from "../src/zgzcw-odds-source.js";

// 仿真 zgzcw bjop 页"平均欧赔"行(data= 属性按序:即时主/平/客 + 初盘主/平/客)+ 离散度文本
const sampleHtml = `
<table><tr class="" firsttime="2026-05-30 14:40:14" lasttime="1780557855000">
  <td class="border-r"><label><input type="checkbox"/> 1</label></td>
  <td data="0" class="border-r border-l">平均欧赔</td>
  <td data="1.30" class="#1 border-l">1.30</td>
  <td data="4.63" class="#1">4.63</td>
  <td data="10.28" class="#1 border-r">10.28</td>
  <td data="1.36" class="#2 border-l"><a href="/x">1.36</a></td>
  <td data="4.40" class="#2"><a>4.40</a></td>
  <td data="8.26" class="#2"><a>8.26</a></td>
</tr></table>
<div>离散度 2.90&nbsp;23.65&nbsp;83.48 | 中足网方差 ...</div>`;

test("parseZgzcwBjop 取百家共识即时+初盘+离散度", () => {
  const r = parseZgzcwBjop(sampleHtml);
  assert.equal(r.ok, true);
  assert.deepEqual(r.consensus.current, { home: 1.30, draw: 4.63, away: 10.28 });
  assert.deepEqual(r.consensus.initial, { home: 1.36, draw: 4.40, away: 8.26 });
  assert.deepEqual(r.dispersion, { home: 2.90, draw: 23.65, away: 83.48 });
});

test("parseZgzcwBjop 无平均欧赔 → ok:false", () => {
  assert.equal(parseZgzcwBjop("<html>无数据</html>").ok, false);
  assert.equal(parseZgzcwBjop(null).ok, false);
});

test("zgzcwImpliedProbs 去vig归一,和为1", () => {
  const p = zgzcwImpliedProbs({ home: 1.30, draw: 4.63, away: 10.28 });
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(p.home > 0.70 && p.home < 0.72); // 主队大热
  assert.ok(p.overround > 0.07 && p.overround < 0.09); // ~8% 抽水
});

test("buildZgzcwSnapshot 行+解析 → 市场快照(european initial/current + source)", () => {
  const parsed = parseZgzcwBjop(sampleHtml);
  const row = { home: "瑞典", away: "希腊", league: "国际友谊", seq: "周四202", dateIso: "2026-06-05" };
  const snap = buildZgzcwSnapshot(row, parsed, "2026-06-05");
  assert.equal(snap.homeTeam, "瑞典");
  assert.equal(snap.source, "zgzcw-百家欧赔");
  assert.equal(snap.date, "2026-06-05");
  assert.deepEqual(snap.europeanOdds.current, { home: 1.30, draw: 4.63, away: 10.28 });
  assert.deepEqual(snap.europeanOdds.initial, { home: 1.36, draw: 4.40, away: 8.26 });
  assert.deepEqual(snap.dispersion, { home: 2.90, draw: 23.65, away: 83.48 });
});

test("buildZgzcwSnapshot 解析失败 → null", () => {
  assert.equal(buildZgzcwSnapshot({ home: "A", away: "B" }, { ok: false }, "2026-06-05"), null);
});

test("crossValidateZgzcw 一致/分歧判定", () => {
  const base = { home: 0.71, draw: 0.20, away: 0.09 };
  assert.equal(crossValidateZgzcw(base, { home: 0.70, draw: 0.21, away: 0.09 }).agree, true);
  const div = crossValidateZgzcw(base, { home: 0.60, draw: 0.25, away: 0.15 });
  assert.equal(div.divergent, true);
  assert.equal(div.biggestLeg, "home");
  assert.ok(div.maxAbsDiff >= 0.06);
  assert.equal(crossValidateZgzcw(base, null), null);
});
