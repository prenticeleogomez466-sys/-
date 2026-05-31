import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMonteCarloSimulation, lambdaTotalFromMarket } from "../src/monte-carlo-simulator.js";

const fx = { id: "t1", kickoff: "2026-05-31", homeTeam: "A", awayTeam: "B" };
const balanced = { home: 0.4, draw: 0.3, away: 0.3 };

test("lambdaTotalFromMarket:两路赔率反解 λ_total(over2.5≈0.5 → λ≈2.67)", () => {
  const r = lambdaTotalFromMarket({ line: 2.5, overProb: 0.5 });
  assert.equal(r.source, "over-prob");
  assert.ok(r.lambdaTotal > 2.55 && r.lambdaTotal < 2.8, `λ_total=${r.lambdaTotal} 应≈2.67`);
  // over 概率越高 → λ_total 越大(单调)
  const hi = lambdaTotalFromMarket({ line: 2.5, overProb: 0.65 });
  assert.ok(hi.lambdaTotal > r.lambdaTotal, "over 概率高则总量大");
});

test("lambdaTotalFromMarket:只有线 → line-proxy 降级", () => {
  const r = lambdaTotalFromMarket({ line: 3.0, overProb: null });
  assert.equal(r.source, "line-proxy");
  assert.equal(r.lambdaTotal, 3.0);
});

test("lambdaTotalFromMarket:无有效盘口 → null", () => {
  assert.equal(lambdaTotalFromMarket(null), null);
  assert.equal(lambdaTotalFromMarket({ line: null, overProb: null }), null);
});

test("estimateGoalLambdas 经 buildMonteCarloSimulation 用 O/U 校准 λ,总量≈盘口解", () => {
  const mt = lambdaTotalFromMarket({ line: 2.5, overProb: 0.62 }); // λ_total≈2.9
  const sim = buildMonteCarloSimulation(fx, balanced, { iterations: 1000, marketTotal: mt });
  assert.match(sim.lambdas.source, /over-under-calibrated/);
  const total = sim.lambdas.home + sim.lambdas.away;
  assert.ok(Math.abs(total - mt.lambdaTotal) < 0.05, `λ和=${total} 应≈${mt.lambdaTotal}`);
});

test("proxy xG 不遮蔽 O/U 校准(real xG 才优先)", () => {
  const mt = lambdaTotalFromMarket({ line: 2.5, overProb: 0.55 });
  const proxyXg = { home: { xg: 1.5, source: "market-implied-xg-proxy" }, away: { xg: 1.1, source: "market-implied-xg-proxy" } };
  const sim = buildMonteCarloSimulation(fx, balanced, { iterations: 500, xg: proxyXg, marketTotal: mt });
  assert.match(sim.lambdas.source, /over-under-calibrated/, "proxy xG 应被跳过,用 O/U");
  // 真 xG(非 proxy)则优先
  const realXg = { home: { xg: 2.0, source: "understat" }, away: { xg: 0.8, source: "understat" } };
  const sim2 = buildMonteCarloSimulation(fx, balanced, { iterations: 500, xg: realXg, marketTotal: mt });
  assert.equal(sim2.lambdas.source, "xg", "真 xG 优先于 O/U");
});

test("无 O/U 盘口 → 降级(不报错,source 非 over-under)", () => {
  const sim = buildMonteCarloSimulation(fx, balanced, { iterations: 500 });
  assert.doesNotMatch(sim.lambdas.source, /over-under/);
});
