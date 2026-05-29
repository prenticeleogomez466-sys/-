import assert from "node:assert/strict";
import test from "node:test";
import { collectFusionEvidence, fuseSignals } from "../src/signal-fusion-layer.js";
import { homeAwaySplitToLR, splitStats } from "../src/home-away-split-stats.js";
import { recentMatchesFor } from "../src/fusion-context-builder.js";
import { buildFourteenPlan } from "../src/prediction-engine.js";

// 合成一条 prediction(只给 buildFourteenPlan 用到的字段)
function pred({ id, home, away, comp, date, pickCode, pickProb, secProb, conf, risk = "中", quality = 70 }) {
  return {
    fixture: { id, homeTeam: home, awayTeam: away, competition: comp, date, marketType: "shengfucai", tags: ["14场胜负彩"] },
    pick: { code: pickCode, label: "主胜", probability: pickProb },
    secondaryPick: { code: "1", label: "平局", probability: secProb },
    confidence: conf,
    risk,
    advancedFeatures: { quality: { score: quality } },
    rationale: "test"
  };
}

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

test("buildFourteenPlan 接入串关相关性:多胆腿产联合命中率(独立+修正)", () => {
  // 4 场强胆,2 场同英超(同 outcome 正相关),应产 bankerParlay
  const predictions = [
    pred({ id: "f1", home: "曼城", away: "伯恩利", comp: "英超", date: "2026-06-01", pickCode: "3", pickProb: 0.78, secProb: 0.14, conf: 80 }),
    pred({ id: "f2", home: "拜仁", away: "波鸿", comp: "德甲", date: "2026-06-01", pickCode: "3", pickProb: 0.75, secProb: 0.16, conf: 78 }),
    pred({ id: "f3", home: "利物浦", away: "卢顿", comp: "英超", date: "2026-06-01", pickCode: "3", pickProb: 0.74, secProb: 0.17, conf: 76 }),
    pred({ id: "f4", home: "皇马", away: "赫罗纳", comp: "西甲", date: "2026-06-01", pickCode: "3", pickProb: 0.72, secProb: 0.18, conf: 75 })
  ];
  const plan = buildFourteenPlan(predictions);
  assert.ok(plan.bankerParlay, "应带 bankerParlay 字段");
  assert.equal(plan.bankerParlay.ok, true, "≥2 胆腿应可算");
  assert.ok(plan.bankerParlay.legs >= 2, "至少 2 条胆腿");
  assert.ok(plan.bankerParlay.jointProbabilityIndependent > 0, "独立联合概率 > 0");
  assert.ok(plan.bankerParlay.correlations.length >= 1, "同英超同向应检出正相关");
  // 修正后的联合概率应与独立估计不同(被相关性调整)
  assert.notEqual(plan.bankerParlay.jointProbabilityCorrelated, plan.bankerParlay.jointProbabilityIndependent);
});

test("buildFourteenPlan 胆腿不足时 bankerParlay 安全返回 ok:false", () => {
  const predictions = [
    pred({ id: "g1", home: "曼城", away: "伯恩利", comp: "英超", date: "2026-06-01", pickCode: "3", pickProb: 0.5, secProb: 0.3, conf: 50, quality: 40 })
  ];
  const plan = buildFourteenPlan(predictions);
  assert.equal(plan.bankerParlay.ok, false, "0~1 胆腿无法串关");
});
