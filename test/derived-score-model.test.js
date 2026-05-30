import test from "node:test";
import assert from "node:assert/strict";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapCoverFromMatrix, matrixOutcomeProbs } from "../src/derived-score-model.js";

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
