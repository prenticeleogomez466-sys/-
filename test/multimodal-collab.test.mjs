import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRegime,
  extractLenses,
  compareLenses,
  dispatchVerdict,
  multimodalAnalysis,
  summarizeMultimodal,
  multimodalComparisonRows,
  analyzeScorePlay,
  analyzeHalfFullPlay,
  analyzeDataChangePlay,
  analyzePlaytypes,
  auditMultimodalLayer,
  auditMultimodalBatch,
} from "../src/multimodal-collab.js";

// 构造一个最小但真实形状的 prediction(字段名对齐 prediction-engine.predictFixture 产出)。
function makePrediction(overrides = {}) {
  const base = {
    fixture: { homeTeam: "瑞士", awayTeam: "约旦", competition: "国际赛", id: "t1" },
    provenance: "odds(0.65)+dixon-coles(0.35)",
    probabilities: { home: 0.72, draw: 0.21, away: 0.07 },
    marketImpliedProbabilities: { home: 0.7693, draw: 0.1513, away: 0.0794 },
    dixonColes: {
      source: "odds(0.65)+dixon-coles(0.35)",
      independentProbs: { home: 0.8217, draw: 0.1461, away: 0.0322 },
      teamStrength: { homeAttack: 1.4, awayAttack: 0.7 },
    },
    probabilityAdjustment: {
      fusionGatedOff: true,
      fusion: { probabilities: { home: 0.79, draw: 0.15, away: 0.06 }, fired: [] },
    },
    experienceContext: { wld: { home: 0.44, draw: 0.30, away: 0.26 }, source: "league-exp", historicalDrawRate: 0.28, n: 49969 },
    handicapPick: { line: -1, handicapWld: { line: -1, source: "DC-τ覆盖", probabilities: { home: 0.41, draw: 0.30, away: 0.29 } } },
    asianWaterAnalysis: {
      line: -1, early: { homeOdds: 1.80, awayOdds: 2.05 }, late: { homeOdds: 1.96, awayOdds: 1.90 },
    },
    selectionTier: { marketFavProb: 0.7693 },
    scorePicks: {
      primary: "2-0", secondary: "1-0", source: "dixon-coles:market-derived",
      primaryProbability: 0.197, secondaryProbability: 0.169,
      distribution: [
        { score: "2-0", probability: 0.197, outcome: "3" },
        { score: "1-1", probability: 0.18, outcome: "1" }, // 全局最可能比分是平局(正常,不算不一致)
        { score: "1-0", probability: 0.169, outcome: "3" },
      ],
    },
    halfFullPicks: {
      primary: "主胜-主胜", secondary: "平局-主胜", source: "poisson-half-joint",
      primaryProbability: 0.568, secondaryProbability: 0.239,
      distribution: [{ halfFull: "主胜-主胜", probability: 0.568 }, { halfFull: "平局-主胜", probability: 0.239 }],
    },
    marketSnapshot: {
      europeanOdds: { initial: { home: 1.20, draw: 6.1, away: 11.6 }, current: { home: 1.20, draw: 6.1, away: 11.6 }, final: null },
      scoreOdds: null, halfFullOdds: null,
    },
  };
  return { ...base, ...overrides };
}

test("classifyRegime 软赛事强热门画像", () => {
  const r = classifyRegime(makePrediction());
  assert.equal(r.leagueMode, "soft-international");
  assert.equal(r.oddsMode, "strong-fav");
  assert.ok(r.dataMode.includes("market-odds"));
  assert.ok(r.label.includes("软赛事"));
});

test("classifyRegime 东亚联赛识别", () => {
  const r = classifyRegime(makePrediction({ fixture: { homeTeam: "横滨水手", awayTeam: "浦和红钻", competition: "日职" } }));
  assert.equal(r.leagueMode, "east-asia");
});

test("extractLenses 抽出各路独立模型且只读已算好的真实中间量", () => {
  const lenses = extractLenses(makePrediction());
  const byKey = Object.fromEntries(lenses.map((l) => [l.key, l]));
  assert.equal(byKey.market.available, true);
  assert.equal(byKey.market.pick.key, "home");
  assert.equal(byKey["dixon-coles"].pick.key, "home");
  assert.equal(byKey.handicap.kind, "handicap"); // 让球单列,不进 wld 投票
  // 缺数据的处理路 available:false,绝不编造
  const noOdds = extractLenses(makePrediction({ marketImpliedProbabilities: null }));
  assert.equal(noOdds.find((l) => l.key === "market").available, false);
});

test("compareLenses 一致/分歧 + 锚偏离共识检测(以 wld 为锚,不改方向)", () => {
  // 三路独立(market/DC/experience)都偏主胜,但最终锚被改成客胜 → 必须标 anchorVsConsensus=false
  const flipped = makePrediction({ probabilities: { home: 0.357, draw: 0.239, away: 0.405 } });
  const cmp = compareLenses(flipped);
  assert.equal(cmp.consensusOutcome, "home");
  assert.equal(cmp.anchorOutcome, "away");
  assert.equal(cmp.anchorVsConsensus, false);
  assert.ok(cmp.flags.some((f) => f.level === "warn" && /偏离多数处理共识/.test(f.text)));
});

test("compareLenses 各路同向 → unanimous", () => {
  const cmp = compareLenses(makePrediction({ probabilities: { home: 0.72, draw: 0.21, away: 0.07 } }));
  assert.equal(cmp.unanimous, true);
  assert.equal(cmp.anchorVsConsensus, true);
});

test("dispatchVerdict 软赛事主导处理 = 重校准 + 历史经验", () => {
  const p = makePrediction();
  const v = dispatchVerdict(classifyRegime(p), compareLenses(p));
  assert.ok(/重校准/.test(v.lead));
  assert.ok(typeof v.confidenceNote === "string");
});

test("multimodalAnalysis 不可预测场返回 null,不编造", () => {
  assert.equal(multimodalAnalysis({ unpredictable: true, fixture: {} }), null);
  assert.equal(multimodalAnalysis(null), null);
  const a = multimodalAnalysis(makePrediction());
  assert.ok(a.text.includes("【模态】") && a.text.includes("【方向·各路对比】"));
  assert.ok(a.text.includes("【比分】") && a.text.includes("【半全场】") && a.text.includes("【数据变化】"));
});

test("summarizeMultimodal 诚实 roll-up(统计一致/分歧/锚偏离)", () => {
  const ok = makePrediction(); // 一致
  ok.multimodal = multimodalAnalysis(ok);
  const flip = makePrediction({ probabilities: { home: 0.357, draw: 0.239, away: 0.405 } }); // 锚偏离
  flip.multimodal = multimodalAnalysis(flip);
  const s = summarizeMultimodal([ok, flip, { unpredictable: true }]);
  assert.equal(s.analyzed, 2);
  assert.equal(s.anchorDivergent, 1);
  assert.ok(s.byLeagueMode["软赛事(国际/友谊/国家队)"] >= 1);
});

test("multimodalComparisonRows 产出表头 + 每场一行,跳过 unpredictable", () => {
  const rows = multimodalComparisonRows([makePrediction(), { unpredictable: true, fixture: {} }]);
  assert.ok(rows.length >= 3); // 标题行 + 列头 + ≥1 数据行
  assert.ok(rows[0][0].includes("多模态协作"));
  assert.ok(rows[2][0].includes("瑞士"));
  // 汇总表含四玩法列(比分/半全场/数据变化)
  assert.ok(rows[1].includes("比分(小模型)") && rows[1].includes("半全场(小模型)") && rows[1].includes("数据变化(资金流向)"));
});

// ───────────── 四玩法小模型 ─────────────
test("analyzeScorePlay:DC可用、市场比分赔率缺则 available:false 不编造、wld锚一致(比对primary非全局最可能比分)", () => {
  const sc = analyzeScorePlay(makePrediction());
  assert.equal(sc.available, true);
  assert.equal(sc.anchor.label, "2-0");
  assert.equal(sc.sources.find((s) => s.key === "market-score").available, false); // 无 scoreOdds
  // 全局最可能比分是 1-1(平),但 primary=2-0(主)与锚一致 → 不报不一致
  assert.equal(sc.wldConsistent, true);
  assert.equal(sc.flags.length, 0);
});

test("analyzeScorePlay:比分首选真与wld锚反向才报不一致", () => {
  const p = makePrediction({
    pick: { key: "home", code: "3", label: "主胜", probability: 0.5 },
    scorePicks: { primary: "0-2", secondary: "0-1", primaryProbability: 0.1, distribution: [{ score: "0-2", probability: 0.1, outcome: "0" }] },
  });
  const sc = analyzeScorePlay(p);
  assert.equal(sc.wldConsistent, false);
  assert.ok(sc.flags.some((f) => /不一致/.test(f.text)));
});

test("analyzeHalfFullPlay:FT段与wld锚一致;缺市场半全场赔率 available:false", () => {
  const hf = analyzeHalfFullPlay(makePrediction());
  assert.equal(hf.available, true);
  assert.equal(hf.anchor.label, "主胜-主胜");
  assert.equal(hf.wldConsistent, true); // FT=主胜 == pick 主胜
  assert.equal(hf.sources.find((s) => s.key === "market-hf").available, false);
});

test("analyzeDataChangePlay:无赔率变化诚实标注不编造;水位移动被读出", () => {
  const dc = analyzeDataChangePlay(makePrediction());
  assert.equal(dc.available, true); // 有欧赔+亚盘
  assert.equal(dc.euroMoved, false); // initial==current
  assert.equal(dc.waterMoved, true); // 1.80→1.96
  assert.ok(/水位/.test(dc.reading));
  // 完全无赔率 → available:false + 明确"不编造"语,且不报漂移
  const none = analyzeDataChangePlay(makePrediction({ marketSnapshot: {}, asianWaterAnalysis: null }));
  assert.equal(none.available, false);
  assert.equal(none.euroMoved, false);
  assert.ok(/不编造/.test(none.reading));
});

test("analyzePlaytypes 汇总四玩法 + 历史", () => {
  const pt = analyzePlaytypes(makePrediction());
  assert.deepEqual(Object.keys(pt), ["wld", "score", "halfFull", "dataChange", "historical"]);
  assert.equal(pt.score.playtype, "比分");
  assert.equal(pt.halfFull.playtype, "半全场");
  // 无 history → 历史 available:false(不编造)
  assert.equal(pt.historical.available, false);
});

// ───────────── 每层全面审计 ─────────────
test("auditMultimodalLayer:健康场 0 blocker;让球路缺draw(NaN)不误判为假", () => {
  // 让球覆盖 whole-line 无 draw,probs.draw=null → 不该被当假数据 blocker
  const p = makePrediction({ handicapPick: { line: -2, handicapWld: { line: -2, source: "DC-τ", probabilities: { home: 0.55, away: 0.45 } } } });
  const r = auditMultimodalLayer(p);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
});

test("auditMultimodalLayer:wld分布不归一 → 硬 blocker(假数据)", () => {
  const p = makePrediction({ marketImpliedProbabilities: { home: 0.9, draw: 0.9, away: 0.9 } }); // sum 2.7
  const r = auditMultimodalLayer(p);
  assert.equal(r.ok, false);
  assert.ok(r.blockers.some((b) => /不归一/.test(b)));
});

test("auditMultimodalLayer:锚偏离独立共识 → warning(不拦)", () => {
  const flip = makePrediction({ probabilities: { home: 0.357, draw: 0.239, away: 0.405 } });
  const r = auditMultimodalLayer(flip);
  assert.equal(r.ok, true); // 偏离是 warning 不是 blocker
  assert.ok(r.warnings.some((w) => /偏离独立共识/.test(w)));
});

test("auditMultimodalBatch:roll-up + unpredictable 跳过", () => {
  const b = auditMultimodalBatch([makePrediction(), makePrediction(), { unpredictable: true, fixture: {} }]);
  assert.equal(b.analyzed, 2);
  assert.equal(b.ok, true);
  assert.ok(b.byPlaytype.比分.ok >= 1);
});

// ───────────── 历史比赛数据小模型集成 ─────────────
import { canonicalTeamName } from "../src/team-aliases.js";
function histRec(date, home, away, hg, ag) {
  return { date, homeTeam: home, awayTeam: away, homeCanon: canonicalTeamName(home), awayCanon: canonicalTeamName(away), homeGoals: hg, awayGoals: ag };
}

test("analyzePlaytypes 带 history → 附 H2H/近期 历史小模型 + 比分加历史子源", () => {
  const p = makePrediction({ fixture: { homeTeam: "甲队ZZ", awayTeam: "乙队ZZ", competition: "英超", id: "h1" } });
  const hist = [
    histRec("2025-01-01", "甲队ZZ", "乙队ZZ", 2, 0), histRec("2025-02-01", "乙队ZZ", "甲队ZZ", 0, 1), histRec("2025-03-01", "甲队ZZ", "乙队ZZ", 1, 1),
    histRec("2025-05-01", "甲队ZZ", "丙队ZZ", 2, 0), histRec("2025-05-08", "甲队ZZ", "丙队ZZ", 1, 0), histRec("2025-05-15", "丙队ZZ", "甲队ZZ", 0, 3),
    histRec("2025-05-02", "乙队ZZ", "丙队ZZ", 0, 1), histRec("2025-05-09", "丙队ZZ", "乙队ZZ", 1, 1), histRec("2025-05-16", "乙队ZZ", "丙队ZZ", 0, 2),
  ];
  const pt = analyzePlaytypes(p, undefined, undefined, hist);
  assert.equal(pt.historical.available, true);
  assert.equal(pt.historical.h2h.available, true);
  assert.equal(pt.wld.historical.h2h.available, true);
  // 比分小模型应含历史交锋常见比分子源
  assert.ok(pt.score.sources.some((s) => s.key === "h2h-score" && s.available));
});

test("multimodalAnalysis(options.history) → 文案含【历史比赛数据】且不编造", () => {
  const p = makePrediction();
  const aNo = multimodalAnalysis(p); // 不传 history
  assert.ok(aNo.text.includes("【历史比赛数据】"));
  assert.ok(/不编造/.test(aNo.playtypes.historical.h2h.note + aNo.playtypes.historical.recentForm.note) || aNo.playtypes.historical.available === false);
});

test("auditMultimodalLayer:稀疏历史 available:false 不误判为假(不拦)", () => {
  const p = makePrediction(); // 无 history → 历史 available:false
  p.multimodal = multimodalAnalysis(p);
  const r = auditMultimodalLayer(p);
  assert.equal(r.ok, true, JSON.stringify(r.blockers));
});

test("质量不变式:多模态层是纯读取,不改 pick/probabilities", () => {
  const p = makePrediction();
  const beforePick = JSON.stringify(p.pick);
  const beforeProbs = JSON.stringify(p.probabilities);
  multimodalAnalysis(p);
  analyzePlaytypes(p);
  auditMultimodalLayer(p);
  assert.equal(JSON.stringify(p.pick), beforePick);
  assert.equal(JSON.stringify(p.probabilities), beforeProbs);
});
