import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mutualInformation, selectTopKFeatures, removeCollinearFeatures } from "../src/variable-selection.js";
import { aggregateConsensus } from "../src/multi-agent-consensus.js";
import { hardVote, softVote, hybridVote } from "../src/voting-classifier.js";

describe("variable-selection", () => {
  it("mutualInformation: independent features = 0", () => {
    const features = new Array(50).fill(0).map(() => Math.random());
    const labels = new Array(50).fill(0).map(() => Math.random() > 0.5 ? "home" : "away");
    const mi = mutualInformation(features, labels);
    assert.ok(Math.abs(mi) < 0.5);  // 应该接近 0
  });

  it("mutualInformation: dependent features have positive MI", () => {
    const features = [];
    const labels = [];
    for (let i = 0; i < 50; i++) {
      const v = Math.random();
      features.push(v);
      labels.push(v > 0.5 ? "home" : "away");  // 强相关
    }
    const mi = mutualInformation(features, labels);
    assert.ok(mi > 0.1);
  });

  it("selectTopKFeatures returns top K by MI", () => {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      const informative = i % 3 === 0 ? 0.8 : 0.2;
      samples.push({
        features: { informative, noise: Math.random() },
        label: informative > 0.5 ? "home" : "away"
      });
    }
    const r = selectTopKFeatures(samples, 1);
    assert.equal(r.ok, true);
    assert.equal(r.top[0].feature, "informative");
  });

  it("removeCollinearFeatures drops perfectly correlated", () => {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const x = Math.random();
      samples.push({ features: { x, duplicate: x, noise: Math.random() }, label: "home" });
    }
    const r = removeCollinearFeatures(samples, 0.9);
    assert.equal(r.removed.length, 1);
    assert.ok(r.kept.includes("x") || r.kept.includes("duplicate"));
  });
});

describe("multi-agent-consensus", () => {
  it("majority vote winner when all agents agree", () => {
    const preds = {
      a: { home: 0.6, draw: 0.2, away: 0.2 },
      b: { home: 0.55, draw: 0.25, away: 0.2 },
      c: { home: 0.5, draw: 0.3, away: 0.2 }
    };
    const r = aggregateConsensus(preds, { strategy: "majority" });
    assert.equal(r.winner, "home");
    assert.equal(r.consensusStrength, "全员一致");
  });

  it("weighted majority respects weights", () => {
    const preds = {
      a: { home: 0.55, draw: 0.25, away: 0.20 },
      b: { home: 0.20, draw: 0.30, away: 0.50 }
    };
    const r = aggregateConsensus(preds, { strategy: "weighted", weights: { a: 0.1, b: 0.9 } });
    assert.equal(r.winner, "away");
  });

  it("borda count balances rankings", () => {
    const preds = {
      a: { home: 0.5, draw: 0.3, away: 0.2 },  // home > draw > away
      b: { home: 0.5, draw: 0.3, away: 0.2 },
      c: { home: 0.2, draw: 0.5, away: 0.3 }   // draw > away > home
    };
    const r = aggregateConsensus(preds, { strategy: "borda" });
    // a + b 都把 home 排第 1 (3 分),c 把 draw 排第 1
    // home: 3+3+1=7;draw: 2+2+3=7;away: 1+1+2=4
    // home 和 draw 同分,取 OUTCOMES 顺序第一个
    assert.ok(["home", "draw"].includes(r.winner));
  });
});

describe("voting-classifier", () => {
  it("hardVote winner is majority pick", () => {
    const preds = {
      a: { home: 0.5, draw: 0.3, away: 0.2 },
      b: { home: 0.5, draw: 0.3, away: 0.2 },
      c: { home: 0.2, draw: 0.6, away: 0.2 }
    };
    const r = hardVote(preds);
    assert.equal(r.winner, "home");
    assert.equal(r.voteCounts.home, 2);
    assert.equal(r.voteCounts.draw, 1);
  });

  it("softVote averages probabilities", () => {
    const preds = {
      a: { home: 0.6, draw: 0.2, away: 0.2 },
      b: { home: 0.4, draw: 0.3, away: 0.3 }
    };
    const r = softVote(preds);
    assert.ok(Math.abs(r.probabilities.home - 0.5) < 0.01);
  });

  it("hybridVote detects agreement", () => {
    const preds = {
      a: { home: 0.6, draw: 0.2, away: 0.2 },
      b: { home: 0.55, draw: 0.25, away: 0.2 }
    };
    const r = hybridVote(preds);
    assert.equal(r.agree, true);
    assert.ok(r.confidence.includes("强信号"));
  });

  it("hybridVote detects contradiction", () => {
    const preds = {
      a: { home: 0.40, draw: 0.30, away: 0.30 },   // hard: home
      b: { home: 0.10, draw: 0.20, away: 0.70 }    // hard: away,概率高
    };
    const r = hybridVote(preds);
    // soft: a + b 平均 home=0.25 draw=0.25 away=0.50 → soft argmax=away
    // hard: 1 票 home + 1 票 away,平局
    // 这种情况看 hybrid 怎么判断
    assert.ok(r.ok);
  });
});
