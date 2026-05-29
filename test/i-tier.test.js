import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionWeightedForm, compareTwoTeamsAttention } from "../src/sequence-attention.js";
import { sharpenOdds } from "../src/multi-source-odds-sharpener.js";
import { analyzeLineMovement, batchAnalyzeMovements } from "../src/line-movement-tracker.js";
import { buildFormFeatures, buildMatchupFeatures } from "../src/form-momentum-features.js";

describe("sequence-attention", () => {
  it("returns null for empty matches", () => {
    assert.equal(attentionWeightedForm([], { opponentRating: 1500, isHome: true }), null);
  });

  it("computes weighted form aggregates", () => {
    const matches = [
      { opponent: "X", isHome: true, gf: 2, ga: 1, opponentRating: 1600, date: "2026-04-01" },
      { opponent: "Y", isHome: false, gf: 1, ga: 2, opponentRating: 1400, date: "2026-04-15" },
      { opponent: "Z", isHome: true, gf: 3, ga: 0, opponentRating: 1550, date: "2026-05-01" }
    ];
    const r = attentionWeightedForm(matches, { opponentRating: 1600, isHome: true });
    assert.ok(r);
    assert.ok(Math.abs(r.weights.reduce((s, w) => s + w, 0) - 1) < 0.01);
    assert.ok(r.attentionTopK.length > 0);
  });

  it("weights higher for similar opponent rating", () => {
    const matches = [
      { opponent: "Sim", isHome: true, gf: 1, ga: 1, opponentRating: 1500, date: "2026-04-01" },
      { opponent: "Diff", isHome: true, gf: 1, ga: 1, opponentRating: 1200, date: "2026-04-15" }
    ];
    const r = attentionWeightedForm(matches, { opponentRating: 1500, isHome: true });
    assert.ok(r.weights[0] > r.weights[1]);
  });

  it("compareTwoTeamsAttention returns gap", () => {
    const home = [
      { opponent: "X", isHome: true, gf: 2, ga: 0, opponentRating: 1500, date: "2026-04-01" },
      { opponent: "Y", isHome: true, gf: 3, ga: 1, opponentRating: 1500, date: "2026-04-10" }
    ];
    const away = [
      { opponent: "X", isHome: false, gf: 0, ga: 2, opponentRating: 1500, date: "2026-04-01" },
      { opponent: "Y", isHome: false, gf: 1, ga: 3, opponentRating: 1500, date: "2026-04-10" }
    ];
    const r = compareTwoTeamsAttention(home, away, { opponentRating: 1500 });
    assert.ok(r);
    assert.ok(r.formGap > 0);  // 主队 form 更好
  });
});

describe("multi-source-odds-sharpener", () => {
  it("rejects empty quotes", () => {
    const r = sharpenOdds([]);
    assert.equal(r.ok, false);
  });

  it("sharpens single source by removing vig", () => {
    const r = sharpenOdds([{ source: "pinnacle", odds: { home: 2.0, draw: 3.5, away: 4.0 } }]);
    assert.equal(r.ok, true);
    const sum = r.fairProbabilities.home + r.fairProbabilities.draw + r.fairProbabilities.away;
    assert.ok(Math.abs(sum - 1) < 0.001);
  });

  it("weights Pinnacle higher than Bet365", () => {
    const pinnacleHeavy = { source: "pinnacle", odds: { home: 2.0, draw: 3.5, away: 4.0 } };
    const bet365Different = { source: "bet365", odds: { home: 1.5, draw: 4.5, away: 5.5 } };
    const r = sharpenOdds([pinnacleHeavy, bet365Different]);
    // 共识应更接近 pinnacle 的 fair prob(home ≈ 0.45)
    const pinnacleFair = (1/2.0) / (1/2.0 + 1/3.5 + 1/4.0);
    const distFromPinnacle = Math.abs(r.fairProbabilities.home - pinnacleFair);
    const bet365Fair = (1/1.5) / (1/1.5 + 1/4.5 + 1/5.5);
    const distFromBet365 = Math.abs(r.fairProbabilities.home - bet365Fair);
    assert.ok(distFromPinnacle < distFromBet365);
  });

  it("detects market consensus", () => {
    const quotes = [
      { source: "pinnacle", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
      { source: "bet365", odds: { home: 2.0, draw: 3.6, away: 4.0 } }
    ];
    const r = sharpenOdds(quotes);
    assert.equal(r.marketConsensus, "强共识");
  });
});

describe("line-movement-tracker", () => {
  it("rejects too few snapshots", () => {
    const r = analyzeLineMovement({ snapshots: [{ source: "A", timestamp: "2026-05-28T10:00Z", odds: { home: 2.0, draw: 3.5, away: 4.0 } }] });
    assert.equal(r.ok, false);
  });

  it("detects sharp money on home when home odds drop", () => {
    const r = analyzeLineMovement({
      fixtureId: "f1",
      snapshots: [
        { source: "A", timestamp: "2026-05-28T10:00Z", odds: { home: 2.10, draw: 3.5, away: 3.8 } },
        { source: "A", timestamp: "2026-05-28T20:00Z", odds: { home: 1.90, draw: 3.6, away: 4.0 } }
      ]
    });
    assert.equal(r.ok, true);
    assert.equal(r.movements.home.direction, "down");
    assert.ok(r.sharpOnOutcomes.includes("home"));
  });

  it("detects reverse line movement (favorite changes)", () => {
    // 开盘 home 是 favorite (1.80 最低),临场 away 反超成为 favorite (2.30 最低)
    const r = analyzeLineMovement({
      fixtureId: "f1",
      snapshots: [
        { source: "A", timestamp: "2026-05-28T10:00Z", odds: { home: 1.80, draw: 3.5, away: 4.5 } },
        { source: "A", timestamp: "2026-05-28T20:00Z", odds: { home: 3.00, draw: 3.4, away: 2.30 } }
      ]
    });
    assert.equal(r.reverseLineMove, true);
    assert.ok(r.interpretation.includes("反向"));
  });

  it("batchAnalyzeMovements ranks fixtures", () => {
    const fixtures = [
      {
        fixtureId: "f1",
        snapshots: [
          { timestamp: "2026-05-28T10:00Z", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
          { timestamp: "2026-05-28T20:00Z", odds: { home: 1.7, draw: 3.6, away: 5.0 } }
        ]
      },
      {
        fixtureId: "f2",
        snapshots: [
          { timestamp: "2026-05-28T10:00Z", odds: { home: 2.0, draw: 3.5, away: 4.0 } },
          { timestamp: "2026-05-28T20:00Z", odds: { home: 2.0, draw: 3.5, away: 4.0 } }
        ]
      }
    ];
    const r = batchAnalyzeMovements(fixtures);
    assert.equal(r.total, 2);
    assert.equal(r.topMoves[0].fixtureId, "f1");
  });
});

describe("form-momentum-features", () => {
  function buildMatches(n, gfFn, gaFn, dateFn) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        opponent: `X${i}`,
        isHome: i % 2 === 0,
        gf: gfFn(i),
        ga: gaFn(i),
        opponentRating: 1500,
        xgFor: 1.5,
        xgAgainst: 1.0,
        date: `2026-04-${String(i + 1).padStart(2, "0")}`
      });
    }
    return out;
  }

  it("rollingForm5 returns 0 for all-loss team", () => {
    const r = buildFormFeatures(buildMatches(10, () => 0, () => 2));
    assert.equal(r.rollingForm5, 0);
  });

  it("rollingForm5 returns 1 for all-win team", () => {
    const r = buildFormFeatures(buildMatches(10, () => 3, () => 0));
    assert.equal(r.rollingForm5, 1);
  });

  it("momentum detects rising form", () => {
    // 前 7 场都输,最后 3 场都赢
    const m = buildMatches(10, (i) => i < 7 ? 0 : 3, (i) => i < 7 ? 2 : 0);
    const r = buildFormFeatures(m);
    assert.ok(r.momentum > 0, `momentum=${r.momentum}`);
  });

  it("xgQuality > 1 when goals exceed xG", () => {
    const m = buildMatches(10, () => 2, () => 1);  // gf=2, xgFor=1.5 → quality > 1
    const r = buildFormFeatures(m);
    assert.ok(r.xgQuality > 1);
  });

  it("buildMatchupFeatures returns gap features", () => {
    const home = buildFormFeatures(buildMatches(10, () => 3, () => 0));
    const away = buildFormFeatures(buildMatches(10, () => 0, () => 3));
    const r = buildMatchupFeatures(home, away);
    assert.ok(r.formGap5 > 0);
    assert.ok(r.momentumGap !== null);
  });
});
