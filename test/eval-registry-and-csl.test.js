import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerMetric, getMetric, listMetrics, computeMetric, buildLeaderboard } from "../src/eval-metrics-registry.js";
import { extractFotmobLeagueMatches, extractFotmobStandings } from "../src/csl-loader.js";

describe("eval-metrics-registry", () => {
  it("has built-in metrics registered", () => {
    const list = listMetrics();
    assert.ok(list.includes("brier"));
    assert.ok(list.includes("logLoss"));
    assert.ok(list.includes("rps"));
    assert.ok(list.includes("hitRate"));
  });

  it("brier score sample correctness", () => {
    // Perfect prediction: brier = 0
    const perfect = computeMetric("brier", [{ probabilities: { "3": 1, "1": 0, "0": 0 }, actual: "3" }]);
    assert.equal(perfect, 0);
    // Worst prediction: 100% on wrong outcome
    const worst = computeMetric("brier", [{ probabilities: { "3": 1, "1": 0, "0": 0 }, actual: "0" }]);
    assert.equal(worst, 2);
  });

  it("rps respects ordering", () => {
    // Predict 100% draw, actual home: RPS should be > 0 but < 2
    const r = computeMetric("rps", [{ probabilities: { "3": 0, "1": 1, "0": 0 }, actual: "3" }]);
    assert.ok(r > 0 && r < 1, `rps=${r}`);
  });

  it("hitRate counts correctly", () => {
    const samples = [
      { probabilities: { "3": 0.6, "1": 0.2, "0": 0.2 }, actual: "3" },  // hit
      { probabilities: { "3": 0.3, "1": 0.4, "0": 0.3 }, actual: "1" },  // hit
      { probabilities: { "3": 0.7, "1": 0.2, "0": 0.1 }, actual: "0" }   // miss
    ];
    const rate = computeMetric("hitRate", samples);
    assert.ok(Math.abs(rate - 2/3) < 0.001);
  });

  it("registerMetric supports custom metric", () => {
    registerMetric("favoriteProb", {
      direction: "higher-is-better",
      description: "Mean probability of the predicted favorite",
      fn: (probs) => Math.max(probs["3"], probs["1"], probs["0"])
    });
    const r = computeMetric("favoriteProb", [
      { probabilities: { "3": 0.6, "1": 0.2, "0": 0.2 }, actual: "3" },
      { probabilities: { "3": 0.4, "1": 0.4, "0": 0.2 }, actual: "1" }
    ]);
    assert.ok(Math.abs(r - 0.5) < 0.001);
  });

  it("buildLeaderboard ranks methods correctly per metric", () => {
    const samples = {
      methodA: [
        { probabilities: { "3": 0.6, "1": 0.2, "0": 0.2 }, actual: "3" },
        { probabilities: { "3": 0.5, "1": 0.3, "0": 0.2 }, actual: "3" }
      ],
      methodB: [
        { probabilities: { "3": 0.4, "1": 0.4, "0": 0.2 }, actual: "3" },
        { probabilities: { "3": 0.3, "1": 0.4, "0": 0.3 }, actual: "3" }
      ]
    };
    const lb = buildLeaderboard(samples, ["brier", "hitRate"]);
    assert.ok(lb.leaderboard.methodA.brier < lb.leaderboard.methodB.brier);
    // A 比 B 命中更稳 → brier 排名第 1
    assert.equal(lb.ranking.brier[0].method, "methodA");
  });
});

describe("csl-loader fotmob extractors", () => {
  it("extracts matches from data.matches.allMatches", () => {
    const data = {
      matches: {
        allMatches: [
          {
            id: 100, home: { name: "上海海港", score: 2 }, away: { name: "山东泰山", score: 1 },
            status: { finished: true, utcTime: "2024-08-17T12:00:00Z" }
          }
        ]
      }
    };
    const out = extractFotmobLeagueMatches(data);
    assert.equal(out.length, 1);
    assert.equal(out[0].home, "上海海港");
    assert.equal(out[0].homeGoals, 2);
    assert.equal(out[0].league, "中超");
  });

  it("returns empty when no matches", () => {
    assert.deepEqual(extractFotmobLeagueMatches({}), []);
    assert.deepEqual(extractFotmobLeagueMatches(null), []);
  });

  it("extracts standings from data.table", () => {
    const data = {
      table: [{
        data: {
          table: {
            all: [
              { name: "上海海港", position: 1, played: 20, wins: 15, draws: 3, losses: 2, points: 48 }
            ]
          }
        }
      }]
    };
    const standings = extractFotmobStandings(data);
    assert.equal(standings.length, 1);
    assert.equal(standings[0].team, "上海海港");
    assert.equal(standings[0].points, 48);
  });
});
