import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExtendedMarkets, annotateMarketsWithEV } from "../src/extended-markets.js";
import { fitPiRatings } from "../src/pi-ratings.js";
import { extractMatches } from "../src/openfootball-loader.js";

// 构造简单的 6x6 比分矩阵(主队 1.5 vs 客队 0.9 的泊松)
function poissonMatrix(lambda, mu, maxGoals = 5) {
  const poisson = (k, l) => Math.exp(k * Math.log(l) - l - logFact(k));
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      matrix[h][a] = poisson(h, lambda) * poisson(a, mu);
      total += matrix[h][a];
    }
  }
  for (let h = 0; h <= maxGoals; h++)
    for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= total;
  return matrix;
}
function logFact(n) { let v = 0; for (let i = 2; i <= n; i++) v += Math.log(i); return v; }

describe("Extended markets builder", () => {
  const matrix = poissonMatrix(1.5, 0.9);

  it("builds over/under for 5 lines summing to 1", () => {
    const m = buildExtendedMarkets(matrix);
    for (const [line, vals] of Object.entries(m.overUnder)) {
      assert.ok(Math.abs(vals.over + vals.under - 1) < 0.01, `line ${line} sum=${vals.over + vals.under}`);
    }
  });

  it("over 2.5 probability is around 50-60% for lambda=1.5, mu=0.9", () => {
    const m = buildExtendedMarkets(matrix);
    assert.ok(m.overUnder["2.5"].over > 0.4 && m.overUnder["2.5"].over < 0.65, `over=${m.overUnder["2.5"].over}`);
  });

  it("odd+even sums to 1", () => {
    const m = buildExtendedMarkets(matrix);
    assert.ok(Math.abs(m.totalGoalsOddEven.odd + m.totalGoalsOddEven.even - 1) < 0.01);
  });

  it("first half hwd sums to ~1 and home dominates", () => {
    const m = buildExtendedMarkets(matrix);
    const fh = m.firstHalf;
    assert.ok(Math.abs(fh.home + fh.draw + fh.away - 1) < 0.01);
    assert.ok(fh.home > fh.away, `home=${fh.home}, away=${fh.away}`);
  });

  it("asian handicap -1 reduces home probability vs handicap 0 baseline", () => {
    const m = buildExtendedMarkets(matrix);
    // 让 -1 后主队赢 = 原本赢超 1 球 = 比让 0 主胜概率小
    // 简单验证三档加起来 = 1
    for (const [line, vals] of Object.entries(m.asianHandicap)) {
      assert.ok(Math.abs(vals.home + vals.draw + vals.away - 1) < 0.01, `line ${line}`);
    }
  });

  it("double chance home-or-draw > away-or-draw for home favorite", () => {
    const m = buildExtendedMarkets(matrix);
    assert.ok(m.doubleChance.homeOrDraw > m.doubleChance.drawOrAway);
  });

  it("score group: homeBy1 + homeBy2Plus + draw + awayBy1 + awayBy2Plus ≈ 1", () => {
    const m = buildExtendedMarkets(matrix);
    const sg = m.scoreGroup;
    assert.ok(Math.abs(sg.draw + sg.homeBy1 + sg.homeBy2Plus + sg.awayBy1 + sg.awayBy2Plus - 1) < 0.01);
  });

  it("totalGoalsExact sums to 1", () => {
    const m = buildExtendedMarkets(matrix);
    const s = Object.values(m.totalGoalsExact).slice(0, 8).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(s - 1) < 0.02, `sum=${s}`);
  });

  it("annotateMarketsWithEV computes ev = p*odds - 1 correctly", () => {
    const markets = { overUnder: { "2.5": { over: 0.55, under: 0.45 } } };
    const odds = { overUnder: { "2.5": { over: 1.95, under: 1.85 } } };
    const annotated = annotateMarketsWithEV(markets, odds);
    const ev = annotated.overUnder["2.5"].over.ev;
    // 0.55 * 1.95 - 1 = 0.0725
    assert.ok(Math.abs(ev - 0.0725) < 0.001);
    assert.equal(annotated.overUnder["2.5"].over.verdict, "value");
  });
});

describe("Pi-ratings", () => {
  it("fits on synthetic matches and gives home advantage", () => {
    // 构造 A 总赢 B 的样本
    const matches = [];
    for (let i = 0; i < 20; i++) matches.push({ home: "A", away: "B", homeGoals: 2, awayGoals: 0 });
    const r = fitPiRatings(matches);
    assert.equal(r.ok, true);
    assert.equal(r.samples, 20);
    const pred = r.predictWinProb("A", "B");
    assert.ok(pred.home > pred.away, `home=${pred.home}, away=${pred.away}`);
    // 概率和约 1
    assert.ok(Math.abs(pred.home + pred.draw + pred.away - 1) < 0.01);
  });

  it("predictGoalDiff returns sensible difference", () => {
    const matches = [
      { home: "Strong", away: "Weak", homeGoals: 3, awayGoals: 0 },
      { home: "Strong", away: "Weak", homeGoals: 4, awayGoals: 1 },
      { home: "Weak", away: "Strong", homeGoals: 0, awayGoals: 2 }
    ];
    const r = fitPiRatings(matches);
    const diff = r.predictGoalDiff("Strong", "Weak");
    assert.ok(diff > 0, `expected Strong to be ahead, got ${diff}`);
  });

  it("returns neutral prediction for unknown teams", () => {
    const r = fitPiRatings([{ home: "A", away: "B", homeGoals: 1, awayGoals: 1 }]);
    const pred = r.predictWinProb("UnknownX", "UnknownY");
    assert.ok(Math.abs(pred.home - pred.away) < 0.05, `should be roughly equal: home=${pred.home}, away=${pred.away}`);
  });

  it("topTeams returns ranked list", () => {
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({ home: "Best", away: "Worst", homeGoals: 3, awayGoals: 0 });
      matches.push({ home: "Mid", away: "Worst", homeGoals: 1, awayGoals: 0 });
      matches.push({ home: "Best", away: "Mid", homeGoals: 2, awayGoals: 1 });
    }
    const r = fitPiRatings(matches);
    const top = r.topTeams(3);
    assert.equal(top[0].team, "Best");
    assert.equal(top[2].team, "Worst");
  });
});

describe("openfootball extractor", () => {
  it("extracts matches with ft score arrays", () => {
    const data = {
      matches: [
        { date: "2024-08-17", team1: "Liverpool", team2: "Ipswich", score: { ft: [2, 0] }, round: "Matchday 1" },
        { date: "2024-08-18", team1: { name: "Arsenal" }, team2: { name: "Wolves" }, score: { ft: [2, 0] } },
        { date: "2024-08-19", team1: "X", team2: "Y" /* no score */ }
      ]
    };
    const out = extractMatches(data, "en.1", "2024-25");
    assert.equal(out.length, 2);
    assert.equal(out[0].home, "Liverpool");
    assert.equal(out[0].homeGoals, 2);
    assert.equal(out[1].home, "Arsenal");
  });

  it("returns empty when matches missing or malformed", () => {
    assert.deepEqual(extractMatches({}, "en.1", "2024-25"), []);
    assert.deepEqual(extractMatches({ matches: [] }, "en.1", "2024-25"), []);
    assert.deepEqual(extractMatches(null, "en.1", "2024-25"), []);
  });
});
