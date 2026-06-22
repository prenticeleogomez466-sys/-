// 四玩法独立真实裁决(2026-06-11 用户裁决"方向都一样太假了"):
// 比分/半全场主推=各自500盘口de-vig真实热门(可与胜负平不同向,必带依据);信号面板=实抓证据拼装;
// 方向矩阵审计=不同向无依据必FAIL(拒交付)。绝不人造分歧:盘口真同向标"共振"。
import test from "node:test";
import assert from "node:assert/strict";
import { marketScoreView, marketHalfFullView, buildSignalPanel, directionMatrixAudit } from "../src/today-delivery-lib.js";

test("marketScoreView:比分盘热门=平局1-1而胜负平=主胜 → 主推1-1+不同向标注+依据", () => {
  const p = {
    pick: { code: "3" },
    scorePicks: { marketDistribution: [
      { score: "1-1", probability: 0.13 }, { score: "1-0", probability: 0.11 }, { score: "0-1", probability: 0.10 },
    ] },
  };
  const v = marketScoreView(p);
  assert.equal(v.fromMarket, true);
  assert.equal(v.dir, "1");
  assert.equal(v.sameAsWld, false);
  assert.match(v.cell, /盘口主推 1-1\(13%\)/);
  // 2026-06-22 修「说胜却推荐1-1」:不同向时须诠释"非矛盾"+给顺胜负平方向的比分(此处主胜格=1-0)
  assert.match(v.cell, /不是矛盾/);
  assert.match(v.cell, /单一最可能比分/);
  assert.match(v.cell, /顺主胜方向买比分→选 1-0/);
  assert.equal(v.sameDirScore, "1-0");
  assert.match(v.basis, /500比分盘/);
});

test("marketScoreView:盘口热门与胜负平同向 → 标'同向共振'不标分歧;无盘口 → 诚实退模型", () => {
  const same = marketScoreView({ pick: { code: "3" }, scorePicks: { marketDistribution: [{ score: "2-0", probability: 0.18 }] } });
  assert.equal(same.sameAsWld, true);
  assert.match(same.cell, /同向共振/);
  assert.doesNotMatch(same.cell, /不同向/);
  const none = marketScoreView({ pick: { code: "3" }, scorePicks: {} });
  assert.equal(none.fromMarket, false);
  assert.match(none.basis, /未开售|弃用/);
});

test("marketHalfFullView:半全场盘热门终场=客胜而胜负平=主胜 → 不同向有据;同向 → 共振", () => {
  const div = marketHalfFullView({ pick: { code: "3" }, halfFullPicks: { marketDistribution: [{ halfFull: "客胜-客胜", probability: 0.21 }] } });
  assert.equal(div.dir, "0");
  assert.equal(div.sameAsWld, false);
  assert.match(div.cell, /不是矛盾/);
  assert.match(div.cell, /单一最可能半全场/);
  const same = marketHalfFullView({ pick: { code: "0" }, halfFullPicks: { marketDistribution: [{ halfFull: "平局-客胜", probability: 0.17 }] } });
  assert.equal(same.sameAsWld, true);
});

test("buildSignalPanel:欧赔热门主胜+让球盘资金偏客 → '赢球与过盘分离';全同侧 → 三盘共振;缺源标⚠️", () => {
  const split = buildSignalPanel({
    euroCur: { home: 1.5, draw: 4.0, away: 6.0 }, euroIni: { home: 1.6, draw: 3.9, away: 5.8 },
    asian: { line: "-1", openLine: "-0.75", homeOdds: 2.05, awayOdds: 1.75 },
    hcDist: { home: 0.39, push: 0.18, away: 0.43 },
  });
  assert.match(split.text, /欧赔:热门=主胜·热门主胜水位压入\(1\.6→1\.5/);
  assert.match(split.text, /开-0\.75→现-1·盘口异动/);
  assert.match(split.text, /盘口信号分歧:欧赔热门=主 \/ 亚盘水位偏客 \/ 让球盘资金偏客/);
  const res = buildSignalPanel({
    euroCur: { home: 1.5, draw: 4.0, away: 6.0 }, euroIni: null,
    asian: { line: "-1", openLine: "-1", homeOdds: 1.75, awayOdds: 2.05 },
    hcDist: { home: 0.55, push: 0.18, away: 0.27 },
  });
  assert.match(res.text, /三盘共振主胜/);
  const miss = buildSignalPanel({ euroCur: null, euroIni: null, asian: null, hcDist: null });
  assert.match(miss.text, /欧赔:⚠️未开售/);
  assert.match(miss.text, /亚盘:⚠️未取到/);
  assert.match(miss.text, /阵容:⚠️未公布/);
});

test("directionMatrixAudit:不同向带依据=ok;不同向无依据=FAIL(拒交付闸)", () => {
  const ok = directionMatrixAudit([{ match: "A vs B", wldLabel: "主胜", markets: [
    { name: "比分", dirLabel: "平局", sameAsWld: false, basis: "500比分盘de-vig真实众数" },
  ] }]);
  assert.equal(ok.ok, true);
  assert.match(ok.lines[0], /比分=平局\(不同向·依据:500比分盘/);
  const bad = directionMatrixAudit([{ match: "A vs B", wldLabel: "主胜", markets: [
    { name: "半全场", dirLabel: "客胜", sameAsWld: false, basis: "" },
  ] }]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /无依据/);
});
