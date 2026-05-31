import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSoftCompetition,
  softCompetitionLambdaScale,
  recalibrateSoftCompetition,
} from "../src/competition-soft-recalibration.js";

// 被五大联赛 isotonic 压成 ~13% 平局的强热门国际赛形态
const PINNED = { home: 0.807, draw: 0.134, away: 0.059 };

describe("软赛事平局重校准", () => {
  it("isSoftCompetition:国际/友谊/国家队命中,俱乐部联赛不命中", () => {
    for (const c of ["国际赛", "友谊赛", "国家队友谊", "Nations League", "热身赛", "世预赛"]) {
      assert.ok(isSoftCompetition(c), `应判软:${c}`);
    }
    for (const c of ["英超", "西甲", "瑞超", "日职", "芬兰超级联赛", "Premier League", "中超", "巴甲"]) {
      assert.ok(!isSoftCompetition(c), `不应判软(俱乐部=回测路径):${c}`);
    }
  });

  it("俱乐部联赛:recal 不动 + λscale=1(回测路径零改动)", () => {
    const r = recalibrateSoftCompetition({ ...PINNED }, "瑞超", { n: 500, drawRate: 0.3 });
    assert.equal(r.applied, false);
    assert.deepEqual(r.probabilities, PINNED);
    assert.equal(softCompetitionLambdaScale("瑞超"), 1);
    assert.equal(softCompetitionLambdaScale("英超"), 1);
  });

  it("国际赛被钉平局:有界抬升平局、热门回落、概率归一", () => {
    const r = recalibrateSoftCompetition({ ...PINNED }, "国际赛", { n: 461, drawRate: 0.29 });
    assert.equal(r.applied, true);
    assert.ok(r.probabilities.draw > PINNED.draw, "平局应升");
    assert.ok(r.probabilities.home < PINNED.home, "热门应回落");
    // 有界:单次平局位移不超过 ±0.12
    assert.ok(r.probabilities.draw - PINNED.draw <= 0.12 + 1e-9, "平局位移须封顶");
    const sum = r.probabilities.home + r.probabilities.draw + r.probabilities.away;
    assert.ok(Math.abs(sum - 1) < 1e-6, "三路必须归一");
    // home/away 相对强弱保持
    assert.ok(r.probabilities.home > r.probabilities.away, "主仍强于客");
  });

  it("历史样本不足(n<80)时只用赛事性质先验,不采信历史平局率", () => {
    const r = recalibrateSoftCompetition({ ...PINNED }, "国际赛", { n: 10, drawRate: 0.9 });
    assert.equal(r.applied, true);
    // drawRate 0.9 但样本仅 10 场,不应被拉到接近 0.9;受先验+封顶约束
    assert.ok(r.probabilities.draw < 0.3, "小样本历史平局率不得主导");
    assert.equal(r.detail.histDraw, null);
  });

  it("软赛事 λscale<1(进球衰减),但仍 >0", () => {
    const s = softCompetitionLambdaScale("国际赛");
    assert.ok(s < 1 && s > 0, `国际赛 λscale 应 ∈(0,1),得 ${s}`);
    const sf = softCompetitionLambdaScale("国家队友谊");
    assert.ok(sf < 1 && sf > 0);
  });

  it("缺概率/缺经验基线时安全降级", () => {
    assert.equal(recalibrateSoftCompetition(null, "国际赛", null).applied, false);
    const r = recalibrateSoftCompetition({ ...PINNED }, "国际赛", null);
    // 无历史基线仍可用赛事性质先验
    assert.equal(r.applied, true);
  });
});
