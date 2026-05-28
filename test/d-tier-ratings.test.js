import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitMasseyRatings } from "../src/massey-ratings.js";
import { fitColleyRatings } from "../src/colley-ratings.js";
import { fitBivariatePoisson, bivariatePoissonMatrix } from "../src/bivariate-poisson.js";
import { buildEnsemblePrediction, adaptiveWeightsFromBacktest } from "../src/ratings-ensemble.js";
import { fitHierarchicalPoisson } from "../src/hierarchical-poisson.js";
import { extractEmbeddedJSON, unescapeHexString, normalizeUnderstatMatch, summarizeMatchXG } from "../src/understat-fetcher.js";

describe("Massey ratings", () => {
  it("rejects insufficient samples", () => {
    assert.equal(fitMasseyRatings([{ home: "A", away: "B", homeGoals: 1, awayGoals: 0 }]).ok, false);
  });

  it("strong team gets higher rating than weak team", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 });
      matches.push({ home: "Weak", away: "Strong", homeGoals: 0, awayGoals: 3 });
      matches.push({ home: "Mid", away: "Weak", homeGoals: 2, awayGoals: 1 });
      matches.push({ home: "Strong", away: "Mid", homeGoals: 2, awayGoals: 1 });
    }
    const r = fitMasseyRatings(matches);
    assert.equal(r.ok, true);
    const strong = r.teams["Strong"];
    const weak = r.teams["Weak"];
    assert.ok(strong > weak, `strong=${strong}, weak=${weak}`);
  });

  it("ratings sum to ~0 (constraint)", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ home: "A", away: "B", homeGoals: 2, awayGoals: 1 });
      matches.push({ home: "B", away: "C", homeGoals: 1, awayGoals: 1 });
      matches.push({ home: "C", away: "A", homeGoals: 0, awayGoals: 2 });
    }
    const r = fitMasseyRatings(matches);
    const sum = Object.values(r.teams).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum) < 0.01, `sum=${sum}`);
  });

  it("predictWinProb returns normalized probabilities", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 });
      matches.push({ home: "Weak", away: "Strong", homeGoals: 0, awayGoals: 2 });
    }
    const r = fitMasseyRatings(matches);
    const pred = r.predictWinProb("Strong", "Weak");
    assert.ok(Math.abs(pred.home + pred.draw + pred.away - 1) < 0.01);
    assert.ok(pred.home > pred.away);
  });
});

describe("Colley ratings", () => {
  it("strong team rating > 0.5, weak team rating < 0.5", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ home: "Strong", away: "Weak", homeGoals: 1, awayGoals: 0 });
      matches.push({ home: "Strong", away: "Mid", homeGoals: 2, awayGoals: 1 });
      matches.push({ home: "Mid", away: "Weak", homeGoals: 1, awayGoals: 0 });
    }
    const r = fitColleyRatings(matches);
    assert.equal(r.ok, true);
    assert.ok(r.teams["Strong"] > 0.5, `strong=${r.teams["Strong"]}`);
    assert.ok(r.teams["Weak"] < 0.5, `weak=${r.teams["Weak"]}`);
  });

  it("Colley ignores goal margin (7-0 same as 1-0)", () => {
    // 两组数据,差异只在进球差
    const close = [];
    const blowout = [];
    for (let i = 0; i < 12; i++) {
      close.push({ home: "A", away: "B", homeGoals: 1, awayGoals: 0 });
      blowout.push({ home: "A", away: "B", homeGoals: 7, awayGoals: 0 });
    }
    const r1 = fitColleyRatings(close);
    const r2 = fitColleyRatings(blowout);
    // Colley 应该几乎一致
    assert.ok(Math.abs(r1.teams["A"] - r2.teams["A"]) < 0.01,
              `Colley should ignore margin, got A close=${r1.teams["A"]} blowout=${r2.teams["A"]}`);
  });
});

describe("Bivariate Poisson", () => {
  it("rejects insufficient samples", () => {
    const r = fitBivariatePoisson([{ home: "A", away: "B", homeGoals: 1, awayGoals: 0 }]);
    assert.equal(r.ok, false);
    assert.equal(r.coldStart, true);
  });

  it("fits and predicts on synthetic dataset", () => {
    const matches = [];
    for (let i = 0; i < 50; i++) {
      matches.push({ home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 });
      matches.push({ home: "Weak", away: "Strong", homeGoals: 0, awayGoals: 2 });
      matches.push({ home: "Mid", away: "Weak", homeGoals: 1, awayGoals: 0 });
    }
    const r = fitBivariatePoisson(matches);
    assert.equal(r.ok, true);
    const pred = r.predict("Strong", "Weak");
    assert.ok(pred.probabilities.home > pred.probabilities.away, JSON.stringify(pred.probabilities));
    // 概率和 ~ 1
    const s = pred.probabilities.home + pred.probabilities.draw + pred.probabilities.away;
    assert.ok(Math.abs(s - 1) < 0.01, `sum=${s}`);
  });

  it("bivariatePoissonMatrix sums to 1", () => {
    const m = bivariatePoissonMatrix(1.4, 0.9, 0.2);
    let sum = 0;
    for (let h = 0; h < m.length; h++)
      for (let a = 0; a < m[h].length; a++) sum += m[h][a];
    assert.ok(Math.abs(sum - 1) < 0.001, `sum=${sum}`);
  });

  it("lambda3=0 case (independent Poisson) preserves marginals", () => {
    // 当 λ3=0,P(X=x, Y=y) = P(X=x) P(Y=y)
    const m = bivariatePoissonMatrix(1.5, 0.8, 0);
    // 边际 P(X=1) = sum_y P(X=1, Y=y) 应等于 Poisson(1, 1.5)
    let pX1 = 0;
    for (let y = 0; y < m[1].length; y++) pX1 += m[1][y];
    const expected = Math.exp(-1.5) * 1.5;
    assert.ok(Math.abs(pX1 - expected) < 0.01, `pX1=${pX1}, expected=${expected}`);
  });
});

describe("Ratings ensemble", () => {
  it("weighted average of multiple predictions sums to 1", () => {
    const preds = {
      elo: { home: 0.55, draw: 0.25, away: 0.20 },
      pi: { home: 0.50, draw: 0.30, away: 0.20 },
      massey: { home: 0.45, draw: 0.30, away: 0.25 },
      dixonColes: { home: 0.52, draw: 0.28, away: 0.20 }
    };
    const result = buildEnsemblePrediction(preds);
    assert.equal(result.ok, true);
    const s = result.probabilities.home + result.probabilities.draw + result.probabilities.away;
    assert.ok(Math.abs(s - 1) < 0.01);
    // home should still dominate
    assert.ok(result.probabilities.home > result.probabilities.away);
  });

  it("ignores null predictions", () => {
    const preds = {
      elo: { home: 0.55, draw: 0.25, away: 0.20 },
      pi: null,
      massey: { home: "not-a-number", draw: 1, away: 1 }
    };
    const r = buildEnsemblePrediction(preds);
    assert.equal(r.ok, true);
    assert.ok(r.contributions.elo);
    assert.ok(!r.contributions.pi);
  });

  it("falls back to safe default when no valid predictions", () => {
    const r = buildEnsemblePrediction({ a: null, b: undefined });
    assert.equal(r.ok, false);
    assert.equal(r.probabilities.home, 1/3);
  });

  it("adaptive weights inverse-RPS:method with lower RPS gets higher weight", () => {
    const w = adaptiveWeightsFromBacktest([
      { method: "elo", rps: 0.22, samples: 100 },
      { method: "pi", rps: 0.20, samples: 100 },
      { method: "massey", rps: 0.24, samples: 100 }
    ]);
    assert.ok(w.pi > w.elo);
    assert.ok(w.elo > w.massey);
  });
});

describe("Hierarchical Poisson", () => {
  it("returns global prior when no matches", () => {
    const r = fitHierarchicalPoisson([]);
    assert.equal(r.ok, false);
    assert.equal(r.global.baseRate, 1.35);
  });

  it("estimates per-league baseRate with shrinkage", () => {
    // 英超 200 场进球率高;国际友谊赛 5 场进球率低
    const matches = [];
    for (let i = 0; i < 200; i++) {
      matches.push({ home: "X", away: "Y", homeGoals: 2, awayGoals: 1, league: "英超" });
    }
    for (let i = 0; i < 5; i++) {
      matches.push({ home: "A", away: "B", homeGoals: 1, awayGoals: 0, league: "友谊赛" });
    }
    const r = fitHierarchicalPoisson(matches);
    assert.equal(r.ok, true);
    // 英超 baseRate 接近 1.5(原始);友谊赛 shrink 强(往全局拉)
    const epl = r.leagues["英超"];
    const fri = r.leagues["友谊赛"];
    assert.ok(epl.reliable === true);
    assert.ok(fri.reliable === false);
    assert.ok(fri.shrinkFactor < epl.shrinkFactor);
    // 友谊赛 baseRate 介于原始 0.5 和全局之间
    assert.ok(fri.baseRate > fri.rawBaseRate);
  });

  it("getLeagueParams returns global for unknown league", () => {
    const r = fitHierarchicalPoisson([
      { home: "A", away: "B", homeGoals: 2, awayGoals: 1, league: "英超" }
    ]);
    const lp = r.getLeagueParams("未知联赛");
    assert.equal(lp.fromGlobal, true);
    assert.equal(lp.samples, 0);
  });

  it("predictGoals combines league params with team strengths", () => {
    const matches = [];
    for (let i = 0; i < 100; i++) {
      matches.push({ home: "A", away: "B", homeGoals: 2, awayGoals: 1, league: "英超" });
    }
    const r = fitHierarchicalPoisson(matches);
    const pred = r.predictGoals("英超", { homeAttack: 1.2, homeDefense: 0.8, awayAttack: 0.9, awayDefense: 1.1 });
    assert.ok(pred.lambdaHome > 0);
    assert.ok(pred.lambdaAway > 0);
    // 主队强攻+客队弱守 → 主队期望进球更高
    assert.ok(pred.lambdaHome > pred.lambdaAway);
  });
});

describe("Understat fetcher utilities", () => {
  it("unescapeHexString decodes \\xNN sequences", () => {
    assert.equal(unescapeHexString("\\x7B\\x22a\\x22\\x3A1\\x7D"), '{"a":1}');
    assert.equal(unescapeHexString("plain"), "plain");
  });

  it("extractEmbeddedJSON parses JSON.parse('...') pattern", () => {
    const html = `<script>var datesData = JSON.parse('\\x5B\\x7B\\x22a\\x22\\x3A1\\x7D\\x5D');</script>`;
    const data = extractEmbeddedJSON(html, "datesData");
    assert.deepEqual(data, [{ a: 1 }]);
  });

  it("extractEmbeddedJSON returns null when var not found", () => {
    assert.equal(extractEmbeddedJSON("<html>no script</html>", "datesData"), null);
  });

  it("normalizeUnderstatMatch flattens nested team and goals", () => {
    const raw = {
      id: "12345",
      datetime: "2024-08-17 14:00:00",
      h: { title: "Liverpool" },
      a: { title: "Ipswich" },
      goals: { h: "2", a: "0" },
      xG: { h: "1.85", a: "0.42" }
    };
    const out = normalizeUnderstatMatch(raw, "EPL", 2024);
    assert.equal(out.home, "Liverpool");
    assert.equal(out.away, "Ipswich");
    assert.equal(out.homeGoals, 2);
    assert.equal(out.homeXg, 1.85);
    assert.equal(out.isResult, true);
  });

  it("summarizeMatchXG aggregates shots", () => {
    const shots = {
      h: [{ xG: "0.3", result: "Goal" }, { xG: "0.1", result: "MissedShots" }, { xG: "0.45", result: "SavedShot" }],
      a: [{ xG: "0.5", result: "BlockedShot" }, { xG: "0.2", result: "Goal" }]
    };
    const sum = summarizeMatchXG(shots);
    assert.equal(sum.homeShots, 3);
    assert.equal(sum.awayShots, 2);
    assert.ok(Math.abs(sum.homeXG - 0.85) < 0.001);
    assert.ok(Math.abs(sum.awayXG - 0.7) < 0.001);
    // SOT = Goal + SavedShot
    assert.equal(sum.homeShotsOnTarget, 2);
    assert.equal(sum.awayShotsOnTarget, 1);
  });
});
