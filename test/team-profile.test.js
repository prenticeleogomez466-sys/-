import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeProfiles, homeAwayEdge } from "../src/team-profile.js";

describe("球队画像(computeProfiles)—— 攻防/主客场/状态", () => {
  const matches = [
    { home: "甲", away: "乙", hg: 2, ag: 0, date: "2026-01-01" }, // 甲主胜
    { home: "甲", away: "丙", hg: 3, ag: 1, date: "2026-01-08" }, // 甲主胜
    { home: "乙", away: "甲", hg: 1, ag: 1, date: "2026-01-15" }, // 甲客平
    { home: "丙", away: "甲", hg: 2, ag: 1, date: "2026-01-22" }, // 甲客负
    { home: "甲", away: "乙", hg: 1, ag: 1, date: "2026-01-29" }, // 甲主平
    { home: "甲", away: "丙", hg: 0, ag: 0, date: "2026-02-05" }, // 甲主平
  ];
  it("综合/攻/防 + 主客场分拆正确", () => {
    const p = computeProfiles(matches, { minGames: 3 });
    const 甲 = p.get("甲");
    assert.ok(甲);
    assert.equal(甲.gp, 6);
    // 主场4场:2胜2平=8分→2.0;客场2场:1平1负=1分→0.5
    assert.equal(甲.homePpg, 2.0);
    assert.equal(甲.awayPpg, 0.5);
    assert.equal(甲.homeN, 4);
    assert.equal(甲.last5.length, 5);
  });
  it("样本不足的队→标缺(不进Map,不臆造)", () => {
    const p = computeProfiles(matches, { minGames: 10 });
    assert.equal(p.get("甲"), undefined);
  });
});

describe("主客场情景(homeAwayEdge)—— 市场存疑识别", () => {
  it("主队主场强势 vs 客队客场弱 → marketWatch=true", () => {
    const e = homeAwayEdge({ homePpg: 2.41 }, { awayPpg: 1.44 });
    assert.ok(e.homeEdge >= 0.6);
    assert.equal(e.marketWatch, true);
    assert.match(e.note, /主队主场强势/);
  });
  it("接近 → marketWatch=false", () => {
    const e = homeAwayEdge({ homePpg: 1.3 }, { awayPpg: 1.1 });
    assert.equal(e.marketWatch, false);
  });
  it("缺数据 → null / 样本不足", () => {
    assert.equal(homeAwayEdge(null, null), null);
    assert.equal(homeAwayEdge({ homePpg: 2 }, {}).marketWatch, false);
  });
});
