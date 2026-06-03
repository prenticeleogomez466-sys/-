import test from "node:test";
import assert from "node:assert/strict";
import { buildDerivedScoreModel, bestScoreFromMatrix, handicapCoverFromMatrix, matrixOutcomeProbs, scoreProbFromMatrix, topScoresWithProb, bestDistinctFirstHalfHalfFull, topHalfFull, handicapLadder, totalGoalsBands, halfFullDepth } from "../src/derived-score-model.js";
import { halfFullProbsFromLambdas } from "../src/prediction-engine.js";

test("强化·handicapLadder:多档盘口覆盖单调 + 公平线在 ±0.5 覆盖均衡处", () => {
  const m = buildDerivedScoreModel(2.0, 0.8); // 主队占优
  const r = handicapLadder(m.matrix);
  assert.ok(r && Array.isArray(r.ladder) && r.ladder.length >= 7);
  // 让主队更多球(line 越负)→ 主覆盖应单调下降
  const homeAt = (l) => r.ladder.find((c) => c.line === l)?.home;
  assert.ok(homeAt(1) > homeAt(0) && homeAt(0) > homeAt(-1), "主覆盖随 line 增大单调升");
  assert.ok(Number.isFinite(r.modelFairLine));
  // 每档三态和≈1
  for (const c of r.ladder) assert.ok(Math.abs(c.home + c.push + c.away - 1) < 0.02);
});

test("强化·totalGoalsBands:区间和≈1 + 集中度分级", () => {
  const m = buildDerivedScoreModel(1.4, 1.1);
  const r = totalGoalsBands(m.matrix);
  const sum = r.bands["0"] + r.bands["1"] + r.bands["2"] + r.bands["3"] + r.bands["4+"];
  assert.ok(Math.abs(sum - 1) < 0.02, "总进球区间概率和≈1");
  assert.ok(["集中", "中等", "分散"].includes(r.concentration));
  assert.ok(r.topScoreProb > 0 && r.topScoreProb < 1);
});

test("强化·halfFullDepth:反转/逆转概率在 [0,1] 且同向占多数", () => {
  const hf = { "主胜-主胜": 0.4, "平局-主胜": 0.2, "平局-平局": 0.15, "客胜-客胜": 0.1, "主胜-客胜": 0.03, "客胜-主胜": 0.02, "平局-客胜": 0.05, "主胜-平局": 0.03, "客胜-平局": 0.02 };
  const r = halfFullDepth(hf);
  assert.ok(r.sameDirection > 0 && r.sameDirection <= 1);
  assert.ok(r.reversalRisk >= 0 && r.reversalRisk < 0.5, "领先被逆转应是小概率");
  assert.ok(r.htDrawBreakRate >= 0 && r.htDrawBreakRate <= 1);
  assert.equal(halfFullDepth(null), null);
});

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

test("负二项 nbSize 过离散:软赛事比分矩阵更多 0 球 + 高尾更重(不改 wld 方向)", () => {
  const pois = buildDerivedScoreModel(1.5, 1.2);                 // 默认泊松
  const nb = buildDerivedScoreModel(1.5, 1.2, { nbSize: 8 });    // 负二项过离散
  // 两者 wld 概率应接近(过离散主要改尾巴不改方向)
  assert.ok(Math.abs(pois.probabilities.home - nb.probabilities.home) < 0.05);
  // NB 的 0-0 概率应高于泊松(过离散→更多 0 球)
  const p00 = scoreProbFromMatrix(pois.matrix, "0-0");
  const n00 = scoreProbFromMatrix(nb.matrix, "0-0");
  assert.ok(n00 > p00, `NB 0-0 (${n00.toFixed(4)}) 应 > 泊松 (${p00.toFixed(4)})`);
  // NB 的高总进球尾巴(总分≥5)应高于泊松(过离散→更重尾)
  const tail = (m) => { let s = 0; for (let h = 0; h < m.length; h++) for (let a = 0; a < m[h].length; a++) if (h + a >= 5) s += m[h][a]; return s; };
  assert.ok(tail(nb.matrix) > tail(pois.matrix), `NB 高尾 (${tail(nb.matrix).toFixed(4)}) 应 > 泊松 (${tail(pois.matrix).toFixed(4)})`);
  // nbSize 非法/缺省 → 退化泊松(与默认一致)
  const nbOff = buildDerivedScoreModel(1.5, 1.2, { nbSize: 0 });
  assert.ok(Math.abs(scoreProbFromMatrix(nbOff.matrix, "0-0") - p00) < 1e-9, "nbSize=0 应退化泊松");
});
