import assert from "node:assert/strict";
import test from "node:test";
import { collectFusionEvidence, fuseSignals } from "../src/signal-fusion-layer.js";
import { homeAwaySplitToLR, splitStats } from "../src/home-away-split-stats.js";
import { recentMatchesFor } from "../src/fusion-context-builder.js";
import { buildFourteenPlan } from "../src/prediction-engine.js";
import { enrichLedgerRow, summarizeLedgerCLV } from "../src/clv-tracker.js";

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

test("enrichLedgerRow 附 CLV 字段并尊重 measured 标记", () => {
  // 下注价 2.10 → 收盘 1.95(庄家压低=抓到 sharp 价)= 正 CLV
  const row = { match: "甲 对 乙", primaryOdds: 2.10 };
  const enriched = enrichLedgerRow(row, 1.95, { measured: true });
  assert.ok(enriched.clv > 0, "收盘<下注 → 正 CLV");
  assert.equal(enriched.clvVerdict, "strong-positive");
  assert.equal(enriched.clvMeasured, true);
  assert.equal(enriched.closingOdds, 1.95);
  // measured:false(单次捕获)仍写字段但不计统计
  const unmeasured = enrichLedgerRow(row, 1.95, { measured: false });
  assert.equal(unmeasured.clvMeasured, false);
  // 无 primaryOdds → 原样返回
  assert.deepEqual(enrichLedgerRow({ match: "x" }, 1.95), { match: "x" });
});

test("summarizeLedgerCLV 只统计 measured 行,正 CLV 多数 → 长期盈利信号", () => {
  const rows = [
    { clv: 0.05, clvMeasured: true },
    { clv: 0.04, clvMeasured: true },
    { clv: 0.02, clvMeasured: true },
    { clv: -0.01, clvMeasured: true },
    { clv: 0.99, clvMeasured: false } // 未测,应被忽略
  ];
  const s = summarizeLedgerCLV(rows);
  assert.equal(s.ok, true);
  assert.equal(s.samples, 4, "只数 measured");
  assert.ok(s.avgCLV > 0);
  assert.equal(s.positiveRate, 0.75, "4 条里 3 条正");
  assert.equal(s.longTermProfitable, true, "avg>0 且 正率≥0.55");
});

test("summarizeLedgerCLV 无可测行时诚实返回 measurable:false(不误报亏损)", () => {
  const s = summarizeLedgerCLV([{ clv: 0, clvMeasured: false }, { hit: true }]);
  assert.equal(s.ok, false);
  assert.equal(s.measurable, false);
  assert.match(s.verdict, /暂无可测 CLV/);
});

// ---- time-decay-form 信号接入(孤儿模块 time-decay-weighting)----
import { timeDecayFormToLR } from "../src/time-decay-weighting.js";

// 造一串离参考日很近的比赛(ESS 高),结果按 W/D/L 指定
function recentForm(results, refDate = "2026-05-20") {
  const base = Date.parse(refDate);
  return results.map((won, i) => ({
    date: new Date(base - (i + 1) * 5 * 86400000).toISOString().slice(0, 10),
    venue: i % 2 ? "away" : "home",
    goalsFor: won === "W" ? 2 : won === "D" ? 1 : 0,
    goalsAgainst: won === "L" ? 2 : won === "D" ? 1 : 0,
    won
  }));
}

test("timeDecayFormToLR:主强客弱近期 form → 朝主队 LR>1,对称 away<1", () => {
  const homeM = recentForm(["W", "W", "W", "D", "W"]);
  const awayM = recentForm(["L", "L", "D", "L", "L"]);
  const lr = timeDecayFormToLR(homeM, awayM, { referenceDate: "2026-05-22" });
  assert.ok(lr && lr.home > 1, "主队近期更强 → home LR>1");
  assert.ok(lr.away < 1, "对称压低 away");
  assert.equal(lr.draw, 1);
});

test("timeDecayFormToLR:净差不足时休眠返回 null", () => {
  const homeM = recentForm(["W", "D", "L", "W", "D"]);
  const awayM = recentForm(["W", "D", "L", "W", "D"]);
  assert.equal(timeDecayFormToLR(homeM, awayM, { referenceDate: "2026-05-22" }), null);
});

test("timeDecayFormToLR:有效样本太薄(单场)时休眠", () => {
  assert.equal(timeDecayFormToLR(recentForm(["W"]), recentForm(["L"]), { referenceDate: "2026-05-22" }), null);
});

test("signalTimeDecayForm 经融合层真 fire(出现在 evidence 里)", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fixture = { homeTeam: "甲", awayTeam: "乙", date: "2026-05-22" };
  const context = {
    homeRecentMatches: recentForm(["W", "W", "W", "D", "W"]),
    awayRecentMatches: recentForm(["L", "L", "D", "L", "L"])
  };
  const { evidence } = collectFusionEvidence(prior, fixture, {}, context);
  const hit = evidence.find((e) => e.name === "time-decay-form");
  assert.ok(hit, "time-decay-form 应进入 fired evidence");
  assert.ok(hit.ratio.home > 1, "方向朝主队");
});

test("signalTimeDecayForm 无近期赛历史时休眠(进 dormant 不进 evidence),不报错", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const { evidence, dormant } = collectFusionEvidence(prior, { homeTeam: "甲", awayTeam: "乙", date: "2026-05-22" }, {}, {});
  assert.ok(!evidence.some((e) => e.name === "time-decay-form"), "无历史 → 不应 fire");
  assert.ok(dormant.some((d) => d.name === "time-decay-form"), "应记为 dormant");
});

// ---- 信号消融基建:disabledSignals / signalWeights(为命中率优化闭环服务)----
import { SIGNAL_NAMES } from "../src/signal-fusion-layer.js";

function strongHomeCtx() {
  return {
    homeRecentMatches: recentForm(["W", "W", "W", "D", "W"]),
    awayRecentMatches: recentForm(["L", "L", "D", "L", "L"]),
    h2hMatches: []
  };
}

test("SIGNAL_NAMES 覆盖全部 handler(消融/调权枚举用)", () => {
  assert.ok(SIGNAL_NAMES.includes("time-decay-form"));
  assert.ok(SIGNAL_NAMES.includes("home-away-split"));
  assert.equal(new Set(SIGNAL_NAMES).size, SIGNAL_NAMES.length, "无重复");
});

test("disabledSignals 能精确关掉指定信号(记为 dormant:disabled)", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fixture = { homeTeam: "甲", awayTeam: "乙", date: "2026-05-22" };
  const ctx = strongHomeCtx();
  const on = collectFusionEvidence(prior, fixture, {}, ctx);
  assert.ok(on.evidence.some((e) => e.name === "time-decay-form"), "默认应 fire");
  const off = collectFusionEvidence(prior, fixture, {}, ctx, { disabledSignals: ["time-decay-form"] });
  assert.ok(!off.evidence.some((e) => e.name === "time-decay-form"), "禁用后不应 fire");
  assert.ok(off.dormant.some((d) => d.name === "time-decay-form" && d.dormant === "disabled"));
});

test("signalWeights<1 弱化信号 LR(朝中性 1 收缩),=0 等于禁用", () => {
  const prior = { home: 0.4, draw: 0.3, away: 0.3 };
  const fixture = { homeTeam: "甲", awayTeam: "乙", date: "2026-05-22" };
  const ctx = strongHomeCtx();
  const base = collectFusionEvidence(prior, fixture, {}, ctx).evidence.find((e) => e.name === "time-decay-form");
  const weak = collectFusionEvidence(prior, fixture, {}, ctx, { signalWeights: { "time-decay-form": 0.3 } })
    .evidence.find((e) => e.name === "time-decay-form");
  assert.ok(base.ratio.home > weak.ratio.home && weak.ratio.home > 1, "w=0.3 应把 LR 朝 1 收缩但仍>1");
  const zero = collectFusionEvidence(prior, fixture, {}, ctx, { signalWeights: { "time-decay-form": 0 } });
  assert.ok(!zero.evidence.some((e) => e.name === "time-decay-form"), "w=0 等于禁用");
});

// ---- 融合权重 profile 加载(命中率优化闭环③:回测学到的权重接进生产)----
import { loadFusionWeightProfile, _resetFusionWeightCache } from "../src/signal-fusion-layer.js";

test("loadFusionWeightProfile 返回 {signalWeights,disabledSignals} 或 null,并进程内缓存", () => {
  _resetFusionWeightCache();
  const p = loadFusionWeightProfile();
  // profile 可能存在(D盘 exports)也可能不存在;两种都要安全
  if (p !== null) {
    assert.ok(typeof p === "object");
    assert.ok(Array.isArray(p.disabledSignals));
    assert.ok(p.signalWeights && typeof p.signalWeights === "object");
  }
  // 第二次调用走缓存,返回同一引用(或同为 null)
  assert.equal(loadFusionWeightProfile(), p);
});

// ---- 温度校准:2026-06-11 融合大扫除已永久删除(0610 缺陷#19 僵尸,守护见 temperature-zombie-guard.test.mjs)----

// ---- 任选9(从14场挑最稳9场单选)----
import { buildRenxuan9 } from "../src/prediction-engine.js";

function predForR9({ home, away, pickCode, pickProb, secProb, conf, risk = "中" }) {
  return {
    fixture: { id: `${home}-${away}`, homeTeam: home, awayTeam: away, competition: "测试", date: "2026-05-29" },
    pick: { code: pickCode, probability: pickProb },
    secondaryPick: { code: "1", probability: secProb },
    confidence: conf, risk
  };
}

test("buildRenxuan9 从≥9场里挑置信最高9场单选 + 联合命中率", () => {
  const preds = [];
  for (let i = 0; i < 12; i++) {
    preds.push(predForR9({ home: `H${i}`, away: `A${i}`, pickCode: "3", pickProb: 0.5 + i * 0.02, secProb: 0.25, conf: 50 + i }));
  }
  const r9 = buildRenxuan9(preds);
  assert.equal(r9.ok, true);
  assert.equal(r9.picks.length, 9, "正好9场");
  assert.equal(r9.needCorrect, 9);
  // 应取置信最高的9场(conf 53..61),最高 conf=61 排第1
  assert.equal(r9.picks[0].confidence, 61);
  assert.ok(r9.parlay.jointProbabilityIndependent > 0 && r9.parlay.jointProbabilityIndependent < 1);
  assert.equal(r9.singleLine.split(" ").length, 9);
});

test("buildRenxuan9 不足9场诚实返回 ok:false 不硬凑", () => {
  const preds = [predForR9({ home: "A", away: "B", pickCode: "3", pickProb: 0.6, secProb: 0.2, conf: 70 })];
  const r9 = buildRenxuan9(preds);
  assert.equal(r9.ok, false);
  assert.equal(r9.picks.length, 0);
});

// ---- 数据保护:失败同步不得用空集覆盖已有非空赛事(护选票)----
import { saveFixtures, loadFixtures } from "../src/fixture-store.js";

test("saveFixtures 拒绝用空集覆盖已有非空赛事(默认),allowEmpty 才清空", () => {
  const d = "2099-12-31"; // 测试专用日期,避免碰真实数据
  saveFixtures(d, [{ homeTeam: "甲", awayTeam: "乙", competition: "测试", date: d }], { source: "test-seed" });
  assert.equal(loadFixtures(d).fixtures.length, 1, "先写入1场");
  // 空集覆盖 → 应被拒绝,保留原有
  const res = saveFixtures(d, [], { source: "failed-sync" });
  assert.equal(res.refusedEmptyOverwrite, true, "应拒绝空覆盖");
  assert.equal(loadFixtures(d).fixtures.length, 1, "原有赛事保留");
  // 显式 allowEmpty → 允许清空
  saveFixtures(d, [], { source: "manual-clear", allowEmpty: true });
  assert.equal(loadFixtures(d).fixtures.length, 0, "allowEmpty 时才清空");
});

// ---- 下注分级(把选择性推荐阈值落地成日报标签)----
import { bettingTier } from "../src/daily-report.js";

test("bettingTier 按首选概率分级(阈值依据 coverage 曲线)", () => {
  assert.match(bettingTier({ home: 0.70, draw: 0.18, away: 0.12 }), /建议下注/);
  assert.match(bettingTier({ home: 0.66, draw: 0.20, away: 0.14 }), /建议下注/);
  assert.match(bettingTier({ home: 0.55, draw: 0.25, away: 0.20 }), /可选/);
  assert.match(bettingTier({ home: 0.45, draw: 0.30, away: 0.25 }), /慎选|观望/);
  assert.match(bettingTier({ home: 0.34, draw: 0.33, away: 0.33 }), /慎选|观望/);
});

// ---- 复盘按下注分级统计真实命中率(闭合反馈环)----
import { summarizeByTier } from "../src/daily-recap.js";

test("summarizeByTier 按 tier 分组统计真实命中率;旧行用概率回退", () => {
  const settled = [
    { tier: "🟢 建议下注", hit: true },
    { tier: "🟢 建议下注", hit: false },
    { tier: "🟡 可选", hit: true },
    // 旧行无 tier,概率回退:top=0.7 → 🟢
    { probabilityHome: 0.7, probabilityDraw: 0.18, probabilityAway: 0.12, hit: true },
    // top=0.4 → ⚪
    { probabilityHome: 0.4, probabilityDraw: 0.33, probabilityAway: 0.27, hit: false }
  ];
  const tb = summarizeByTier(settled);
  assert.equal(tb["🟢 建议下注"].total, 3, "2显式+1概率回退");
  assert.equal(tb["🟢 建议下注"].hit, 2);
  assert.equal(tb["🟡 可选"].total, 1);
  assert.equal(tb["⚪ 慎选/观望"].total, 1);
  assert.equal(tb["⚪ 慎选/观望"].accuracy, 0);
});

// ---- 按联赛命中率分解(诚实显示模型在哪些联赛靠谱)----
import { summarizeLeagueAccuracy } from "../src/walkforward-backtest.js";

test("summarizeLeagueAccuracy 按命中率降序 + 样本充足标注", () => {
  const out = summarizeLeagueAccuracy({
    "英超": { total: 30, hit: 18 },
    "挪超": { total: 8, hit: 2 },
    "西甲": { total: 25, hit: 10 }
  });
  assert.equal(out[0].league, "英超", "命中率最高排第一");
  assert.equal(out[0].accuracy, 0.6);
  assert.equal(out[0].reliable, true);
  const nor = out.find((x) => x.league === "挪超");
  assert.equal(nor.reliable, false, "样本<20标注不可靠");
});

// ---- 联赛可信度接进下注分级(弱联赛降级)----
import { bettingTier as bettingTierLg, loadLeagueReliability, _resetLeagueReliabilityCache } from "../src/daily-report.js";

test("bettingTier 联赛可信度:弱联赛降级+⚠️,强/未知联赛不变,无league参数向后兼容", () => {
  // 无 profile 或无 league → 与旧行为一致
  _resetLeagueReliabilityCache();
  const probsStrong = { home: 0.70, draw: 0.18, away: 0.12 };
  assert.match(bettingTierLg(probsStrong), /建议下注/, "单参数向后兼容");
  // profile 存在时:弱联赛(reliable且<阈值)应降级
  const prof = loadLeagueReliability();
  if (prof?.leagues) {
    const weak = Object.entries(prof.leagues).find(([, v]) => v.reliable && v.accuracy < (prof.weakThreshold ?? 0.42));
    if (weak) {
      const t = bettingTierLg(probsStrong, weak[0]);
      assert.match(t, /⚠️弱联赛/, "弱联赛应加⚠️降级");
      assert.ok(!t.startsWith("🟢"), "🟢应被降级");
    }
  }
});
