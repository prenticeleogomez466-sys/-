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
    asianWaterAnalysis: { lateHome: 0.9 },
    selectionTier: { marketFavProb: 0.7693 },
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
  assert.ok(a.text.includes("【模态】") && a.text.includes("【对比】"));
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
});
