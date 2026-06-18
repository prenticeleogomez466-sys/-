import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handicapResultBand, htResultBand, teamGoalsBand, htGoalsBand, anomalyVs, depthBin,
  handicapResultReferenceRows, extendedDepthReferenceRows,
} from "../src/extended-market-bands.js";
import { buildHandicapSanitySheet } from "../src/today-delivery-lib.js";
import { handicapSanity } from "../src/handicap-sanity.js";

const flat = (sh) => sh.rows.map((r) => (Array.isArray(r) ? r.join(" ") : String(r))).join("\n");

describe("扩展玩法历史区间(真实赛果频次·12458场)", () => {
  it("让球胜负平按竞彩整数线取频次(主让1=真实频次)", () => {
    const b = handicapResultBand(-1);
    assert.ok(b && b.homeWin > 25 && b.homeWin < 40 && b.n > 1000);
    assert.equal(handicapResultBand(-1.25)?.homeWin, b.homeWin); // 四舍五入到 -1
  });
  it("强度档分箱 + 半场/分队进球/半场进球频次单调合理", () => {
    assert.equal(depthBin(-1.0), "1");
    assert.equal(depthBin(0.4), "0.5");
    // 强度越高半场热门胜率越高、分队热门进球越多
    assert.ok(htResultBand(-2)?.favWin > htResultBand(0)?.favWin);
    assert.ok(teamGoalsBand(-2)?.favOver15 > teamGoalsBand(0)?.favOver15);
    assert.ok(htGoalsBand(-2)?.over05 > htGoalsBand(0)?.over05);
  });
  it("anomalyVs:偏离≥8pp=异动·<4pp=常态", () => {
    assert.equal(anomalyVs(50, 40).tag, "🟠异动");
    assert.equal(anomalyVs(41, 40).tag, "🟢常态");
    assert.equal(anomalyVs(45, 40).tag, "🟡偏离");
    assert.equal(anomalyVs(50, null).deltaPp, null);
  });
  it("参照表行宽合理(扩展强度档=7列与主体同宽)", () => {
    assert.equal(extendedDepthReferenceRows()[0].length, 7);
    assert.ok(handicapResultReferenceRows().length > 3);
  });
});

describe("盘口合理性 sheet 新增维度(让球胜负平区间+分队进球+半场胜负平+半场进球)", () => {
  const rows = [{
    match: "法国 vs 塞内加尔", favProbSource: "盘口",
    sanity: handicapSanity({ ahLine: -1, p1x2Fav: 0.62 }),
    sanityOdds: {
      euro: { home: 1.55, draw: 3.9, away: 6.0 }, hcp: { home: 2.0, draw: 3.3, away: 3.4 },
      jcLine: -1, ahLine: -1, anchorLine: -1, anchorIsAsian: true, over25: 0.55, under25: 0.45,
      htResult: { home: 0.40, draw: 0.42, away: 0.18 },
      ext: { firstHalf: { home: 0.41, draw: 0.41, away: 0.18, over05: 0.72, over15: 0.36 },
             teamGoals: { home: { over05: 0.85, over15: 0.55, over25: 0.27 }, away: { over05: 0.6, over15: 0.24 } } },
    },
  }];
  const t = flat(buildHandicapSanitySheet({ date: "2026-06-18", rows }));
  it("让球胜负平有历史频次区间(不再'暂无独立历史区间')", () => {
    assert.match(t, /让球胜负平.*亚洲让球/);
    assert.match(t, /历史 让球主胜.*%\/平.*%\/客胜.*%/);
    assert.doesNotMatch(t, /让球盘暂无独立历史区间/);
  });
  it("含分队进球数/半场胜负平/半场进球数 + 异动判读", () => {
    assert.match(t, /主队进球≥2/); assert.match(t, /客队进球≥2/);
    assert.match(t, /半场胜负平.*实测/);   // htResult 在→标✅实测
    assert.match(t, /半场进球数/);
    assert.match(t, /🟠异动|🟡偏离|🟢常态/);
  });
  it("底部含让球胜负平 + 扩展强度档历史参照表", () => {
    assert.match(t, /让球胜负平 历史频次区间/);
    assert.match(t, /半场胜负平\/半场进球\/分队进球 历史频次区间/);
  });
  it("sheet 最大列宽仍=7(writer 列头识别不被参照表撑破)", () => {
    const sh = buildHandicapSanitySheet({ date: "2026-06-18", rows });
    assert.equal(Math.max(...sh.rows.map((r) => r.length)), 7);
  });
});
