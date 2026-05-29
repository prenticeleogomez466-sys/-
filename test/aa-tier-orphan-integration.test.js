import assert from "node:assert/strict";
import test from "node:test";
import { collectFusionEvidence, fuseSignals } from "../src/signal-fusion-layer.js";
import { homeAwaySplitToLR, splitStats } from "../src/home-away-split-stats.js";
import { recentMatchesFor } from "../src/fusion-context-builder.js";

// 构造近期赛果(带 venue);最近在前
function recent(venuesWins) {
  return venuesWins.map(([venue, won], i) => ({
    date: `2024-1${i}-01`, venue,
    goalsFor: won === "W" ? 2 : won === "D" ? 1 : 0,
    goalsAgainst: won === "W" ? 0 : won === "D" ? 1 : 2,
    won
  }));
}

test("recentMatchesFor 带 venue 标签", () => {
  const history = [
    { date: "2024-01-01", homeTeam: "甲", awayTeam: "乙", homeCanon: "甲", awayCanon: "乙", homeGoals: 2, awayGoals: 0 },
    { date: "2024-02-01", homeTeam: "丙", awayTeam: "甲", homeCanon: "丙", awayCanon: "甲", homeGoals: 1, awayGoals: 1 }
  ];
  const r = recentMatchesFor(history, "甲", 10);
  assert.equal(r.length, 2);
  const home = r.find((m) => m.date === "2024-01-01");
  const away = r.find((m) => m.date === "2024-02-01");
  assert.equal(home.venue, "home");
  assert.equal(away.venue, "away");
});

test("homeAwaySplitToLR 主场强+客队客场弱 → 抬主胜", () => {
  const homeSplit = splitStats(recent([["home", "W"], ["home", "W"], ["home", "W"], ["away", "L"]]));
  const awaySplit = splitStats(recent([["away", "L"], ["away", "L"], ["away", "L"], ["home", "W"]]));
  const lr = homeAwaySplitToLR(homeSplit, awaySplit);
  assert.ok(lr, "应产 LR");
  assert.ok(lr.home > 1, "主胜 LR > 1");
  assert.ok(lr.away < 1, "客胜 LR < 1");
  assert.equal(lr.draw, 1);
});

test("homeAwaySplitToLR 样本不足/均衡时休眠(null)", () => {
  const thin = splitStats(recent([["home", "W"]]));
  assert.equal(homeAwaySplitToLR(thin, thin), null, "样本 <3 休眠");
  const balanced = splitStats(recent([["home", "W"], ["home", "D"], ["home", "L"], ["away", "W"], ["away", "D"], ["away", "L"]]));
  assert.equal(homeAwaySplitToLR(balanced, balanced), null, "净差 <0.3 休眠");
});

test("home-away-split 信号在 fusion 中真 fire 并改变概率", () => {
  const context = {
    homeRecentMatches: recent([["home", "W"], ["home", "W"], ["home", "W"], ["home", "W"], ["away", "L"]]),
    awayRecentMatches: recent([["away", "L"], ["away", "L"], ["away", "L"], ["away", "L"], ["home", "W"]])
  };
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const { evidence } = collectFusionEvidence(prior, { homeTeam: "甲", awayTeam: "乙" }, {}, context);
  const split = evidence.find((e) => e.name === "home-away-split");
  assert.ok(split, "home-away-split 应进 fired 列表");
  const fusion = fuseSignals(prior, { homeTeam: "甲", awayTeam: "乙" }, {}, context);
  assert.equal(fusion.applied, true);
  assert.ok(fusion.probabilities.home > prior.home, "主场强应抬升主胜概率");
});

test("home-away-split 无近期赛果时休眠不报错", () => {
  const { dormant } = collectFusionEvidence({ home: 0.4, draw: 0.3, away: 0.3 }, { homeTeam: "甲", awayTeam: "乙" }, {}, {});
  const split = dormant.find((d) => d.name === "home-away-split");
  assert.ok(split, "应在 dormant 列表");
  assert.equal(split.dormant, "no-recent-match-history");
});
