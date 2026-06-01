import test from "node:test";
import assert from "node:assert/strict";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapCoverFromMatrix, matrixOutcomeProbs, scoreProbFromMatrix, topScoresWithProb, bestDistinctFirstHalfHalfFull, topHalfFull } from "../src/derived-score-model.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";

test("buildDerivedScoreModel:从 λ 出真泊松矩阵,期望进球≈输入 λ", () => {
  const m = buildDerivedScoreModel(2.1, 0.7);
  assert.ok(m && m.matrix, "应有矩阵");
  assert.ok(Math.abs(m.expectedGoals.home - 2.1) < 0.15, `home λ 应≈2.1,实得 ${m.expectedGoals.home}`);
  assert.ok(Math.abs(m.expectedGoals.away - 0.7) < 0.1, `away λ 应≈0.7,实得 ${m.expectedGoals.away}`);
  // 强主弱客:主胜概率应显著高于客胜
  assert.ok(m.probabilities.home > m.probabilities.away + 0.3);
});

test("buildDerivedScoreModel:λ 不同 → topScores 不同(非死表)", () => {
  const strongHome = buildDerivedScoreModel(2.3, 0.6).topScores[0].score;
  const evenMatch = buildDerivedScoreModel(1.2, 1.2).topScores[0].score;
  const strongAway = buildDerivedScoreModel(0.6, 2.3).topScores[0].score;
  // 强主首选比分主队进球多;强客反之;不应三者相同
  assert.notEqual(strongHome, strongAway);
  const [sh, sa] = strongHome.split("-").map(Number);
  assert.ok(sh > sa, `强主首选比分应主队领先,得 ${strongHome}`);
  const [ah, aa] = strongAway.split("-").map(Number);
  assert.ok(aa > ah, `强客首选比分应客队领先,得 ${strongAway}`);
});

test("bestScoreFromMatrix:任一 wld 方向都能从矩阵取到真实比分(保证有解)", () => {
  const m = buildDerivedScoreModel(2.0, 0.8);
  const home = bestScoreFromMatrix(m.matrix, "3");
  const draw = bestScoreFromMatrix(m.matrix, "1");
  const away = bestScoreFromMatrix(m.matrix, "0");
  assert.ok(home && draw && away, "三个方向都应有比分");
  const [hh, ha] = home.split("-").map(Number);
  const [dh, da] = draw.split("-").map(Number);
  const [ah, aa] = away.split("-").map(Number);
  assert.ok(hh > ha, "主胜比分主>客");
  assert.equal(dh, da, "平局比分主==客");
  assert.ok(ah < aa, "客胜比分主<客");
});

test("bestScoreFromMatrix:排除已用比分后仍返回真实次选(不重复)", () => {
  const m = buildDerivedScoreModel(2.0, 0.8);
  const first = bestScoreFromMatrix(m.matrix, "3");
  const second = bestScoreFromMatrix(m.matrix, "3", new Set([first]));
  assert.ok(second && second !== first, "次选应存在且不等于首选");
});

test("handicapCoverFromMatrix:强主在 line0 覆盖率高,模型公平线为负(主队该让球)", () => {
  const m = buildDerivedScoreModel(2.2, 0.7);
  const h = handicapCoverFromMatrix(m.matrix, 0);
  assert.ok(h.cover.home > 0.6, `强主 line0 覆盖率应>0.6,得 ${h.cover.home}`);
  assert.ok(h.modelFairLine < 0, `强主模型公平线应为负,得 ${h.modelFairLine}`);
  // 概率三态归一
  assert.ok(Math.abs(h.cover.home + h.cover.push + h.cover.away - 1) < 0.02);
});

test("matrixOutcomeProbs:矩阵聚合的胜平负归一", () => {
  const m = buildDerivedScoreModel(1.5, 1.3);
  const o = matrixOutcomeProbs(m.matrix);
  assert.ok(Math.abs(o.home + o.draw + o.away - 1) < 0.02);
});

// 深度强化(2026-05-30):概率 + 分布 + 反超备选
test("scoreProbFromMatrix:取具体比分真实概率,越界返回 null", () => {
  const m = buildDerivedScoreModel(1.6, 1.1);
  const p = scoreProbFromMatrix(m.matrix, "1-0");
  assert.ok(p > 0 && p < 1, `1-0 概率应在(0,1),得 ${p}`);
  assert.equal(scoreProbFromMatrix(m.matrix, "99-99"), null);
  assert.equal(scoreProbFromMatrix(m.matrix, "x"), null);
});

test("topScoresWithProb:返回带概率+方向的 top 比分,按概率降序", () => {
  const m = buildDerivedScoreModel(1.6, 1.1);
  const top = topScoresWithProb(m.matrix, 5);
  assert.equal(top.length, 5);
  assert.ok(top[0].probability >= top[4].probability, "应降序");
  assert.ok(["3", "1", "0"].includes(top[0].outcome));
});

test("bestDistinctFirstHalfHalfFull:主胜场挖出'平局-主胜'慢热反超(首半场≠主选)", () => {
  const hf = halfFullProbsFromLambdas(2.15, 0.72, 0.46);
  const alt = bestDistinctFirstHalfHalfFull(hf, "3", "主胜-主胜");
  assert.ok(alt && alt.halfFull, "应有备选");
  assert.notEqual(alt.halfFull.split("-")[0], "主胜", "首半场须不同于主选");
  assert.equal(alt.halfFull.split("-")[1], "主胜", "终场须仍为主胜(锚 wld)");
  assert.ok(alt.probability > 0);
});

test("topHalfFull:半全场 9 路 top-n 按概率降序", () => {
  const hf = halfFullProbsFromLambdas(1.4, 1.2, 0.46);
  const top = topHalfFull(hf, 4);
  assert.equal(top.length, 4);
  assert.ok(top[0].probability >= top[3].probability);
});

import { evaluateDrawLean } from "../src/prediction-engine.js";

test("evaluateDrawLean:均势闷局(平≥26%、进前二、与最高差≤8%)把平提为主推", () => {
  // 2026-06-01:门槛 0.30/0.05 → 0.26/0.08(真实均势国际赛平局上限≈29%,旧门槛永不触发)。
  const ranked = [
    { code: "3", probability: 0.38 }, { code: "1", probability: 0.32 }, { code: "0", probability: 0.30 }
  ];
  const r = evaluateDrawLean(ranked);
  assert.equal(r.applies, true);
  assert.equal(r.ranked[0].code, "1", "平进前二且接近,应提为主推");
});

test("evaluateDrawLean:平局仅第三(非前二)即便接近也不强推平", () => {
  // 客胜 0.33 > 平 0.31 时,把第三的平提为主推不合理 → 须进前二约束。
  const ranked = [
    { code: "3", probability: 0.36 }, { code: "0", probability: 0.33 }, { code: "1", probability: 0.31 }
  ];
  const r = evaluateDrawLean(ranked);
  assert.equal(r.applies, false, "平第三不提为主推");
});

test("evaluateDrawLean:热门明显领先(差>5%)不强行推平", () => {
  const ranked = [
    { code: "3", probability: 0.57 }, { code: "1", probability: 0.26 }, { code: "0", probability: 0.17 }
  ];
  const r = evaluateDrawLean(ranked);
  assert.equal(r.applies, false);
  assert.equal(r.ranked[0].code, "3");
});

test("evaluateDrawLean:平局概率偏低(<30%)不推平,即便接近", () => {
  const ranked = [
    { code: "3", probability: 0.40 }, { code: "0", probability: 0.38 }, { code: "1", probability: 0.22 }
  ];
  const r = evaluateDrawLean(ranked);
  assert.equal(r.applies, false);
});
