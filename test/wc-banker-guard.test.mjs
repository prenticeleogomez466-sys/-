// 世界杯"样本不足不当胆"护栏(2026-06-10 审计 rank11)。
// 缺口实证:profile『世界杯』={accuracy:0.4,total:5,reliable:false} → reliable 要求样本≥20,
// isWeakLeague 恒 false,WC 场可进 14场/任选9 胆位。单向保守:样本<20 不当胆只作多选,绝不弃赛。
import test from "node:test";
import assert from "node:assert/strict";
import { isWeakLeague, isLowSampleWorldCup } from "../src/league-reliability.js";
import { buildFourteenPlan, buildRenxuan9 } from "../src/prediction-engine.js";

const PROF = {
  weakThreshold: 0.42,
  leagues: { "世界杯": { accuracy: 0.4, total: 5, hit: 2, reliable: false } }
};

test("isLowSampleWorldCup:世界杯样本<20→true;isWeakLeague 对同档恒 false(缺口实证)", () => {
  // 缺口本身:0.4 命中 5 样本,isWeakLeague 不判弱(reliable=false 不臆断)→ 原本可当胆
  assert.equal(isWeakLeague("世界杯", PROF), false);
  // 新护栏补上:样本<20 → 不当胆
  assert.equal(isLowSampleWorldCup("世界杯", "2026-06-12", PROF), true);
  // 英文赛事名同样命中(isWorldCup2026 名判定);profile 查不到该键=样本未知,同样保守
  assert.equal(isLowSampleWorldCup("World Cup", "2026-06-12", PROF), true);
  // 无日期(fixture 缺 kickoff)仍按赛事名判定,不放行
  assert.equal(isLowSampleWorldCup("世界杯", null, PROF), true);
  // profile 缺失=样本未知 → 保守不当胆(只影响胆位,不弃赛)
  assert.equal(isLowSampleWorldCup("世界杯", "2026-06-12", null), true);
});

test("isLowSampleWorldCup:非世界杯/窗口外/样本≥20 不触发(单向保守,不扩大化)", () => {
  // 非世界杯赛事不受影响
  assert.equal(isLowSampleWorldCup("英超", "2026-06-12", PROF), false);
  assert.equal(isLowSampleWorldCup(null, "2026-06-12", PROF), false);
  // 赛会窗口外(isWorldCup2026 日期闸)不触发
  assert.equal(isLowSampleWorldCup("世界杯", "2026-08-01", PROF), false);
  // 样本攒够 20 后退场,交还常规 isWeakLeague 判定
  const grown = { weakThreshold: 0.42, leagues: { "世界杯": { accuracy: 0.55, total: 25, hit: 14, reliable: true } } };
  assert.equal(isLowSampleWorldCup("世界杯", "2026-06-12", grown), false);
});

// ── 集成:14 场 / 任选9 胆过滤真生效 ───────────────────────────────────────
// mock 一场"胆相十足"的世界杯场(高 gap/高置信/低风险/市场热门),断言它进不了胆位但仍在票里;
// 同参数换成未知联赛(无 profile 记录,既不弱也非 WC)则照常当胆 —— 证明挡的是 WC 闸而非别的条件。
function mkPred(i, { competition, code = "3", gap = 0.30, p1 = 0.55, confidence = 70, favProb = 0.72 } = {}) {
  // pick=p1,次选=另一侧(p1-gap),平局=剩余(保持三项和为 1 的真实分布,平局压低避开平局覆盖分支)
  const p2 = p1 - gap;
  const pDraw = Math.round((1 - p1 - p2) * 100) / 100;
  const probs = code === "3"
    ? { home: p1, draw: pDraw, away: p2 }
    : { home: p2, draw: pDraw, away: p1 };
  return {
    fixture: {
      id: `wc-test-${i}`, homeTeam: `主队${i}`, awayTeam: `客队${i}`,
      competition, date: "2026-06-12", kickoff: "2026-06-12T03:00:00+08:00",
      marketType: "shengfucai", tags: ["14场胜负彩"], notes: ""
    },
    pick: { code, probability: p1 },
    secondaryPick: { code: code === "3" ? "0" : "3", probability: p2 },
    probabilities: probs,
    confidence, risk: "低", rationale: "测试桩",
    selectionTier: { label: "T1", marketFavProb: favProb, backtestHit: 0.73, bankerEligible: true, noMarketOdds: false },
    advancedFeatures: { quality: { score: 80 } },
    marketSnapshot: { europeanOdds: { current: { home: 2.1, draw: 3.3, away: 3.4 } } }
  };
}
// 14 场:世界杯场给全场最高的 gap×confidence(若可当胆必入选),其余 13 场未知联赛
function fourteenSource(wcCompetition) {
  const preds = [mkPred(0, { competition: wcCompetition, gap: 0.45, p1: 0.66, confidence: 90, favProb: 0.85 })];
  for (let i = 1; i <= 13; i++) {
    preds.push(mkPred(i, { competition: "测试联赛X", code: i % 2 ? "3" : "0", gap: 0.24, p1: 0.55, confidence: 55, favProb: 0.66 }));
  }
  return preds;
}

test("14 场胆过滤:世界杯场(样本<20)不当胆只作多选、不弃赛;同参未知联赛照常当胆", () => {
  const plan = buildFourteenPlan(fourteenSource("世界杯"), "2026-06-12");
  const wcSel = plan.selections.find((s) => s.match === "主队0 对 客队0");
  assert.ok(wcSel, "世界杯场仍在 14 场票内(绝不自动弃赛)");
  assert.notEqual(wcSel.type, "胆", "世界杯样本<20 不得当胆");
  // 对照组:同样的预测、联赛换成无 profile 记录的未知联赛 → 全场最强候选,必当胆
  const ctrl = buildFourteenPlan(fourteenSource("测试联赛Y"), "2026-06-12");
  const ctrlSel = ctrl.selections.find((s) => s.match === "主队0 对 客队0");
  assert.equal(ctrlSel.type, "胆", "非世界杯对照组照常当胆(证明挡的是 WC 闸)");
});

test("任选9 胆过滤:世界杯场(样本<20)不当胆只作多选、不弃赛;对照组照常当胆", () => {
  const mk9 = (comp) => {
    const preds = [mkPred(0, { competition: comp, gap: 0.45, p1: 0.66, confidence: 90, favProb: 0.85 })];
    for (let i = 1; i <= 8; i++) preds.push(mkPred(i, { competition: "测试联赛X", gap: 0.24, p1: 0.55, confidence: 55, favProb: 0.66 }));
    return preds;
  };
  const r9 = buildRenxuan9(mk9("世界杯"));
  assert.equal(r9.ok, true);
  const wcPick = r9.picks.find((p) => p.match === "主队0 对 客队0");
  assert.ok(wcPick, "世界杯场仍在任选9 票内(绝不自动弃赛)");
  assert.notEqual(wcPick.type, "胆", "世界杯样本<20 不得当任选9 胆");
  const ctrl = buildRenxuan9(mk9("测试联赛Y"));
  const ctrlPick = ctrl.picks.find((p) => p.match === "主队0 对 客队0");
  assert.equal(ctrlPick.type, "胆", "非世界杯对照组照常当胆(证明挡的是 WC 闸)");
});
